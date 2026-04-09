import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { readConfig } from "./config.js";
import { bold, ok, fail, warn, info, commandExists, sshCheck } from "./utils.js";

export function runPrereqs() {
  const home = homedir();
  const cfg = readConfig("pibo") || readConfig("server");

  console.log(bold("\n🧰 Docs Sync Pre-Flight Checks"));
  console.log("═".repeat(50));

  let problems = 0;

  const requireCmd = (name: string, installHint?: string) => {
    if (commandExists(name)) {
      console.log(ok(`${name} vorhanden`));
    } else {
      console.log(fail(`${name} fehlt`));
      if (installHint) {
        console.log(info(installHint));
      }
      problems++;
    }
  };

  console.log(bold("\nLokale Voraussetzungen:"));
  requireCmd("node", "Installiere Node.js");
  requireCmd("git", "Installiere git, z. B. sudo apt install git");
  requireCmd("ssh", "Installiere openssh-client, z. B. sudo apt install openssh-client");
  requireCmd("scp", "Installiere openssh-client, z. B. sudo apt install openssh-client");
  requireCmd("systemctl", "Systemd wird für die User-Services gebraucht");

  const defaultKey = join(home, ".ssh", "id_ed25519");
  const sshKey = cfg?.server.sshKeyPath || defaultKey;
  if (existsSync(sshKey)) {
    console.log(ok(`SSH-Key gefunden: ${sshKey}`));
  } else {
    console.log(fail(`SSH-Key fehlt: ${sshKey}`));
    console.log(info('Erzeuge einen Key mit: ssh-keygen -t ed25519 -C "pibo@hostname"'));
    problems++;
  }

  if (cfg?.server.ip) {
    console.log(bold("\nServer-Verbindung:"));
    const sshOk = sshCheck(cfg.server.ip, cfg.server.user || "root", sshKey);
    if (sshOk) {
      console.log(ok(`SSH erreichbar: ${cfg.server.user}@${cfg.server.ip}`));
    } else {
      console.log(fail(`SSH nicht erreichbar: ${cfg.server.user}@${cfg.server.ip}`));
      console.log(info(`Teste manuell: ssh -i ${sshKey} ${cfg.server.user}@${cfg.server.ip}`));
      console.log(info(`Oder Key kopieren: ssh-copy-id ${cfg.server.user}@${cfg.server.ip}`));
      problems++;
    }
  } else {
    console.log(warn("Keine Server-IP konfiguriert — Wizard oder Config zuerst ausfüllen"));
    problems++;
  }

  console.log(bold("\nKonfiguration:"));
  if (!cfg) {
    console.log(fail("Keine Docs-Sync-Config gefunden"));
    console.log(info("Starte mit: pibo docs-sync setup-wizard"));
    problems++;
  } else {
    console.log(ok(`Config gefunden (${cfg.role})`));
    if (cfg.github.backupRepo) {
      console.log(ok(`Backup Repo gesetzt: ${cfg.github.backupRepo}`));
    } else {
      console.log(warn("GitHub Backup Repo ist leer"));
      problems++;
    }
    if (cfg.server.remoteDocsPath) {
      console.log(ok(`Server Docs Path: ${cfg.server.remoteDocsPath}`));
    }
  }

  if (cfg?.role !== "server") {
    console.log(bold("\nPIBo-seitig:"));
    const docsPath = cfg?.pibo.docsPath || join(home, "docs");
    if (existsSync(docsPath)) {
      console.log(ok(`Docs-Pfad existiert: ${docsPath}`));
    } else {
      console.log(warn(`Docs-Pfad existiert noch nicht: ${docsPath} (wird beim Setup erstellt)`));
    }
  }

  console.log("\n" + "═".repeat(50));
  if (problems === 0) {
    console.log(ok("Alle wichtigen Voraussetzungen erfüllt."));
    console.log(info("Weiter mit: pibo docs-sync setup <pibo|server>"));
  } else {
    console.log(warn(`${problems} Problem(e) gefunden.`));
    console.log(info("Behebe die Punkte oben und führe 'pibo docs-sync prereqs' erneut aus."));
  }
}
