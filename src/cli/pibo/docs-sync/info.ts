import { bold, info, ok } from "./utils.js";

export function showInfo() {
  console.log(bold("\n📚 Docs Sync Setup Guide"));
  console.log("═".repeat(50));

  console.log("\nDocs Sync verbindet drei Teile:");
  console.log("  1. PIBo-Maschine mit lokalem ~/docs Repo");
  console.log("  2. Server mit Bare Repo + WebApp Storage");
  console.log("  3. GitHub Backup Repo als zusätzliches Remote/Backup");

  console.log("\n" + bold("Was die CLI übernimmt:"));
  console.log("  • lokale Scripts installieren");
  console.log("  • systemd Services schreiben/aktivieren");
  console.log("  • Token erzeugen und verteilen");
  console.log("  • Bare Repo auf dem Server anlegen");
  console.log("  • Hook / Cron / Server-Watcher einrichten");
  console.log("  • Vorab-Checks und Diagnose anbieten");

  console.log("\n" + bold("Was du vorher manuell erledigen musst:"));
  console.log("  • GitHub Repo für das Docs-Backup anlegen");
  console.log("  • SSH-Key auf der PIBo-Maschine erzeugen");
  console.log("  • SSH-Zugriff von PIBo → Server einrichten");
  console.log("  • Deploy Key auf dem Server erzeugen und im GitHub Repo hinterlegen");
  console.log("  • WebApp bzw. Storage-Pfad auf dem Server bereitstellen");

  console.log("\n" + bold("Konkrete Vorbereitung:"));
  console.log("  1. SSH-Key auf PIBo erzeugen:");
  console.log('     ssh-keygen -t ed25519 -C "pibo@hostname"');
  console.log("  2. Key auf Server kopieren:");
  console.log("     ssh-copy-id root@<SERVER-IP>");
  console.log("  3. Deploy Key auf Server erzeugen:");
  console.log('     ssh root@<SERVER-IP> "ssh-keygen -t ed25519 -C docs-sync -f /root/.ssh/id_ed25519 -N \"\""');
  console.log("  4. Public Key in GitHub eintragen:");
  console.log("     Repo → Settings → Deploy Keys → Add deploy key");
  console.log("     → 'Allow write access' aktivieren");
  console.log("  5. Sicherstellen, dass der Server-Storage existiert:");
  console.log("     Standard: /var/lib/pibo-webapp/storage/docs");

  console.log("\n" + bold("Empfohlene Reihenfolge:"));
  console.log("  1. pibo docs-sync info");
  console.log("  2. pibo docs-sync prereqs");
  console.log("  3. pibo docs-sync setup-wizard");
  console.log("  4. oder direkt: pibo docs-sync setup server");
  console.log("  5. dann: pibo docs-sync setup pibo");
  console.log("  6. danach prüfen: pibo docs-sync status");
  console.log("  7. Testlauf: pibo docs-sync test");

  console.log("\n" + bold("Wichtige Eingaben im Wizard:"));
  console.log("  • Server-IP");
  console.log("  • SSH-User (meist root)");
  console.log("  • SSH-Key-Pfad");
  console.log("  • GitHub Backup Repo URL");
  console.log("  • optional: WebApp Repo / Deploy Key / Docs-Pfad / Notify-Port");

  console.log("\n" + bold("Wenn etwas nicht klappt:"));
  console.log("  • pibo docs-sync prereqs   → Voraussetzungen prüfen");
  console.log("  • pibo docs-sync status    → Gesamtstatus sehen");
  console.log("  • pibo docs-sync doctor    → Fehler diagnostizieren");
  console.log("  • pibo docs-sync test      → echten Sync testen");

  console.log("\n" + bold("Wichtige Grenzen:"));
  console.log("  • Die CLI kann GitHub-Repos nicht magisch erstellen");
  console.log("  • Die CLI kann keine kaputte SSH-Verbindung für dich 'wegzaubern'");
  console.log("  • Die CLI setzt voraus, dass die WebApp bzw. der Storage-Pfad existiert");
  console.log("  • Externe Voraussetzungen werden erklärt und geprüft, aber nicht vollständig automatisiert");

  console.log("\n" + ok("Wenn du neu startest: erst 'info', dann 'prereqs', dann Setup."));
  console.log(info("Das Ziel ist: kein Insider-Wissen nötig, nur die Vorbereitungsschritte sauber abarbeiten."));
}
