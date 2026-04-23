import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readConfig, writeConfig, defaultConfig, DocsSyncConfig } from "./config.js";
import { bold, ok, fail, warn, info, run, commandExists, nodeBin, generateToken } from "./utils.js";

function resolveAssetsDir(): string {
  const candidates = [
    fileURLToPath(new URL("../../../../docs/pibo-cli/assets/", import.meta.url)),
    fileURLToPath(new URL("../docs/pibo-cli/assets/", import.meta.url)),
    join(process.cwd(), "docs", "pibo-cli", "assets"),
  ];
  return (
    candidates.find((dir) => existsSync(join(dir, "scripts", "pibo-watcher.js"))) || candidates[0]
  );
}

const ASSETS_DIR = resolveAssetsDir();

function readExecErrorStderr(error: unknown): string {
  if (!error || typeof error !== "object" || !("stderr" in error)) {
    return "unknown error";
  }
  const stderr = error.stderr;
  if (typeof stderr === "string") {
    return stderr.trim() || "unknown error";
  }
  if (stderr instanceof Uint8Array) {
    return Buffer.from(stderr).toString("utf8").trim() || "unknown error";
  }
  return "unknown error";
}

/** SCP a file with proper error handling and feedback */
async function scpFile(
  keyPath: string,
  user: string,
  host: string,
  localPath: string,
  remotePath: string,
): Promise<boolean> {
  const cmd = `scp -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${localPath} ${user}@${host}:${remotePath}`;
  try {
    execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const stderr = readExecErrorStderr(error);
    console.log(fail(`SCP fehlgeschlagen: ${localPath} → ${host}:${remotePath}`));
    console.log(warn(`Error: ${stderr}`));
    return false;
  }
}

