import { Command } from "commander";
import { setupServer } from "./setup-server.js";
import { setupPibo } from "./setup-pibo.js";
import { showStatus } from "./status.js";
import { runDiagnose } from "./diagnose.js";
import { runTest } from "./test.js";
import { runWizard } from "./wizard.js";
import { showInfo } from "./info.js";
import { runPrereqs } from "./prereqs.js";
import { uninstallDocsSync } from "./uninstall.js";
import { readConfig } from "./config.js";
import { configExists } from "./config.js";

export function docsSync() {
  const cmd = new Command("docs-sync").description("Docs Sync Verwaltung — Setup, Status, Diagnose");

  cmd
    .command("setup <role>")
    .description("Setup ausführen — 'pibo' oder 'server'")
    .action(async (role: string) => {
      if (role === "server") await setupServer(false);
      else if (role === "pibo") await setupPibo(false);
      else console.log(`Unbekannte Rolle: ${role}. Verwende 'pibo' oder 'server'.`);
    });

  cmd
    .command("setup-wizard")
    .description("Interaktiver Setup Wizard")
    .action(async () => {
      await runWizard();
    });

  cmd
    .command("info")
    .description("Erklärt Architektur, Voraussetzungen und Setup-Reihenfolge")
    .action(showInfo);

  cmd
    .command("status")
    .description("Status aller Komponenten anzeigen")
    .action(showStatus);

  cmd
    .command("test")
    .description("Test-Sync durchführen")
    .action(runTest);

  cmd
    .command("doctor")
    .description("Diagnose bei Problemen")
    .action(runDiagnose);

  cmd
    .command("prereqs")
    .description("Vorab-Checks für frisches Setup")
    .action(runPrereqs);

  cmd
    .command("uninstall <role>")
    .description("Docs-Sync-Setup für Rolle entfernen — 'pibo' oder 'server'")
    .action((role: string) => uninstallDocsSync(role));

  cmd
    .command("config")
    .description("Konfiguration anzeigen")
    .option("--role <pibo|server>", "Rolle")
    .action((opts) => {
      const role = opts.role || (configExists("pibo") ? "pibo" : "server");
      const cfg = readConfig(role);
      if (!cfg) {
        console.log(`⚠ Keine Konfiguration für ${role} gefunden.`);
        console.log("ℹ Erstelle eine mit: pibo docs-sync setup-wizard");
        return;
      }
      console.log(`\n\x1b[1mKonfiguration (${role}):`);
      console.log(JSON.stringify(cfg, null, 2));
    });

  return cmd;
}
