import { Command } from "commander";
import { docsSync } from "./pibo/docs-sync/index.js";
import { localSync } from "./pibo/local-sync/index.js";

const TODO_DEFAULT_MAX_TOKENS = 2000;

async function loadAgentsModule() {
  return import("./pibo/commands/agents.js");
}

async function loadCommandRegistryModule() {
  return import("./pibo/commands/commands/index.js");
}

async function loadFindModule() {
  return import("./pibo/find/index.js");
}

async function loadMcpModule() {
  return import("./pibo/commands/mcp.js");
}

async function loadSambaModule() {
  return import("./pibo/commands/samba.js");
}

async function loadTodoModule() {
  return import("./pibo/commands/todo.js");
}

async function loadTwitterModule() {
  return import("./pibo/commands/twitter.js");
}

async function loadWorkflowModule() {
  return import("./pibo/workflows/index.js");
}

export function registerPiboCli(program: Command) {
  const pibo = program.command("pibo").description("PIBo CLI modules ported into OpenClaw");

  const twitter = pibo.command("twitter").description("Twitter/X tools");
  twitter
    .command("check")
    .description("Following Feed checken — nur neue Tweets")
    .option("--cold-start", "Cold Start — alle Tweets holen, nichts senden")
    .option("--verbose", "Volle Ausgabe, keine Zusammenfassung")
    .action(async (opts) => {
      const { twitterCheck } = await loadTwitterModule();
      await twitterCheck(opts);
    });
  twitter
    .command("status")
    .description("Heartbeat-State anzeigen")
    .action(async () => {
      const { twitterStatus } = await loadTwitterModule();
      await twitterStatus();
    });
  twitter
    .command("reset")
    .description("Heartbeat-State zurücksetzen")
    .option("-y", "Keine Nachfrage")
    .action(async (opts) => {
      const { twitterReset } = await loadTwitterModule();
      await twitterReset(opts.y);
    });

  const agents = pibo.command("agents").description("Agent Task Management");
  agents
    .command("task <prompt>")
    .description("One-Shot Task an einen Agent starten")
    .action(async (prompt: string) => {
      const { agentsTask } = await loadAgentsModule();
      await agentsTask(prompt);
    });

  const find = pibo
    .command("find [prompt]")
    .description("OpenCode-basierte Dateisuche in Docs und Code");
  find
    .option("--docs", "Nur im Dokumentenwesen suchen")
    .option("--code", "Nur im Code-Verzeichnis suchen")
    .action(async (prompt: string | undefined, opts: { docs?: boolean; code?: boolean }) => {
      const { findInit, findRun } = await loadFindModule();
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

  const commands = pibo
    .command("commands")
    .description("Markdown-basierte PIBo Slash Commands verwalten");
  commands
    .command("set-dir <dir>")
    .description("Verzeichnis für Markdown-Commands setzen")
    .action(async (dir: string) => {
      const { setCommandDir } = await loadCommandRegistryModule();
      const registry = setCommandDir(dir);
      console.log(`✅ Command-Verzeichnis gesetzt: ${registry.commandDir}`);
    });
  commands
    .command("list")
    .description("Aktuell registrierte Commands anzeigen")
    .action(async () => {
      const { formatRegistrySummary, listCommands } = await loadCommandRegistryModule();
      const registry = listCommands();
      console.log(formatRegistrySummary(registry));
    });
  commands
    .command("get-dir")
    .description("Aktuell gesetztes Command-Verzeichnis anzeigen")
    .action(async () => {
      const { getCommandDir } = await loadCommandRegistryModule();
      console.log(getCommandDir());
    });
  commands
    .command("show <name>")
    .description("Markdown-Inhalt eines Commands anzeigen")
    .action(async (name: string) => {
      const { getCommandPrompt } = await loadCommandRegistryModule();
      const result = getCommandPrompt(name);
      if (!result) {
        console.error(`Command nicht gefunden: ${name}`);
        process.exit(1);
      }
      console.log(result.content);
    });

  pibo.addCommand(docsSync());
  pibo.addCommand(localSync());

  const mcp = pibo
    .command("mcp")
    .description("MCP-Server registrieren, aktivieren und deaktivieren");
  mcp
    .command("register <name> <json>")
    .description("MCP-Server persistent in PIBo-Registry speichern")
    .action(async (name: string, json: string) => {
      const { mcpRegister } = await loadMcpModule();
      mcpRegister(name, json);
    });
  mcp
    .command("list")
    .description("Registrierte und aktive MCP-Server anzeigen")
    .action(async () => {
      const { mcpList } = await loadMcpModule();
      mcpList();
    });
  mcp
    .command("show <name>")
    .description("Definition eines MCP-Servers anzeigen")
    .action(async (name: string) => {
      const { mcpShow } = await loadMcpModule();
      mcpShow(name);
    });
  mcp
    .command("enable <name>")
    .description("Registrierten MCP-Server in OpenClaw aktivieren")
    .action(async (name: string) => {
      const { mcpEnable } = await loadMcpModule();
      mcpEnable(name);
    });
  mcp
    .command("disable <name>")
    .description("MCP-Server aus OpenClaw entfernen, aber registriert lassen")
    .action(async (name: string) => {
      const { mcpDisable } = await loadMcpModule();
      mcpDisable(name);
    });
  mcp
    .command("unregister <name>")
    .description("MCP-Server aus der PIBo-Registry entfernen")
    .option("--force", "Auch wenn er noch aktiv ist")
    .action(async (name: string, opts: { force?: boolean }) => {
      const { mcpUnregister } = await loadMcpModule();
      mcpUnregister(name, !!opts.force);
    });
  mcp
    .command("refresh <name>")
    .description("Tool-Discovery für einen MCP-Server erneuern")
    .action(async (name: string) => {
      const { mcpRefresh } = await loadMcpModule();
      await mcpRefresh(name);
    });
  mcp
    .command("doctor <name>")
    .description("Registry, Cache und Runtime eines MCP-Servers prüfen")
    .option("--refresh", "Am Ende Discovery-Cache aktiv erneuern")
    .action(async (name: string, opts: { refresh?: boolean }) => {
      const { mcpDoctor } = await loadMcpModule();
      await mcpDoctor(name, opts);
    });
  mcp
    .command("tools <name>")
    .description("Toolnamen eines MCP-Servers anzeigen")
    .option("--refresh", "Discovery nicht aus Cache lesen")
    .action(async (name: string, opts: { refresh?: boolean }) => {
      const { mcpTools } = await loadMcpModule();
      await mcpTools(name, opts);
    });
  mcp
    .command("inspect <name> [tool]")
    .description("Discovery-Daten oder ein einzelnes Tool inspizieren")
    .option("--refresh", "Discovery nicht aus Cache lesen")
    .action(async (name: string, tool: string | undefined, opts: { refresh?: boolean }) => {
      const { mcpInspect } = await loadMcpModule();
      await mcpInspect(name, tool, opts);
    });
  mcp
    .command("call [server] [tool]")
    .description("Generischer MCP JSON-Invoker mit Discovery-Help")
    .option("--json <json>", "JSON-Payload inline oder als @datei.json")
    .option("--stdin", "JSON-Payload von stdin lesen")
    .option("--refresh", "Discovery nicht aus Cache lesen")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(
      async (
        server: string | undefined,
        tool: string | undefined,
        opts: { json?: string; stdin?: boolean; refresh?: boolean },
      ) => {
        if (!server) {
          console.error("Usage: openclaw pibo mcp call <server> [tool] [--json <json>|--stdin]");
          process.exit(1);
        }
        const { mcpCall, mcpCallHelp } = await loadMcpModule();
        const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
        if (wantsHelp || !tool) {
          await mcpCallHelp(server, tool, { refresh: opts.refresh });
          return;
        }
        await mcpCall(server, tool, { json: opts.json, stdin: opts.stdin });
      },
    );

  const todo = pibo.command("todo").description("Todo.md Verwaltung");
  todo
    .command("init")
    .description("TODO.md mit Grundstruktur anlegen")
    .action(async () => {
      const { todoInit } = await loadTodoModule();
      void todoInit({});
    });
  todo
    .command("status")
    .description("TODO.md Status zusammenfassen")
    .action(async () => {
      const { todoStatus } = await loadTodoModule();
      todoStatus({});
    });
  todo
    .command("check")
    .description("Token-Budget prüfen")
    .option("--max <tokens>", `Maximale Tokenzahl (default: ${TODO_DEFAULT_MAX_TOKENS})`, (value) =>
      Number(value),
    )
    .action(async (opts: { max?: number }) => {
      const { todoCheck } = await loadTodoModule();
      todoCheck({ max: opts.max });
    });
  todo
    .command("tokens")
    .description("Token-Anzahl von TODO.md anzeigen")
    .option("--max <tokens>", `Maximale Tokenzahl (default: ${TODO_DEFAULT_MAX_TOKENS})`, (value) =>
      Number(value),
    )
    .action(async (opts: { max?: number }) => {
      const { todoTokens } = await loadTodoModule();
      todoTokens({ max: opts.max });
    });

  const workflows = pibo.command("workflows").description("Generische PIBO Workflow-Module");
  workflows
    .command("list")
    .description("Registrierte Workflow-Module anzeigen")
    .option("--json", "JSON-Ausgabe")
    .action(async (opts: { json?: boolean }) => {
      const { workflowsList } = await loadWorkflowModule();
      workflowsList({ json: opts.json });
    });
  workflows
    .command("describe <moduleId>")
    .description("Workflow-Modul beschreiben")
    .option("--json", "JSON-Ausgabe")
    .action(async (moduleId: string, opts: { json?: boolean }) => {
      const { workflowsDescribe } = await loadWorkflowModule();
      workflowsDescribe(moduleId, { json: opts.json });
    });
  workflows
    .command("start <moduleId>")
    .description("Workflow-Run starten")
    .option("--json <json>", "JSON-Input inline oder als @datei.json")
    .option("--stdin", "JSON-Input von stdin lesen")
    .option("--max-rounds <n>", "Maximale Rundenzahl")
    .option("--output-json", "Run-Record als JSON ausgeben")
    .action(
      async (
        moduleId: string,
        opts: {
          json?: string;
          stdin?: boolean;
          maxRounds?: string;
          outputJson?: boolean;
        },
      ) => {
        const { workflowsStart } = await loadWorkflowModule();
        await workflowsStart(moduleId, opts);
      },
    );
  workflows
    .command("start-async <moduleId>")
    .description("Workflow-Run asynchron starten")
    .option("--json <json>", "JSON-Input inline oder als @datei.json")
    .option("--stdin", "JSON-Input von stdin lesen")
    .option("--max-rounds <n>", "Maximale Rundenzahl")
    .option("--output-json", "Initialen Run-Record als JSON ausgeben")
    .action(
      async (
        moduleId: string,
        opts: {
          json?: string;
          stdin?: boolean;
          maxRounds?: string;
          outputJson?: boolean;
        },
      ) => {
        const { workflowsStartAsync } = await loadWorkflowModule();
        await workflowsStartAsync(moduleId, opts);
      },
    );
  workflows
    .command("wait <runId>")
    .description("Auf terminalen Workflow-Status warten")
    .option("--timeout-ms <n>", "Wartezeit in Millisekunden")
    .option("--json", "JSON-Ausgabe")
    .action(async (runId: string, opts: { timeoutMs?: string; json?: boolean }) => {
      const { workflowsWait } = await loadWorkflowModule();
      await workflowsWait(runId, opts);
    });
  workflows
    .command("status <runId>")
    .description("Workflow-Run Status anzeigen")
    .option("--json", "JSON-Ausgabe")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { workflowsStatus } = await loadWorkflowModule();
      workflowsStatus(runId, { json: opts.json });
    });
  workflows
    .command("progress <runId>")
    .description("Kompakten Workflow-Status anzeigen")
    .option("--json", "JSON-Ausgabe")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { workflowsProgress } = await loadWorkflowModule();
      workflowsProgress(runId, { json: opts.json });
    });
  workflows
    .command("abort <runId>")
    .description("Workflow-Run abbrechen")
    .option("--json", "JSON-Ausgabe")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { workflowsAbort } = await loadWorkflowModule();
      workflowsAbort(runId, { json: opts.json });
    });
  workflows
    .command("runs")
    .description("Gespeicherte Workflow-Runs anzeigen")
    .option("--limit <n>", "Maximale Anzahl")
    .option("--json", "JSON-Ausgabe")
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const { workflowsRuns } = await loadWorkflowModule();
      workflowsRuns({ limit: opts.limit, json: opts.json });
    });
  const workflowTrace = workflows.command("trace").description("Workflow-Trace inspizieren");
  workflowTrace
    .command("summary <runId>")
    .description("Trace-Summary fuer einen Run anzeigen")
    .option("--json", "JSON-Ausgabe")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { workflowsTraceSummary } = await loadWorkflowModule();
      workflowsTraceSummary(runId, { json: opts.json });
    });
  workflowTrace
    .command("events <runId>")
    .description("Trace-Events fuer einen Run anzeigen")
    .option("--limit <n>", "Nur die letzten n passenden Events ausgeben")
    .option("--since-seq <n>", "Nur Events nach dieser Sequenznummer ausgeben")
    .option("--role <name>", "Nur Events fuer eine Rolle ausgeben")
    .option("--kind <kind>", "Nur einen Event-Typ ausgeben")
    .option("--json", "JSON-Ausgabe")
    .action(
      async (
        runId: string,
        opts: {
          limit?: string;
          sinceSeq?: string;
          role?: string;
          kind?: string;
          json?: boolean;
        },
      ) => {
        const { workflowsTraceEvents } = await loadWorkflowModule();
        workflowsTraceEvents(runId, {
          json: opts.json,
          limit: opts.limit,
          sinceSeq: opts.sinceSeq,
          role: opts.role,
          kind: opts.kind,
        });
      },
    );
  workflows
    .command("artifacts <runId>")
    .description("Artefakte eines Workflow-Runs anzeigen")
    .option("--json", "JSON-Ausgabe")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { workflowsArtifacts } = await loadWorkflowModule();
      workflowsArtifacts(runId, { json: opts.json });
    });
  workflows
    .command("artifact <runId> <name>")
    .description("Ein einzelnes Workflow-Artefakt lesen")
    .option("--head-lines <n>", "Nur die ersten n Zeilen ausgeben")
    .option("--tail-lines <n>", "Nur die letzten n Zeilen ausgeben")
    .option("--json", "JSON-Ausgabe")
    .action(
      async (
        runId: string,
        name: string,
        opts: { headLines?: string; tailLines?: string; json?: boolean },
      ) => {
        const { workflowsArtifact } = await loadWorkflowModule();
        workflowsArtifact(runId, name, {
          json: opts.json,
          headLines: opts.headLines,
          tailLines: opts.tailLines,
        });
      },
    );

  const samba = pibo.command("samba").description("Samba-Tools");
  samba
    .command("share-add <linuxUser>")
    .description("Samba-Share für einen Linux-User planen oder anlegen")
    .option("--path <path>", "Pfad für den Share (default: Home des Users)")
    .option("--name <name>", "Share-Name (default: Username)")
    .option("--hosts-allow <list>", "Optionales hosts allow, z.B. 192.168.0. 127.")
    .option("--apply", "Änderung wirklich anwenden")
    .action(
      async (
        linuxUser: string,
        opts: { path?: string; name?: string; hostsAllow?: string; apply?: boolean },
      ) => {
        const { sambaShareAdd } = await loadSambaModule();
        sambaShareAdd(linuxUser, opts);
      },
    );

  return pibo;
}
