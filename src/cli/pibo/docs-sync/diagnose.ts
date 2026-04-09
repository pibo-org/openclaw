import { bold, ok, fail, warn, info, run } from "./utils.js";
import { readConfig } from "./config.js";

export function runDiagnose() {
  const piboCfg = readConfig("pibo");
  const home = process.env.HOME || "/home/pibo";

  console.log(bold("\n🔍 Docs Sync Diagnose"));
  console.log("═".repeat(50));

  let issues: string[] = [];

  // System checks
  console.log("\nSystem:");
  const nodeVer = run("node --version");
  console.log(nodeVer ? ok(`Node.js: ${nodeVer}`) : fail("Node.js: NOT FOUND"));
  if (!nodeVer) issues.push("Node.js fehlt");

  const gitOk = run("git --version");
  console.log(gitOk ? ok(`git: ${gitOk}`) : fail("git: NOT FOUND"));
  if (!gitOk) issues.push("git fehlt");

  // PIBo Services
  console.log("\nPIBo Services:");
  const services = [
    "pibo-docs-notifier.service",
    "pibo-docs-watcher.service",
    "pibo-docs-tunnel.service",
  ];
  for (const svc of services) {
    const status = run(`systemctl --user is-active ${svc} 2>/dev/null`);
    if (status === "active") {
      console.log(ok(`${svc}: running`));
    } else if (status && status.includes("inactive")) {
      console.log(warn(`${svc}: inactive — systemctl --user start ${svc}`));
      issues.push(`${svc} ist gestoppt`);
    } else {
      console.log(fail(`${svc}: NOT FOUND`));
      issues.push(`${svc} existiert nicht`);
    }
  }

  // ~/docs/
  console.log("\nDocs Repo:");
  const docsPath = piboCfg?.pibo.docsPath || `${home}/docs`;
  const docsOk = run(`git -C ${docsPath} rev-parse --git-dir 2>/dev/null`);
  console.log(docsOk ? ok(`~/docs/: valid git repo`) : fail(`~/docs/: NOT a git repo`));
  if (docsOk) {
    const commits = run(`cd ${docsPath} && git log --oneline -5 2>/dev/null`) || "";
    console.log(info("Letzte Commits:"));
    commits.split("\n").forEach(line => console.log(`  ${line}`));
  }
  if (!docsOk) issues.push("~/docs/ ist kein git Repo");

  // SSH Tunnel
  console.log("\nSSH Tunnel:");
  if (piboCfg) {
    const tunnelOk = run(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${piboCfg.pibo.notifyPort}/notify --connect-timeout 3 2>/dev/null`);
    console.log(tunnelOk ? ok(`Tunnel/Notifier erreichbar (Port ${piboCfg.pibo.notifyPort})`) : warn(`Notifier auf Port ${piboCfg.pibo.notifyPort}: nicht erreichbar`));
    if (tunnelOk !== "200" && tunnelOk !== "405") issues.push("Notifier nicht erreichbar (Tunnel oder Service gestoppt)");
  } else {
    console.log(warn("Keine Config — keine Tunnel-Prüfung möglich"));
    issues.push("Keine Config gefunden");
  }

  // Server Connectivity
  console.log("\nServer Verbindung:");
  if (piboCfg) {
    const sshOk = run(`ssh -i ${piboCfg.server.sshKeyPath || `${home}/.ssh/id_ed25519`} -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ${piboCfg.server.user}@${piboCfg.server.ip} "echo ok" 2>/dev/null`);
    console.log(sshOk === "ok" ? ok("SSH zum Server: OK") : fail("SSH zum Server: FEHLGESCHLAGEN"));
    if (sshOk !== "ok") issues.push("SSH-Verbindung zum Server fehlgeschlagen");

    // Bare Repo
    const bareOk = run(`ssh -i ${piboCfg.server.sshKeyPath || `${home}/.ssh/id_ed25519`} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${piboCfg.server.user}@${piboCfg.server.ip} "test -d /var/docs-remote && echo ok" 2>/dev/null`);
    console.log(bareOk === "ok" ? ok("Bare Repo: /var/docs-remote") : warn("Bare Repo: nicht gefunden"));
    if (bareOk !== "ok") issues.push("Bare Repo auf Server fehlt");
  }

  // Summary
  console.log("\n" + "═".repeat(50));
  if (issues.length === 0) {
    console.log(bold("\n✅ Alles sieht gut aus!"));
    console.log(info("Test-Sync: pibo docs-sync test"));
  } else {
    console.log(bold(`\n${issues.length} Problem(e) gefunden:`));
    issues.forEach((issue, i) => console.log(`  ${i + 1}. ${fail(issue)}`));
    console.log(`\n${info("Lösung: Behebe die obigen Punkte und führe 'pibo docs-sync doctor' erneut aus.")}`);
  }
  console.log("\n");
}
