import { homedir } from "os";
import { join } from "path";
import * as readline from "readline";
import { writeConfig, defaultConfig, DocsSyncConfig } from "./config.js";
import { setupPibo } from "./setup-pibo.js";
import { setupServer } from "./setup-server.js";
import { bold, info } from "./utils.js";

async function ask(rl: readline.Interface, prompt: string, defaultVal?: string): Promise<string> {
  const label = defaultVal ? `${prompt} [${defaultVal}]: ` : `${prompt}: `;
  const answer = await new Promise<string>((resolve) => rl.question(label, resolve));
  return answer || defaultVal || "";
}

function showPreReqGuide() {
  console.log("\n" + bold("📋 Was du VOR dem Setup brauchst:"));
  console.log("═".repeat(50));

  console.log("\n  " + bold("1. SSH-Keys erzeugen") + " (falls noch nicht geschehen)");
  console.log('     ssh-keygen -t ed25519 -C "pibo@hostname"');
  console.log("     → Speichert unter ~/.ssh/id_ed25519");
  console.log("     → Keine Passphrase für automatischen Betrieb empfohlen");
  console.log("");
  console.log("  " + bold("2. SSH-Key auf Server kopieren"));
  console.log("     ssh-copy-id root@<SERVER-IP>");
  console.log("     → Oder manuell:");
  console.log(
    "       cat ~/.ssh/id_ed25519.pub | ssh root@<IP> 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'",
  );
  console.log("");
  console.log("  " + bold("3. GitHub Deploy Key für Server"));
  console.log('     # Auf dem Server: ssh-keygen -t ed25519 -C "docs-sync"');
  console.log("     cat /root/.ssh/id_ed25519.pub  → Output kopieren");
  console.log("     GitHub → Repo → Settings → Deploy Keys → Add deploy key");
  console.log("     → Key einfügen, 'Allow write access' anhaken");
  console.log("");
  console.log("  " + bold("4. GitHub Repo erstellen"));
  console.log("     Repo für Docs Backup: docs-backup (oder anderer Name)");
  console.log("     → Private Repo empfohlen");
  console.log("     → URL wird im Setup abgefragt (z.B. git@github.com:user/repo.git)");
  console.log("");
  console.log("  " + bold("5. WebApp auf Server installieren"));
  console.log("     Der Docs-Sync braucht das Verzeichnis auf dem Server,");
  console.log("     wo die WebApp die Markdown-Files liest.");
  console.log("     Standard: /var/lib/pibo-webapp/storage/docs");
  console.log("     → Kann im Wizard geändert werden");
}

export async function runWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(bold("\n📚 PIBo Docs Sync — Setup Wizard"));
  console.log("═".repeat(50));
  console.log("\nDieser Wizard richtet das Docs Sync System ein.");

  showPreReqGuide();

  const ready = await ask(rl, "\nAlles bereit? (j/n)", "j");
  if (ready.toLowerCase() !== "j" && ready.toLowerCase() !== "y") {
    console.log("\n" + info("Setup abgebrochen. Komm zurück wenn alles bereit ist."));
    rl.close();
    return;
  }

  const role = await ask(rl, "Rolle dieser Maschine? [pibo/server]", "pibo");

  if (role === "server") {
    const ip = await ask(rl, "Server-IP?", "");
    if (!ip) {
      console.log("\n" + info("IP fehlt. Abbruch."));
      rl.close();
      return;
    }

    const user = await ask(rl, "SSH-User?", "root");
    const sshKeyPath = await ask(rl, "SSH-Key für GitHub Deploy auf Server?", "");
    const backupRepo = await ask(rl, "GitHub Docs-Backup Repo URL?", "");
    const webappRepo = await ask(rl, "GitHub WebApp Repo URL?", "");
    const webappDeployKey = await ask(rl, "Deploy Key Pfad für GitHub?", "/root/.ssh/id_ed25519");

    console.log("\nStarte Server Setup...");
    rl.close();

    // Build config from wizard answers instead of using ignored env vars
    const cfg = defaultConfig() as DocsSyncConfig;
    cfg.role = "server";
    cfg.server.ip = ip;
    cfg.server.user = user;
    cfg.server.sshKeyPath = sshKeyPath || `/home/${user}/.ssh/id_ed25519`;
    if (backupRepo) {
      cfg.github.backupRepo = backupRepo;
    }
    if (webappRepo) {
      cfg.github.webappRepo = webappRepo;
    }
    if (webappDeployKey) {
      cfg.github.deployKeyPath = webappDeployKey;
    }

    // Write config so setup-server reads it
    writeConfig("server", cfg);

    await setupServer(true);
  } else {
    const home = homedir();
    const serverIp = await ask(rl, "Server-IP?", "");
    if (!serverIp) {
      console.log("\n" + info("IP fehlt. Abbruch."));
      rl.close();
      return;
    }

    const serverUser = await ask(rl, "Server-User?", "root");
    const sshKeyPath = await ask(
      rl,
      "SSH-Key für Verbindung zum Server?",
      join(home, ".ssh", "id_ed25519"),
    );
    const docsPath = await ask(rl, "Lokaler Docs-Pfad?", join(home, "docs"));
    const backupRepo = await ask(rl, "GitHub Docs-Backup Repo URL?", "");
    const notifyPort = parseInt(await ask(rl, "Notify-Port?", "3472"), 10) || 3472;

    console.log("\nStarte PIBo Setup...");
    rl.close();

    // Build config from wizard answers
    const cfg = defaultConfig() as DocsSyncConfig;
    cfg.role = "pibo";
    cfg.server.ip = serverIp;
    cfg.server.user = serverUser;
    cfg.server.sshKeyPath = sshKeyPath;
    cfg.pibo.docsPath = docsPath;
    cfg.pibo.notifyPort = notifyPort;
    if (backupRepo) {
      cfg.github.backupRepo = backupRepo;
    }

    // Write config so setup-pibo reads it
    writeConfig("pibo", cfg);

    await setupPibo(true);
  }
}
