import { Command } from "commander";
import { twitterCheck, twitterStatus, twitterReset } from "./pibo/commands/twitter.js";
import { agentsTask } from "./pibo/commands/agents.js";
import { findInit, findRun } from "./pibo/find/index.js";
import {
  formatRegistrySummary,
  getCommandDir,
  getCommandPrompt,
  listCommands,
  setCommandDir,
} from "./pibo/commands/commands/index.js";
import { docsSync } from "./pibo/docs-sync/index.js";
import { localSync } from "./pibo/local-sync/index.js";
import { todoCheck, todoInit, todoStatus, todoTokens, DEFAULT_MAX_TOKENS } from "./pibo/commands/todo.js";
import {
  mcpCall,
  mcpCallHelp,
  mcpDisable,
  mcpDoctor,
  mcpEnable,
  mcpInspect,
  mcpList,
  mcpRefresh,
  mcpRegister,
  mcpShow,
  mcpTools,
  mcpUnregister,
} from "./pibo/commands/mcp.js";
import { sambaShareAdd } from "./pibo/commands/samba.js";
import { managedSessionSmoke } from "./pibo/commands/managed-session.js";

export function registerPiboCli(program: Command) {
  const pibo = program.command("pibo").description("PIBo CLI modules ported into OpenClaw");

  const twitter = pibo.command("twitter").description("Twitter/X tools");
  twitter.command("check").description("Following Feed checken — nur neue Tweets").option("--cold-start", "Cold Start — alle Tweets holen, nichts senden").option("--verbose", "Volle Ausgabe, keine Zusammenfassung").action(async (opts) => { await twitterCheck(opts); });
  twitter.command("status").description("Heartbeat-State anzeigen").action(async () => { await twitterStatus(); });
  twitter.command("reset").description("Heartbeat-State zurücksetzen").option("-y", "Keine Nachfrage").action(async (opts) => { await twitterReset(opts.y); });

  const agents = pibo.command("agents").description("Agent Task Management");
  agents.command("task <prompt>").description("One-Shot Task an einen Agent starten").action(async (prompt: string) => { await agentsTask(prompt); });

  const find = pibo.command("find [prompt]").description("OpenCode-basierte Dateisuche in Docs und Code");
  find
    .option("--docs", "Nur im Dokumentenwesen suchen")
    .option("--code", "Nur im Code-Verzeichnis suchen")
    .action(async (prompt: string | undefined, opts: { docs?: boolean; code?: boolean }) => {
      if (prompt === "init") {
        findInit();
        return;
      }
      if (!prompt) {
        console.error("Usage: openclaw pibo find <prompt> [--docs|--code]");
        process.exit(1);
      }
      await findRun(prompt, opts);
    });

  const commands = pibo.command("commands").description("Markdown-basierte PIBo Slash Commands verwalten");
  commands.command("set-dir <dir>").description("Verzeichnis für Markdown-Commands setzen").action(async (dir: string) => { const registry = setCommandDir(dir); console.log(`✅ Command-Verzeichnis gesetzt: ${registry.commandDir}`); });
  commands.command("list").description("Aktuell registrierte Commands anzeigen").action(async () => { const registry = listCommands(); console.log(formatRegistrySummary(registry)); });
  commands.command("get-dir").description("Aktuell gesetztes Command-Verzeichnis anzeigen").action(async () => { console.log(getCommandDir()); });
  commands.command("show <name>").description("Markdown-Inhalt eines Commands anzeigen").action(async (name: string) => { const result = getCommandPrompt(name); if (!result) { console.error(`Command nicht gefunden: ${name}`); process.exit(1); } console.log(result.content); });

  pibo.addCommand(docsSync());
  pibo.addCommand(localSync());

  const mcp = pibo.command("mcp").description("MCP-Server registrieren, aktivieren und deaktivieren");
  mcp.command("register <name> <json>").description("MCP-Server persistent in PIBo-Registry speichern").action((name: string, json: string) => { mcpRegister(name, json); });
  mcp.command("list").description("Registrierte und aktive MCP-Server anzeigen").action(() => { mcpList(); });
  mcp.command("show <name>").description("Definition eines MCP-Servers anzeigen").action((name: string) => { mcpShow(name); });
  mcp.command("enable <name>").description("Registrierten MCP-Server in OpenClaw aktivieren").action((name: string) => { mcpEnable(name); });
  mcp.command("disable <name>").description("MCP-Server aus OpenClaw entfernen, aber registriert lassen").action((name: string) => { mcpDisable(name); });
  mcp.command("unregister <name>").description("MCP-Server aus der PIBo-Registry entfernen").option("--force", "Auch wenn er noch aktiv ist").action((name: string, opts: { force?: boolean }) => { mcpUnregister(name, !!opts.force); });
  mcp.command("refresh <name>").description("Tool-Discovery für einen MCP-Server erneuern").action(async (name: string) => { await mcpRefresh(name); });
  mcp.command("doctor <name>").description("Registry, Cache und Runtime eines MCP-Servers prüfen").option("--refresh", "Am Ende Discovery-Cache aktiv erneuern").action(async (name: string, opts: { refresh?: boolean }) => { await mcpDoctor(name, opts); });
  mcp.command("tools <name>").description("Toolnamen eines MCP-Servers anzeigen").option("--refresh", "Discovery nicht aus Cache lesen").action(async (name: string, opts: { refresh?: boolean }) => { await mcpTools(name, opts); });
  mcp.command("inspect <name> [tool]").description("Discovery-Daten oder ein einzelnes Tool inspizieren").option("--refresh", "Discovery nicht aus Cache lesen").action(async (name: string, tool: string | undefined, opts: { refresh?: boolean }) => { await mcpInspect(name, tool, opts); });
  mcp.command("call [server] [tool]").description("Generischer MCP JSON-Invoker mit Discovery-Help").option("--json <json>", "JSON-Payload inline oder als @datei.json").option("--stdin", "JSON-Payload von stdin lesen").option("--refresh", "Discovery nicht aus Cache lesen").helpOption(false).allowUnknownOption(true).allowExcessArguments(true).action(async (server: string | undefined, tool: string | undefined, opts: { json?: string; stdin?: boolean; refresh?: boolean }) => { if (!server) { console.error("Usage: openclaw pibo mcp call <server> [tool] [--json <json>|--stdin]"); process.exit(1); } const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h"); if (wantsHelp || !tool) { await mcpCallHelp(server, tool, { refresh: opts.refresh }); return; } await mcpCall(server, tool, { json: opts.json, stdin: opts.stdin }); });

  const todo = pibo.command("todo").description("Todo.md Verwaltung");
  todo.command("init").description("TODO.md mit Grundstruktur anlegen").action(() => { void todoInit({}); });
  todo.command("status").description("TODO.md Status zusammenfassen").action(() => { void todoStatus({}); });
  todo.command("check").description("Token-Budget prüfen").option("--max <tokens>", `Maximale Tokenzahl (default: ${DEFAULT_MAX_TOKENS})`, (value) => Number(value)).action((opts: { max?: number }) => { void todoCheck({ max: opts.max }); });
  todo.command("tokens").description("Token-Anzahl von TODO.md anzeigen").option("--max <tokens>", `Maximale Tokenzahl (default: ${DEFAULT_MAX_TOKENS})`, (value) => Number(value)).action((opts: { max?: number }) => { void todoTokens({ max: opts.max }); });

  const managed = pibo.command("managed-session").description("PIBo managed session helpers");
  managed.command("smoke").description("Ersten managed-session smoke test ausführen").action(async () => { await managedSessionSmoke(); });

  const samba = pibo.command("samba").description("Samba-Tools");
  samba.command("share-add <linuxUser>").description("Samba-Share für einen Linux-User planen oder anlegen").option("--path <path>", "Pfad für den Share (default: Home des Users)").option("--name <name>", "Share-Name (default: Username)").option("--hosts-allow <list>", "Optionales hosts allow, z.B. 192.168.0. 127.").option("--apply", "Änderung wirklich anwenden").action((linuxUser: string, opts: { path?: string; name?: string; hostsAllow?: string; apply?: boolean }) => { sambaShareAdd(linuxUser, opts); });

  return pibo;
}
