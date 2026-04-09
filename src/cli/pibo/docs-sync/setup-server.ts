import { unlinkSync } from "fs";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { bold, ok, fail, warn, info, run, commandExists, generateToken, nodeBin } from "./utils.js";
import { DocsSyncConfig, readConfig, writeConfig, defaultConfig } from "./config.js";

// ESM path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ASSETS_DIR = fileURLToPath(new URL("../../../../docs/pibo-cli/assets/", import.meta.url));

/** SCP a file with proper error handling */
async function scpFile(keyPath: string, user: string, host: string, localPath: string, remotePath: string): Promise<boolean> {
  const cmd = `scp -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${localPath} ${user}@${host}:${remotePath}`;
  try {
    execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (e: any) {
    const stderr = e.stderr?.toString()?.trim() || "unknown error";
    console.log(fail(`SCP fehlgeschlagen: ${localPath} → ${host}:${remotePath}`));
    console.log(warn(`Error: ${stderr}`));
    return false;
  }
}

/** Execute SSH command with proper error handling */
async function sshExec(keyPath: string, user: string, host: string, remoteCmd: string, label: string): Promise<boolean> {
  const cmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes ${user}@${host} ${JSON.stringify(remoteCmd)}`;
  try {
    execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (e: any) {
    const stderr = e.stderr?.toString()?.trim() || "unknown error";
    console.log(fail(`${label} fehlgeschlagen`));
    console.log(warn(`Error: ${stderr}`));
    return false;
  }
}

export async function setupServer(interactive: boolean) {
  console.log(bold("\n🖥️ Server Setup"));
  console.log("═".repeat(50));

  const home = homedir();

  // Load or create config
  let cfg = readConfig("server") || readConfig("pibo");
  if (!cfg) {
    cfg = defaultConfig() as DocsSyncConfig;
    cfg.role = "server";
  }

  // Pre-flight checks
  console.log("\n" + bold("Prüfe Voraussetzungen..."));

  if (!commandExists("ssh")) {
    console.log(fail("SSH fehlt"));
    console.log(info("Installiere: sudo apt install openssh-client"));
    return;
  }
  console.log(ok("SSH vorhanden"));

  if (!commandExists("systemctl")) {
    console.log(fail("systemctl fehlt — kein systemd?"));
    return;
  }
  console.log(ok("systemctl vorhanden"));

  if (!cfg.server.ip) {
    console.log(fail("Server-IP nicht konfiguriert"));
    if (interactive) {
      console.log(info("Führe 'pibo docs-sync setup-wizard' aus und gib die Server-IP ein."));
    }
    return;
  }

  const sshKey = cfg.server.sshKeyPath || join(home, ".ssh", "id_ed25519");
  const serverIp = cfg.server.ip;
  const serverUser = cfg.server.user || "root";

  // Test SSH to server
  console.log(info(`Teste SSH-Verbindung zu ${serverUser}@${serverIp}...`));
  let connected = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await sshExec(sshKey, serverUser, serverIp, "echo ok", "SSH-Verbindung")) {
      connected = true;
      break;
    }
    if (attempt < 3) {
      console.log(info(`Versuch ${attempt} fehlgeschlagen, retry in 3s...`));
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!connected) {
    console.log(fail("SSH-Verbindung zum Server fehlgeschlagen nach 3 Versuchen"));
    console.log(info("Prüfe:"));
    console.log(info(`  1. Server erreichbar? (ping ${serverIp})`));
    console.log(info(`  2. SSH-Key auf Server installiert? (ssh-copy-id ${serverUser}@${serverIp})`));
    return;
  }

  // Check / create bare repo
  console.log(info("Prüfe Bare Repo auf Server..."));
  const bareExists = await sshExec(sshKey, serverUser, serverIp, "test -d /var/docs-remote", "Bare Repo Check");
  if (!bareExists) {
    console.log(info("Erstelle Bare Repo /var/docs-remote..."));
    const created = await sshExec(sshKey, serverUser, serverIp, "mkdir -p /var/docs-remote && git init --bare /var/docs-remote", "Bare Repo erstellen");
    if (!created) {
      console.log(fail("Bare Repo konnte nicht erstellt werden. Setup abgebrochen."));
      return;
    }
    console.log(ok("Bare Repo erstellt: /var/docs-remote"));
  } else {
    console.log(ok("Bare Repo existiert: /var/docs-remote"));
  }

  // Check storage docs dir
  console.log(info("Prüfe Storage Docs Verzeichnis..."));
  const storageExists = await sshExec(sshKey, serverUser, serverIp, `test -d ${cfg.server.remoteDocsPath}`, "Storage Docs Check");
  if (!storageExists) {
    console.log(fail(`Storage Docs Verzeichnis nicht gefunden: ${cfg.server.remoteDocsPath}`));
    console.log(info("Die WebApp muss installiert sein für Docs-Sync."));
    console.log(info("Standard-Pfad: /var/lib/pibo-webapp/storage/docs"));
    console.log(info("Alternativ: Config anpassen mit pibo docs-sync config edit"));
    return;
  }
  console.log(ok(`Storage Docs: ${cfg.server.remoteDocsPath}`));

  // Generate or read token
  let token = cfg.server.notifyToken || cfg.pibo.notifyToken;
  if (!token) {
    token = generateToken();
    cfg.server.notifyToken = token;
    cfg.pibo.notifyToken = token;
    console.log(info(`Neues Notify-Token generiert`));
  }
  console.log(ok("Notify-Token bereit"));

  // Create parent dirs on server for files we'll copy
  await sshExec(sshKey, serverUser, serverIp, "mkdir -p /root/bin", "Remote dir create");

  // === Copy files to server ===
  console.log("\n" + bold("Installiere Dateien auf Server..."));

  // Save token locally
  const tokenHome = join(home, ".pibo-docs-sync-token");
  writeFileSync(tokenHome, token);
  chmodSync(tokenHome, 0o600);
  console.log(ok(`Token lokal gespeichert: ${tokenHome}`));

  // Copy token to server
  console.log(info("Kopiere Token auf Server..."));
  if (!await scpFile(sshKey, serverUser, serverIp, tokenHome, "/root/.pibo-docs-notify-token")) {
    console.log(fail("Token konnte nicht auf Server kopiert werden. Setup abgebrochen."));
    return;
  }
  console.log(ok("Token auf Server verteilt"));

  // Server Watcher script
  const watcherScript = join(ASSETS_DIR, "scripts", "server-watcher.js");
  if (existsSync(watcherScript)) {
    if (await scpFile(sshKey, serverUser, serverIp, watcherScript, "/root/bin/pibo-docs-server-watcher.js")) {
      await sshExec(sshKey, serverUser, serverIp, "chmod +x /root/bin/pibo-docs-server-watcher.js", "Watcher chmod");
      console.log(ok("Server Watcher → /root/bin/"));
    }
  } else {
    console.log(fail("server-watcher.js nicht gefunden in Assets"));
  }

  // Server Sync Script
  const syncScript = join(ASSETS_DIR, "scripts", "server-sync.sh");
  if (existsSync(syncScript)) {
    if (await scpFile(sshKey, serverUser, serverIp, syncScript, "/root/bin/pibo-docs-sync.sh")) {
      await sshExec(sshKey, serverUser, serverIp, "chmod +x /root/bin/pibo-docs-sync.sh", "Sync chmod");
      console.log(ok("Sync Script → /root/bin/"));
    }
  } else {
    console.log(fail("server-sync.sh nicht gefunden in Assets"));
  }

  // Post-Receive Hook
  const hookFile = join(ASSETS_DIR, "hooks", "post-receive");
  if (existsSync(hookFile)) {
    if (await scpFile(sshKey, serverUser, serverIp, hookFile, "/var/docs-remote/hooks/post-receive")) {
      await sshExec(sshKey, serverUser, serverIp, "chmod +x /var/docs-remote/hooks/post-receive", "Hook chmod");
      console.log(ok("Post-Receive Hook → /var/docs-remote/hooks/"));
    }
  } else {
    console.log(fail("post-receive hook nicht gefunden in Assets"));
  }

  // Systemd Service
  const serviceTemplateFile = join(ASSETS_DIR, "services", "server-watcher.service");
  if (existsSync(serviceTemplateFile)) {
    const serviceTemplate = readFileSync(serviceTemplateFile, "utf8");
    const nodePath = nodeBin();
    const serviceContent = serviceTemplate
      .replace(/{{NODE_BIN}}/g, nodePath)
      .replace(/{{SCRIPTS_DIR}}/g, "/root/bin")
      .replace(/{{STORAGE_DOCS}}/g, cfg.server.remoteDocsPath)
      .replace(/{{NODE_BIN_DIR}}/g, dirname(nodePath))
      .replace(/{{PATH}}/g, process.env.PATH || "/usr/local/bin:/usr/bin:/bin")
      .replace(/{{CONFIG_DIR}}/g, "/root");

    const tmpService = join(home, ".config", "tmp-server-watcher.service");
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(tmpService, serviceContent);

    if (await scpFile(sshKey, serverUser, serverIp, tmpService, "/etc/systemd/system/pibo-docs-server-watcher.service")) {
      await sshExec(sshKey, serverUser, serverIp, "systemctl daemon-reload && systemctl enable --now pibo-docs-server-watcher.service", "Service enable");
      console.log(ok("Systemd Service: pibo-docs-server-watcher.service"));
    }

    // Cleanup temp file
    try { unlinkSync(tmpService); } catch {}
  }

  // Cron
  console.log(info("Prüfe Cron-Job..."));
  const existingCron = await sshExec(sshKey, serverUser, serverIp, "crontab -l 2>/dev/null | grep -q pibo-docs-sync && echo yes || echo no", "Cron Check");
  if (!existingCron) {
    const cronCmd = `(crontab -l 2>/dev/null; echo '* * * * * HOME=/root /root/bin/pibo-docs-sync.sh >> /var/log/pibo-docs-sync.log 2>&1') | crontab -`;
    await sshExec(sshKey, serverUser, serverIp, cronCmd, "Cron Job hinzufügen");
    console.log(ok("Cron-Job registriert: */1 pibo-docs-sync.sh"));
  } else {
    console.log(ok("Cron-Job existiert bereits"));
  }

  // Backup config to server too
  await scpFile(sshKey, serverUser, serverIp, join(home, ".pibo-docs-sync-config.json"), "/root/.pibo-docs-sync-config.json");

  // Save config locally
  cfg.role = "server";
  cfg.version = "0.1.0";
  cfg.createdAt = cfg.createdAt || new Date().toISOString();
  writeConfig("server", cfg);

  console.log("\n" + bold("✅ Server Setup abgeschlossen!"));
  console.log(info("Nächster Schritt: 'pibo docs-sync setup pibo' auf deinem PC"));
}
