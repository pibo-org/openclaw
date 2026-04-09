#!/usr/bin/env node
/**
 * pibo-docs-notifier.js — Lightweight HTTP server that receives "bare repo updated"
 * notifications and triggers an immediate git pull in ~/docs/.
 *
 * Usage: node pibo-docs-notifier.js [port]
 * Default port: 3472
 *
 * Security: Requires a shared secret token in the Authorization header.
 * The token is stored in ~/docs/.notify-token (created automatically).
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.argv[2] || '3472', 10);
const DOCS_DIR = process.env.HOME + '/docs';
const TOKEN_FILE = path.join(DOCS_DIR, '.notify-token');
const TOKEN = (() => {
  // Create a random token if one doesn't exist yet
  if (!fs.existsSync(TOKEN_FILE)) {
    const token = randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    console.log(`[notifier] Generated new auth token: ${TOKEN_FILE}`);
    return token;
  }
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
})();

let pulling = false;
let pendingPull = false;

async function doPull() {
  if (pulling) return;
  pulling = true;
  try {
    const { stdout, stderr } = await execFileAsync('bash', [
      process.env.HOME + '/docs-sync/pibo-pull.sh',
    ], {
      cwd: DOCS_DIR,
      timeout: 30_000,
    });
    if (stdout.trim()) {
      console.log(`[notifier] Pull output: ${stdout.trim()}`);
    }
    console.log(`[notifier] ✓ Pull completed at ${new Date().toISOString()}`);
  } catch (err) {
    console.error(`[notifier] ✗ Pull failed: ${err.stderr?.trim() || err.message}`);
  } finally {
    pulling = false;
    if (pendingPull) {
      pendingPull = false;
      console.log('[notifier] Pending pull detected — pulling now');
      doPull();
    }
  }
}

const server = http.createServer((req, res) => {
  // Only accept POST to /notify with correct auth
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end('Unauthorized');
    return;
  }

  // Trigger immediate pull
  if (pulling) {
    pendingPull = true;
    res.writeHead(202).end('Pull already in progress, queued');
  } else {
    doPull();
    res.writeHead(200).end('Pull triggered');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[notifier] Listening on 127.0.0.1:${PORT}`);
  console.log(`[notifier] Token stored in: ${TOKEN_FILE}`);
  console.log(`[notifier] To test: curl -X POST -H "Authorization: Bearer $(cat ~/docs/.notify-token)" http://127.0.0.1:${PORT}/notify`);
});

process.on('SIGTERM', () => {
  console.log('[notifier] Shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[notifier] Shutting down...');
  server.close(() => process.exit(0));
});
