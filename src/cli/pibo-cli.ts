import { Command } from "commander";
import { docsSync } from "./pibo/docs-sync/index.js";
import { localSync } from "./pibo/local-sync/index.js";

const TODO_DEFAULT_MAX_TOKENS = 2000;

async function loadAgentsModule() {
  return import("./pibo/commands/agents.js");
}

async function loadBrowserPoolModule() {
  return import("./pibo/commands/browser-pool.js");
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

async function loadWorkflowReadOnlyModule() {
  return import("./pibo/workflows/read-only.js");
}

export function registerPiboCli(program: Command) {
  const pibo = program.command("pibo").description("PIBo CLI modules ported into OpenClaw");

  const twitter = pibo.command("twitter").description("Twitter/X tools");
  const addTwitterFeedCheckOptions = (command: Command) =>
    command
      .option("--new <n>", "Target number of new tweets to collect", "20")
      .option("--max-scanned <n>", "Hard cap for scanned tweet candidates", "1000")
      .option("--ignore-state", "Do not read saved state for dedupe")
      .option("--no-write-state", "Do not write updated state after this run")
      .option("--stateless", "Convenience flag for --ignore-state plus --no-write-state")
      .option("--json", "Emit structured JSON output (default)");

  const twitterCheck = twitter
    .command("check")
    .description("Scrape Twitter/X feeds and return raw tweet data");

  addTwitterFeedCheckOptions(
    twitterCheck
      .command("following")
      .description("Scrape the Following feed")
      .action(async (opts) => {
        const { twitterCheckFeed } = await loadTwitterModule();
        await twitterCheckFeed("following", opts);
      }),
  );

  addTwitterFeedCheckOptions(
    twitterCheck
      .command("for-you")
      .description("Scrape the For You feed")
      .action(async (opts) => {
        const { twitterCheckFeed } = await loadTwitterModule();
        await twitterCheckFeed("for-you", opts);
      }),
  );

  addTwitterFeedCheckOptions(
    twitterCheck.action(async (opts) => {
      const { twitterCheckDeprecatedAlias } = await loadTwitterModule();
      await twitterCheckDeprecatedAlias("following", opts);
    }),
  );

  const twitterState = twitter.command("state").description("Twitter/X feed state");
  twitterState
    .command("status")
    .description("Show saved tweet dedupe state for a feed")
    .option("--feed <feed>", "Feed name (following|for-you)", "following")
    .action(async (opts: { feed: string }) => {
      const { twitterStatus } = await loadTwitterModule();
      await twitterStatus(opts);
    });
  twitterState
    .command("reset")
    .description("Reset saved tweet dedupe state for a feed")
    .option("--feed <feed>", "Feed name (following|for-you)", "following")
    .option("-y", "Skip confirmation")
    .action(async (opts: { feed: string; y?: boolean }) => {
      const { twitterReset } = await loadTwitterModule();
      await twitterReset(opts);
    });

  twitter
    .command("status")
    .description("Show saved tweet dedupe state for a feed")
    .option("--feed <feed>", "Feed name (following|for-you)", "following")
    .action(async (opts: { feed: string }) => {
      const { twitterStatus } = await loadTwitterModule();
      await twitterStatus(opts);
    });
  twitter
    .command("reset")
    .description("Reset saved tweet dedupe state for a feed")
    .option("--feed <feed>", "Feed name (following|for-you)", "following")
    .option("-y", "Skip confirmation")
    .action(async (opts: { feed: string; y?: boolean }) => {
      const { twitterReset } = await loadTwitterModule();
      await twitterReset(opts);
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
    .description("Agentischer OpenCode-Finder für Docs/Code; kann dauern, zeigt stderr-Liveness");
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
    .description("PIBo-MCP-Registry verwalten und Server optional explizit in OpenClaw aktivieren");
  mcp
    .command("register <name> <json>")
    .description("MCP-Server persistent in PIBo-Registry speichern")
    .action(async (name: string, json: string) => {
      const { mcpRegister } = await loadMcpModule();
      mcpRegister(name, json);
    });
  mcp
    .command("list")
    .description("PIBo-Registry und aktive OpenClaw-MCP-Server getrennt anzeigen")
    .action(async () => {
      const { mcpList } = await loadMcpModule();
      mcpList();
    });
  mcp
    .command("show <name>")
    .description("PIBo-Registry- und OpenClaw-Layer eines MCP-Servers anzeigen")
    .action(async (name: string) => {
      const { mcpShow } = await loadMcpModule();
      mcpShow(name);
    });
  mcp
    .command("activate-openclaw <name>")
    .description("Registrierten PIBo-MCP-Server explizit in OpenClaw aktivieren")
    .action(async (name: string) => {
      const { mcpActivateOpenClaw } = await loadMcpModule();
      mcpActivateOpenClaw(name);
    });
  mcp
    .command("deactivate-openclaw <name>")
    .description("MCP-Server aus OpenClaw entfernen, aber in der PIBo-Registry lassen")
    .action(async (name: string) => {
      const { mcpDeactivateOpenClaw } = await loadMcpModule();
      mcpDeactivateOpenClaw(name);
    });
  mcp
    .command("enable <name>")
    .description("Veraltet: Alias für activate-openclaw")
    .action(async (name: string) => {
      const { mcpEnable } = await loadMcpModule();
      mcpEnable(name);
    });
  mcp
    .command("disable <name>")
    .description("Veraltet: Alias für deactivate-openclaw")
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
    .description("Tool-Discovery aus der PIBo-Registry-Definition eines MCP-Servers erneuern")
    .action(async (name: string) => {
      const { mcpRefresh } = await loadMcpModule();
      await mcpRefresh(name);
    });
  mcp
    .command("doctor <name>")
    .description("PIBo-Registry, Cache, Runtime und OpenClaw-Aktivierung getrennt prüfen")
    .option("--refresh", "Am Ende Discovery-Cache aktiv erneuern")
    .action(async (name: string, opts: { refresh?: boolean }) => {
      const { mcpDoctor } = await loadMcpModule();
      await mcpDoctor(name, opts);
    });
  mcp
    .command("tools <name>")
    .description("Toolnamen eines registrierten PIBo-MCP-Servers anzeigen")
    .option("--refresh", "Discovery nicht aus Cache lesen")
    .action(async (name: string, opts: { refresh?: boolean }) => {
      const { mcpTools } = await loadMcpModule();
      await mcpTools(name, opts);
    });
  mcp
    .command("inspect <name> [tool]")
    .description("Discovery-Daten aus der PIBo-Registry oder ein einzelnes Tool inspizieren")
    .option("--refresh", "Discovery nicht aus Cache lesen")
    .action(async (name: string, tool: string | undefined, opts: { refresh?: boolean }) => {
      const { mcpInspect } = await loadMcpModule();
      await mcpInspect(name, tool, opts);
    });
  mcp
    .command("call [server] [tool]")
    .description("Generischer PIBo-MCP-JSON-Invoker mit Discovery-Help")
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

  const browserPool = pibo.command("browser-pool").description("Dev browser profile router");
  browserPool
    .command("status")
    .description("Show the state of the fixed dev browser profile pool")
    .option("--json", "Emit structured JSON output")
    .action(async (opts: { json?: boolean }) => {
      const { browserPoolStatus } = await loadBrowserPoolModule();
      await browserPoolStatus(opts);
    });
  browserPool
    .command("acquire")
    .description("Acquire the first free dev browser profile lease")
    .requiredOption("--agent-id <id>", "Agent id")
    .option("--workflow-run-id <id>", "Workflow run id")
    .option("--session-key <key>", "Session key")
    .option("--session-id <id>", "Session id")
    .option("--task <text>", "Optional task label")
    .option("--ttl-seconds <n>", `Lease TTL in seconds (default: 3600)`)
    .action(
      async (opts: {
        agentId?: string;
        workflowRunId?: string;
        sessionKey?: string;
        sessionId?: string;
        task?: string;
        ttlSeconds?: string;
      }) => {
        const { browserPoolAcquire } = await loadBrowserPoolModule();
        await browserPoolAcquire(opts);
      },
    );
  browserPool
    .command("heartbeat")
    .description("Extend a dev browser profile lease")
    .requiredOption("--browser-profile <name>", "Profile name")
    .requiredOption("--lease-id <id>", "Lease id")
    .option("--ttl-seconds <n>", `Lease TTL in seconds (default: 3600)`)
    .action(async (opts: { browserProfile?: string; leaseId?: string; ttlSeconds?: string }) => {
      const { browserPoolHeartbeat } = await loadBrowserPoolModule();
      await browserPoolHeartbeat({
        profile: opts.browserProfile,
        leaseId: opts.leaseId,
        ttlSeconds: opts.ttlSeconds,
      });
    });
  browserPool
    .command("release")
    .description("Stop the browser and release the lease for a dev profile")
    .requiredOption("--browser-profile <name>", "Profile name")
    .requiredOption("--lease-id <id>", "Lease id")
    .action(async (opts: { browserProfile?: string; leaseId?: string }) => {
      const { browserPoolRelease } = await loadBrowserPoolModule();
      await browserPoolRelease({ profile: opts.browserProfile, leaseId: opts.leaseId });
    });
  browserPool
    .command("sweep-stale")
    .description("Stop browsers for stale leases and release those profiles")
    .action(async () => {
      const { browserPoolSweepStale } = await loadBrowserPoolModule();
      await browserPoolSweepStale();
    });

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
      const { workflowsList } = await loadWorkflowReadOnlyModule();
      workflowsList({ json: opts.json });
    });
  workflows
    .command("describe <moduleId>")
    .description("Workflow-Modul beschreiben")
    .option("--json", "JSON-Ausgabe")
    .action(async (moduleId: string, opts: { json?: boolean }) => {
      const { workflowsDescribe } = await loadWorkflowReadOnlyModule();
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
