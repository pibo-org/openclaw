import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { parseCommandArgs } from "./parser.js";
import { runPiboWorkflows } from "./workflow-runtime.js";

const execFileAsync = promisify(execFile);
let currentWorkflowApi: OpenClawPluginApi | null = null;

interface ModuleCommand {
  description: string;
  usage: string;
  handler: (
    ctx: PluginCommandContext,
    argument?: string,
    flags?: Record<string, string>,
  ) => Promise<string>;
}

interface CommandModule {
  name: string;
  description: string;
  commands: Record<string, ModuleCommand>;
  help: () => string;
}

async function runOpenClawPibo(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("openclaw", ["pibo", ...args], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  const text = stdout.trim() || stderr.trim();
  return text.length > 0 ? text : "⚠️ Keine Ausgabe erhalten.";
}

async function handleAgentsTask(
  prompt: string | undefined,
  flags: Record<string, string> | undefined,
): Promise<string> {
  if (!prompt?.trim()) {
    return "❌ Bitte gib einen Prompt an.\n\nVerwendung: `/pibo agents task <beschreibung>`";
  }
  const args = ["agents", "task", prompt.trim()];
  for (const [key, value] of Object.entries(flags ?? {})) {
    args.push(`--${key}`);
    if (value !== "true") {
      args.push(value);
    }
  }
  try {
    return await runOpenClawPibo(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ agents task fehlgeschlagen:\n\n\`\`\`\n${message}\n\`\`\``;
  }
}

async function handleCommandsSubcommand(args: string[]): Promise<string> {
  try {
    const text = await runOpenClawPibo(["commands", ...args]);
    return text.length > 3900 ? `${text.slice(0, 3900)}\n\n… gekürzt` : text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ commands fehlgeschlagen:\n\n\`\`\`\n${message}\n\`\`\``;
  }
}

async function handleWorkflowsSubcommand(args: string[]): Promise<string> {
  try {
    if (!currentWorkflowApi) {
      throw new Error("workflow runtime API is not initialized");
    }
    const text = await runPiboWorkflows(currentWorkflowApi, args);
    return text.length > 3900 ? `${text.slice(0, 3900)}\n\n… gekürzt` : text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ workflows fehlgeschlagen:\n\n\`\`\`\n${message}\n\`\`\``;
  }
}

function parseWorkflowStartArgument(argument: string | undefined): {
  moduleId?: string;
  inputJson?: string;
} {
  const trimmed = argument?.trim();
  if (!trimmed) {
    return {};
  }
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { moduleId: trimmed };
  }
  return {
    moduleId: trimmed.slice(0, firstSpace).trim() || undefined,
    inputJson: trimmed.slice(firstSpace + 1).trim() || undefined,
  };
}

const helpAgents = (): string =>
  `Agents — Task-Verwaltung\n\n` +
  `Befehle:\n` +
  `  task <prompt> [--flags]  Neuer Agent-Task\n\n` +
  `Beispiel:\n` +
  `  /pibo agents task Suche nach KI-News heute`;

const helpCommands = (): string =>
  `Commands — Markdown-basierte Slash Commands\n\n` +
  `Befehle:\n` +
  `  set-dir <pfad>   Command-Verzeichnis setzen\n` +
  `  list             Registrierte Commands anzeigen\n` +
  `  get-dir          Aktuellen Command-Pfad anzeigen\n` +
  `  show <name>      Markdown-Inhalt eines Commands anzeigen`;

const helpWorkflows = (): string =>
  `Workflows — generische PIBO Workflow-Module\n\n` +
  `Befehle:\n` +
  `  list                        Registrierte Workflow-Module anzeigen\n` +
  `  describe <moduleId>         Manifest eines Moduls anzeigen\n` +
  `  start <moduleId> [json]     Workflow-Run starten\n` +
  `  status <runId>              Status eines Runs anzeigen\n` +
  `  abort <runId>               Run abbrechen, falls unterstützt\n` +
  `  runs                        Letzte Runs anzeigen\n\n` +
  `Beispiele:\n` +
  `  /pibo workflows list\n` +
  `  /pibo workflows describe langgraph_worker_critic\n` +
  `  /pibo workflows start langgraph_worker_critic {"task":"...","successCriteria":["..."]}\n` +
  `  /pibo workflows status <runId>`;

const commandRegistry: Record<string, CommandModule> = {
  agents: {
    name: "agents",
    description: "Agent Task Management via PIBO CLI",
    commands: {
      task: {
        description: "Neuen One-Shot Agent-Task erstellen",
        usage: "task <prompt> [--flags]",
        handler: async (_ctx, argument, flags) => handleAgentsTask(argument, flags),
      },
    },
    help: helpAgents,
  },
  commands: {
    name: "commands",
    description: "Markdown-basierte Slash Commands verwalten",
    commands: {
      "set-dir": {
        description: "Command-Verzeichnis setzen",
        usage: "set-dir <pfad>",
        handler: async (_ctx, argument) =>
          argument?.trim()
            ? handleCommandsSubcommand(["set-dir", argument.trim()])
            : "❌ Bitte gib ein Verzeichnis an.\n\nVerwendung: `/pibo commands set-dir <pfad>`",
      },
      list: {
        description: "Registrierte Commands anzeigen",
        usage: "list",
        handler: async () => handleCommandsSubcommand(["list"]),
      },
      "get-dir": {
        description: "Aktuelles Command-Verzeichnis anzeigen",
        usage: "get-dir",
        handler: async () => handleCommandsSubcommand(["get-dir"]),
      },
      show: {
        description: "Markdown-Inhalt eines Commands anzeigen",
        usage: "show <name>",
        handler: async (_ctx, argument) =>
          argument?.trim()
            ? handleCommandsSubcommand(["show", argument.trim()])
            : "❌ Bitte gib einen Command-Namen an.\n\nVerwendung: `/pibo commands show <name>`",
      },
    },
    help: helpCommands,
  },
  workflows: {
    name: "workflows",
    description: "Generische PIBO Workflow-Module starten und verwalten",
    commands: {
      list: {
        description: "Registrierte Workflow-Module anzeigen",
        usage: "list",
        handler: async () => handleWorkflowsSubcommand(["list"]),
      },
      describe: {
        description: "Manifest eines Workflow-Moduls anzeigen",
        usage: "describe <moduleId>",
        handler: async (_ctx, argument) =>
          argument?.trim()
            ? handleWorkflowsSubcommand(["describe", argument.trim()])
            : "❌ Bitte gib eine moduleId an.\n\nVerwendung: `/pibo workflows describe <moduleId>`",
      },
      start: {
        description: "Workflow-Run starten",
        usage: "start <moduleId> [json] [--max-rounds <n>]",
        handler: async (_ctx, argument, flags) => {
          const parsed = parseWorkflowStartArgument(argument);
          if (!parsed.moduleId) {
            return "❌ Bitte gib eine moduleId an.\n\nVerwendung: `/pibo workflows start <moduleId> [json] [--max-rounds <n>]`";
          }
          const args = ["start", parsed.moduleId];
          if (parsed.inputJson) {
            args.push("--json", parsed.inputJson);
          }
          if (flags?.["max-rounds"]) {
            args.push("--max-rounds", flags["max-rounds"]);
          }
          return handleWorkflowsSubcommand(args);
        },
      },
      status: {
        description: "Status eines Workflow-Runs anzeigen",
        usage: "status <runId>",
        handler: async (_ctx, argument) =>
          argument?.trim()
            ? handleWorkflowsSubcommand(["status", argument.trim()])
            : "❌ Bitte gib eine runId an.\n\nVerwendung: `/pibo workflows status <runId>`",
      },
      abort: {
        description: "Workflow-Run abbrechen",
        usage: "abort <runId>",
        handler: async (_ctx, argument) =>
          argument?.trim()
            ? handleWorkflowsSubcommand(["abort", argument.trim()])
            : "❌ Bitte gib eine runId an.\n\nVerwendung: `/pibo workflows abort <runId>`",
      },
      runs: {
        description: "Zuletzt gespeicherte Workflow-Runs anzeigen",
        usage: "runs [--limit <n>]",
        handler: async (_ctx, _argument, flags) => {
          const args = ["runs"];
          if (flags?.limit) {
            args.push("--limit", flags.limit);
          }
          return handleWorkflowsSubcommand(args);
        },
      },
    },
    help: helpWorkflows,
  },
};

function buildKnownPaths(): string[] {
  const paths: string[] = [];
  for (const [moduleName, module] of Object.entries(commandRegistry)) {
    for (const commandName of Object.keys(module.commands)) {
      paths.push(`${moduleName}/${commandName}`);
    }
  }
  return paths;
}

const knownPaths = buildKnownPaths();

function generateHelpMessage(): string {
  const lines = [
    "🤖 **PIBo Command**\n",
    "Verwendung: `/pibo <module> <command> [argument] [--flags]`\n",
  ];
  lines.push("**Module:**\n");
  for (const module of Object.values(commandRegistry)) {
    lines.push(
      `• **${module.name}** — ${module.description} (${Object.keys(module.commands).length} Commands)`,
    );
  }
  lines.push("\n**Beispiele:**");
  lines.push("  `/pibo agents task Suche nach KI-News heute`");
  lines.push("  `/pibo commands set-dir ~/.config/pibo/commands`");
  lines.push("  `/pibo commands list`");
  lines.push("  `/pibo workflows list`");
  return lines.join("\n");
}

export async function handlePiboCommand(
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
): Promise<string> {
  currentWorkflowApi = api;
  const raw = ctx.args?.trim() ?? "";
  api.logger.info?.(
    `pibo: /pibo invoked channel=${ctx.channel} sender=${ctx.senderId ?? "unknown"} rawArgs="${raw}"`,
  );

  if (!raw) {
    return generateHelpMessage();
  }

  const parsed = parseCommandArgs(raw, knownPaths);
  api.logger.info?.(
    `pibo: parsed module=${parsed.module} submodules=${parsed.submodules.join("/")} command=${parsed.command} arg="${parsed.argument ?? ""}" flags=${JSON.stringify(parsed.flags)}`,
  );

  if (!parsed.module && !parsed.command) {
    return generateHelpMessage();
  }

  if (parsed.command === "help" || (parsed.module === "help" && !parsed.command)) {
    if (parsed.module === "help") {
      return generateHelpMessage();
    }
    const module = commandRegistry[parsed.module];
    return module ? module.help() : generateHelpMessage();
  }

  const module = commandRegistry[parsed.module];
  if (!module) {
    return `❌ Unbekanntes Modul: "${parsed.module}"\n\n${generateHelpMessage()}`;
  }

  const command = module.commands[parsed.command];
  if (!command) {
    return `❌ Unbekannter Command: "${parsed.command}"\n\n${module.help()}`;
  }

  try {
    return await command.handler(ctx, parsed.argument, parsed.flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ Fehler beim Ausführen des Commands:\n\n\`\`\`\n${message}\n\`\`\``;
  }
}
