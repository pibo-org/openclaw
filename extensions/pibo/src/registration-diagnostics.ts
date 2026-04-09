import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PromptCommandEntry } from "./prompt-command-registry.js";
import { listCommandAliases } from "./prompt-command-registry.js";

const RESERVED_COMMANDS = new Set([
  "help",
  "commands",
  "status",
  "whoami",
  "context",
  "btw",
  "stop",
  "restart",
  "reset",
  "new",
  "compact",
  "config",
  "debug",
  "allowlist",
  "activation",
  "skill",
  "subagents",
  "kill",
  "steer",
  "tell",
  "model",
  "models",
  "queue",
  "send",
  "bash",
  "exec",
  "think",
  "verbose",
  "reasoning",
  "elevated",
  "usage",
]);

function validateCommandName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) {
    return "empty";
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "invalid-format";
  }
  if (RESERVED_COMMANDS.has(trimmed)) {
    return "reserved";
  }
  return null;
}

export type CommandRegistrationCandidate = {
  entry: PromptCommandEntry;
  aliases: string[];
};

export function buildRegistrationCandidates(commands: Record<string, PromptCommandEntry>): {
  accepted: CommandRegistrationCandidate[];
  skipped: Array<{ name: string; reason: string }>;
} {
  const accepted: CommandRegistrationCandidate[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const seen = new Map<string, string>();

  for (const name of Object.keys(commands).toSorted()) {
    const entry = commands[name];
    const aliases = listCommandAliases(entry.name, entry.meta);
    const invalidAlias = aliases.find((alias) => validateCommandName(alias));
    if (invalidAlias) {
      skipped.push({ name, reason: `invalid alias: ${invalidAlias}` });
      continue;
    }
    const collision = aliases.find((alias) => seen.has(alias));
    if (collision) {
      skipped.push({
        name,
        reason: `alias collision on ${collision} with ${seen.get(collision)}`,
      });
      continue;
    }
    for (const alias of aliases) {
      seen.set(alias, entry.name);
    }
    accepted.push({ entry, aliases });
  }

  return { accepted, skipped };
}

export function logRegistrationSummary(
  api: OpenClawPluginApi,
  params: {
    commandDir: string;
    accepted: CommandRegistrationCandidate[];
    skipped: Array<{ name: string; reason: string }>;
  },
): void {
  for (const item of params.accepted) {
    api.logger.info?.(
      `pibo: registered dynamic command ${item.entry.name} aliases=[${item.aliases.join(", ")}] behavior=${item.entry.meta.behavior ?? "mode"} file=${item.entry.file}`,
    );
  }
  for (const item of params.skipped) {
    api.logger.warn?.(`pibo: skipped dynamic command ${item.name}: ${item.reason}`);
  }
  api.logger.info?.(
    `pibo: dynamic command scan complete accepted=${params.accepted.length} skipped=${params.skipped.length} dir=${params.commandDir}`,
  );
}
