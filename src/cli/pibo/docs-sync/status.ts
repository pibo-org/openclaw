import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { bold, ok, fail, warn, info, run, commandExists, serviceRunning, sshCheck } from "./utils.js";
import { readConfig } from "./config.js";

export function showStatus() {
  const piboCfg = readConfig("pibo");
  const serverCfg = readConfig("server");

  console.log(bold("\n📚 Docs Sync Status"));
  console.log("═".repeat(50));

  // PIBo Machine
  console.log(bold("\nPIBo Machine:"));
  const home = homedir();

  // Notifier
  const notifierRunning = serviceRunning("pibo-docs-notifier.service", true);
  console.log(notifierRunning ? ok("Notifier: running") : fail("Notifier: NOT running"));

  // Watcher
  const watcherRunning = serviceRunning("pibo-docs-watcher.service", true);
  console.log(watcherRunning ? ok("Watcher: running") : fail("Watcher: NOT running"));

  // Tunnel
  const tunnelRunning = serviceRunning("pibo-docs-tunnel.service", true);
  console.log(tunnelRunning ? ok("Tunnel: connected") : fail("Tunnel: NOT connected (needed)"));

  // ~/docs/
  const docsPath = piboCfg?.pibo.docsPath || join(home, "docs");
  if (existsSync(docsPath)) {
    const files = run(`find ${docsPath} -name "*.md" | wc -l`) || "?";
    const lastCommit = run(`cd ${docsPath} && git log -1 --format="%s (%cr)" 2>/dev/null`) || "?";
    console.log(ok(`~/docs/: ${files} files, last: ${lastCommit}`));
  } else {
    console.log(fail(`~/docs/: not found at ${docsPath}`));
  }

  // Server status (via SSH)
  console.log(bold("\nServer:"));
  if (piboCfg) {
    const serverIp = piboCfg.server.ip;
    // Check SSH
    const sshOk = sshCheck(serverIp, piboCfg.server.user, piboCfg.server.sshKeyPath);
    if (sshOk) {
      // Server Watcher
      const watcherOutput = run(`ssh -i ${piboCfg.server.sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${piboCfg.server.user}@${serverIp} "systemctl is-active pibo-docs-server-watcher.service 2>/dev/null || echo inactive"`);
      console.log(watcherOutput === "active" ? ok("Server Watcher: running") : fail("Server Watcher: NOT running"));

      // Cron
      const cronOutput = run(`ssh -i ${piboCfg.server.sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${piboCfg.server.user}@${serverIp} "crontab -l 2>/dev/null | grep pibo-docs-sync"`);
      console.log(cronOutput ? ok("Cron: registered") : warn("Cron: NOT found"));

      // Bare Repo
      const bareOk = run(`ssh -i ${piboCfg.server.sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${piboCfg.server.user}@${serverIp} "git -C /var/docs-remote rev-parse HEAD 2>/dev/null"`);
      console.log(bareOk ? ok(`Bare Repo: OK (${bareOk.slice(0, 7)})`) : fail("Bare Repo: not found"));

      // GitHub Backup
      const githubOk = run(`ssh -i ${piboCfg.server.sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${piboCfg.server.user}@${serverIp} "git -C /var/lib/pibo-webapp/storage/docs log --oneline -1 2>/dev/null | head -c 7"`);
      console.log(githubOk ? ok("GitHub Backup: reachable") : warn("GitHub Backup: unknown"));
    } else {
      console.log(fail("SSH to Server: FAILED"));
    }
  } else {
    console.log(warn("No PIBo config found — run 'openclaw pibo docs-sync setup'"));
  }

  console.log("\n");
}
