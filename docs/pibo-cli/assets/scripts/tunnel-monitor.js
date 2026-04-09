#!/usr/bin/env node
/**
 * pibo-docs-tunnel-monitor.js — Monitors the SSH reverse tunnel health
 * and restarts it if it becomes unresponsive.
 *
 * Why: systemd only knows if the SSH process is alive, not if the
 *     tunnel actually works. This script periodically pings the tunnel
 *     from the server side and restarts SSH if it doesn't respond.
 *
 * Usage: node pibo-docs-tunnel-monitor.js
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TUNNEL_SERVICE = 'pibo-docs-tunnel.service';
const CHECK_INTERVAL = 15_000; // 15 seconds
const CONSECUTIVE_FAILURES_NEEDED = 2; // need 2 failures before restarting
let consecutiveFailures = 0;
let restarting = false;

async function checkTunnel() {
  if (restarting) return;

  try {
    // Try to curl localhost:3472 from our own machine
    // If the SSH -R tunnel is working, this port should be bound
    const { stdout } = await execFileAsync('ss', ['-tlnp', 'sport', ':3472']);
    if (stdout.includes('3472')) {
      // Port is listening — but is it functional?
      // Quick test: try to connect
      const { code } = await execFileAsync(
        'curl', ['-s', '-m', '2', '-X', 'POST',
          '-H', `Authorization: Bearer ${await getToken()}`,
          'http://127.0.0.1:3472/notify'
        ]
      );
      if (code !== 0) {
        throw new Error(`curl failed with exit code ${code}`);
      }
      consecutiveFailures = 0;
      return true;
    }
    throw new Error('Port 3472 not listening');
  } catch (err) {
    consecutiveFailures++;
    console.log(`[${new Date().toLocaleTimeString()}] Tunnel check failed (${consecutiveFailures}/${CONSECUTIVE_FAILURES_NEEDED}): ${err.message}`);

    if (consecutiveFailures >= CONSECUTIVE_FAILURES_NEEDED) {
      console.log(`[${new Date().toLocaleTimeString()}] Restarting tunnel service...`);
      restarting = true;
      try {
        await execFileAsync('systemctl', ['--user', 'restart', TUNNEL_SERVICE]);
        console.log(`[${new Date().toLocaleTimeString()}] Tunnel restarted`);
        // Wait for it to come up
        await new Promise(resolve => setTimeout(resolve, 3000));
        consecutiveFailures = 0;
      } catch (restartErr) {
        console.log(`[${new Date().toLocaleTimeString()}] Restart failed: ${restartErr.message}`);
      } finally {
        restarting = false;
      }
    }
    return false;
  }
}

let token;
async function getToken() {
  if (!token) {
    const { stdout } = await execFileAsync('cat', [`${process.env.HOME}/docs/.notify-token`]);
    token = stdout.trim();
  }
  return token;
}

console.log(`[${new Date().toLocaleTimeString()}] Tunnel monitor started — checking every ${CHECK_INTERVAL/1000}s`);

// Check immediately, then on interval
checkTunnel();
setInterval(checkTunnel, CHECK_INTERVAL);