/** Execute SSH command with proper error handling */
function sshExec(
  keyPath: string,
  user: string,
  host: string,
  remoteCmd: string,
  label: string,
): boolean {
  const cmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes ${user}@${host} ${JSON.stringify(remoteCmd)}`;
  try {
    execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const stderr = readExecErrorStderr(error);
    console.log(fail(`${label} fehlgeschlagen`));
    console.log(warn(`Error: ${stderr}`));
    return false;
  }
}

export async function setupPibo(interactive: boolean) {
  console.log(bold("\n🤖 PIBo Machine Setup"));
  console.log("═".repeat(50));

  const home = homedir();

  // Load or create config
  let cfg = readConfig("pibo");
  if (!cfg) {
    cfg = defaultConfig() as DocsSyncConfig;
    cfg.role = "pibo";
  }

  // Pre-flight checks
  console.log("\n" + bold("Prüfe Voraussetzungen..."));

  if (!commandExists("node")) {
    console.log(fail("Node.js fehlt"));
    return;
  }
  const nodePath = nodeBin();
  console.log(ok(`Node.js: ${nodePath}`));

  if (!commandExists("ssh")) {
    console.log(fail("SSH fehlt"));
    console.log(info("Installiere: sudo apt install openssh-client"));
    return;
  }
  console.log(ok("SSH vorhanden"));

  if (!commandExists("git")) {
    console.log(fail("git fehlt"));
    console.log(info("Installiere: sudo apt install git"));
    return;
  }
  console.log(ok("git vorhanden"));

  const sshKeyPath = cfg.server.sshKeyPath || join(home, ".ssh", "id_ed25519");

  // Check SSH key exists
  if (!existsSync(sshKeyPath)) {
    console.log(fail(`SSH-Key nicht gefunden: ${sshKeyPath}`));
    if (interactive) {
      console.log(info("Möchtest du jetzt einen SSH-Key generieren?"));
      console.log(info('  ssh-keygen -t ed25519 -C "pibo@$(hostname)"'));
      console.log(info("Dann erneut 'pibo docs-sync setup pibo' ausführen."));
    }
    return;
  }
  console.log(ok(`SSH-Key: ${sshKeyPath}`));

  // Check SSH to server with proper error handling
  console.log(info(`Teste SSH-Verbindung zu ${cfg.server.user}@${cfg.server.ip}...`));
  let connected = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (sshExec(sshKeyPath, cfg.server.user, cfg.server.ip, "echo ok", "SSH-Verbindung")) {
      connected = true;
      break;
    }
    if (attempt < 3) {
      console.log(info(`Versuch ${attempt} fehlgeschlagen, retry in 3s...`));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!connected) {
    console.log(fail("SSH-Verbindung zum Server fehlgeschlagen nach 3 Versuchen"));
    console.log(info("Prüfe:"));
    console.log(info(`  1. Server erreichbar? (ping ${cfg.server.ip})`));
    console.log(
      info(
        `  2. SSH-Key auf Server installiert? (ssh-copy-id ${cfg.server.user}@${cfg.server.ip})`,
      ),
    );
    console.log(
      info(
        `  3. SSH-Key ohne Passphrase? (ssh -i ${sshKeyPath} ${cfg.server.user}@${cfg.server.ip})`,
      ),
    );
    return;
  }
  console.log(ok(`SSH → Server: OK (${cfg.server.user}@${cfg.server.ip})`));

  // Ensure ~/docs/ exists and is a git repo
  const docsPath = cfg.pibo.docsPath || join(home, "docs");
  if (!existsSync(docsPath)) {
    console.log(warn(`${docsPath} existiert nicht — erstelle...`));
    mkdirSync(docsPath, { recursive: true });
  }

  if (!existsSync(join(docsPath, ".git"))) {
    console.log(info("Initialisiere Git Repo in ~/docs/..."));
    if (!run(`cd ${docsPath} && git init`)) {
      console.log(fail("Git Init fehlgeschlagen"));
      return;
    }
    run(`cd ${docsPath} && git add -A && git commit -m "init: docs directory" || true`);
  }
  console.log(ok(`Docs Repo: ${docsPath}`));

  // Add bare repo as remote if not already configured
  const remotes = run(`cd ${docsPath} && git remote get-url origin 2>/dev/null`) || "";
  if (!remotes) {
    console.log(
      info(
        "Bare Repo 'origin' wird nicht automatisch gesetzt — wird beim ersten Pull vom Server eingerichtet.",
      ),
    );
  } else {
    console.log(ok(`Remote origin: ${remotes.trim()}`));
  }

  // Generate or read token
  if (!cfg.server.notifyToken) {
    console.log(info("Generiere neues Notify-Token..."));
    const newToken = generateToken();
    cfg.server.notifyToken = newToken;
    cfg.pibo.notifyToken = newToken;
  }

  // Save token locally
  const tokenPath = join(home, ".pibo-docs-sync-token");
  writeFileSync(tokenPath, cfg.server.notifyToken);
  chmodSync(tokenPath, 0o600);
  console.log(ok(`Token gespeichert: ${tokenPath}`));

  // Copy token to server with proper error handling
  console.log(info("Kopiere Token auf Server..."));
  const scpResult = await scpFile(
    sshKeyPath,
    cfg.server.user,
    cfg.server.ip,
    tokenPath,
    "/root/.pibo-docs-notify-token",
  );
  if (!scpResult) {
    console.log(fail("Token konnte nicht auf Server kopiert werden. Setup abgebrochen."));
    console.log(
      info(
        `Manuell: scp -i ${sshKeyPath} ${tokenPath} ${cfg.server.user}@${cfg.server.ip}:/root/.pibo-docs-notify-token`,
      ),
    );
    return;
  }
  console.log(ok("Notify-Token auf Server verteilt"));

  // === Install Scripts ===
  console.log("\n" + bold("Installiere scripts..."));

  const scriptsTarget = join(home, "docs-sync");
  mkdirSync(scriptsTarget, { recursive: true });
  console.log(ok(`Scripts-Verzeichnis: ${scriptsTarget}/`));

  // Read watcher.js to dynamically determine push script name
  const watcherSrc = readFileSync(join(ASSETS_DIR, "scripts", "pibo-watcher.js"), "utf8");
  const pushScriptMatch = watcherSrc.match(/PUSH_SCRIPT.*?['"]([^'"]+)['"]/);
  const pushScriptName =
    pushScriptMatch && pushScriptMatch[1]
      ? pushScriptMatch[1].split("/").pop() || "pibo-push.sh"
      : "pibo-push.sh";

  const scripts = [
    "pibo-notifier.js",
    "pibo-watcher.js",
    "pibo-pull.sh",
    "tunnel-monitor.js",
    pushScriptName, // Include pibo-push.sh if it exists
  ];

  let scriptsCopied = 0;
  for (const script of scripts) {
    const src = join(ASSETS_DIR, "scripts", script);
    if (!existsSync(src)) {
      continue;
    }

    const content = readFileSync(src, "utf8").replace(/\/home\/pibo/g, home);
    const dst = join(scriptsTarget, script);
    writeFileSync(dst, content);
    if (script && script.endsWith(".sh")) {
      chmodSync(dst, 0o755);
    }
    scriptsCopied++;
  }
  console.log(ok(`${scriptsCopied} Scripts installiert in ${scriptsTarget}/`));

  // === Install Systemd user services ===
  console.log("\n" + bold("Registriere Services..."));

  const systemdTarget = join(home, ".config", "systemd", "user");
  mkdirSync(systemdTarget, { recursive: true });
  const nodeDir = dirname(nodeBin());

  // notifier.service
  const notifierTmpl = readFileSync(join(ASSETS_DIR, "services", "notifier.service"), "utf8");
  writeFileSync(
    join(systemdTarget, "pibo-docs-notifier.service"),
    notifierTmpl
      .replace(/{{NODE_BIN}}/g, nodeBin())
      .replace(/{{SCRIPTS_DIR}}/g, scriptsTarget)
      .replace(/{{HOME}}/g, home)
      .replace(/{{NODE_BIN_DIR}}/g, nodeDir)
      .replace(/{{PATH}}/g, process.env.PATH || "/usr/local/bin:/usr/bin:/bin")
      .replace(/{{DOCS_PATH}}/g, docsPath),
  );

  // tunnel.service
  const tunnelTmpl = readFileSync(join(ASSETS_DIR, "services", "tunnel.service"), "utf8");
  writeFileSync(
    join(systemdTarget, "pibo-docs-tunnel.service"),
    tunnelTmpl
      .replace(/{{NOTIFY_PORT}}/g, String(cfg.pibo.notifyPort))
      .replace(/{{SERVER_IP}}/g, cfg.server.ip)
      .replace(/{{SERVER_USER}}/g, cfg.server.user)
      .replace(/{{SSH_KEY_PATH}}/g, sshKeyPath),
  );

  // watcher.service
  const watcherTmpl = readFileSync(join(ASSETS_DIR, "services", "pibo-watcher.service"), "utf8");
  writeFileSync(
    join(systemdTarget, "pibo-docs-watcher.service"),
    watcherTmpl
      .replace(/{{NODE_BIN}}/g, nodeBin())
      .replace(/{{SCRIPTS_DIR}}/g, scriptsTarget)
      .replace(/{{HOME}}/g, home)
      .replace(/{{NODE_BIN_DIR}}/g, nodeDir)
      .replace(/{{PATH}}/g, process.env.PATH || "/usr/local/bin:/usr/bin:/bin")
      .replace(/{{DOCS_PATH}}/g, docsPath),
  );

  // reconcile.service + timer: fallback push if a watcher event was missed
  const reconcileServiceTmpl = readFileSync(
    join(ASSETS_DIR, "services", "pibo-reconcile.service"),
    "utf8",
  );
  writeFileSync(
    join(systemdTarget, "pibo-docs-reconcile.service"),
    reconcileServiceTmpl
      .replace(/{{SCRIPTS_DIR}}/g, scriptsTarget)
      .replace(/{{HOME}}/g, home)
      .replace(/{{NODE_BIN_DIR}}/g, nodeDir)
      .replace(/{{PATH}}/g, process.env.PATH || "/usr/local/bin:/usr/bin:/bin")
      .replace(/{{DOCS_PATH}}/g, docsPath),
  );

  const reconcileTimerTmpl = readFileSync(
    join(ASSETS_DIR, "services", "pibo-reconcile.timer"),
    "utf8",
  );
  writeFileSync(join(systemdTarget, "pibo-docs-reconcile.timer"), reconcileTimerTmpl);
  console.log(ok("4 Service-Files und 1 Timer geschrieben"));

  // === Enable services with proper error checking ===
  console.log("\n" + bold("Aktiviere Services..."));

  run(`systemctl --user daemon-reload`);

  // Start services and verify
  const services = [
    "pibo-docs-tunnel.service",
    "pibo-docs-notifier.service",
    "pibo-docs-watcher.service",
  ];
  let servicesOk = true;
  for (const svc of services) {
    run(`systemctl --user enable --now ${svc}`);
    await new Promise((r) => setTimeout(r, 1500)); // Give service time to start
    const active = run(`systemctl --user is-active ${svc}`);
    if (active === "active") {
      console.log(ok(`${svc}: aktiv`));
    } else {
      console.log(fail(`${svc}: nicht aktiv`));
      const logs = run(`journalctl --user -u ${svc} --no-pager -n 5`) || "Keine Logs";
      console.log(warn(`Logs:\n${logs.split("\n").slice(-3).join("\n")}`));
      servicesOk = false;
    }
  }

  const reconcileTimer = "pibo-docs-reconcile.timer";
  run(`systemctl --user enable --now ${reconcileTimer}`);
  run(`systemctl --user start pibo-docs-reconcile.service || true`);
  const timerActive = run(`systemctl --user is-active ${reconcileTimer}`);
  if (timerActive === "active") {
    console.log(ok(`${reconcileTimer}: aktiv`));
  } else {
    console.log(fail(`${reconcileTimer}: nicht aktiv`));
    servicesOk = false;
  }

  if (!servicesOk) {
    console.log(
      fail(
        "Einige Services sind nicht gestartet. Prüfe die Logs mit: journalctl --user -u pibo-docs-*.service",
      ),
    );
    console.log(
      info("Trotzdem Config gespeichert — du kannst die Services später manuell starten."),
    );
  }

  // Save config
  cfg.role = "pibo";
  cfg.version = "0.1.0";
  cfg.lastModified = new Date().toISOString();
  writeConfig("pibo", cfg);

  console.log("\n" + bold("✅ PIBo Setup abgeschlossen!"));
  console.log(info("Nächster Schritt: 'pibo docs-sync status' — prüfen ob alles läuft"));
  console.log(info("Oder: 'pibo docs-sync test' — Test-Sync durchführen"));
}
