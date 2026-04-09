import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { parseCommandArgs } from "./parser.js";

const execFileAsync = promisify(execFile);

interface ModuleCommand {
  description: string;
  usage: string;
  handler: (ctx: PluginCommandContext, argument?: string, flags?: Record<string, string>) => Promise<string>;
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
  `  scan             Markdown-Dateien scannen und registrieren\n` +
  `  list             Registrierte Commands anzeigen\n` +
  `  get-dir          Aktuellen Command-Pfad anzeigen\n` +
  `  show <name>      Markdown-Inhalt eines Commands anzeigen`;

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
      scan: {
        description: "Markdown-Dateien scannen und registrieren",
        usage: "scan",
        handler: async () => handleCommandsSubcommand(["scan"]),
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
  const lines = ["🤖 **PIBo Command**\n", "Verwendung: `/pibo <module> <command> [argument] [--flags]`\n"];
  lines.push("**Module:**\n");
  for (const module of Object.values(commandRegistry)) {
    lines.push(
      `• **${module.name}** — ${module.description} (${Object.keys(module.commands).length} Commands)`,
    );
  }
  lines.push("\n**Beispiele:**");
  lines.push("  `/pibo agents task Suche nach KI-News heute`");
  lines.push("  `/pibo commands set-dir ~/.config/pibo/commands`");
  lines.push("  `/pibo commands scan`");
  return lines.join("\n");
}

export async function handlePiboCommand(
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
): Promise<string> {
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
