import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildNativeNames, loadRegistry } from "./prompt-command-registry.js";
import { buildRegistrationCandidates, logRegistrationSummary } from "./registration-diagnostics.js";
import { runMarkdownCommandByName } from "./run-markdown-command.js";

export function registerDynamicPromptCommands(api: OpenClawPluginApi): void {
  const registry = loadRegistry();
  const { accepted, skipped } = buildRegistrationCandidates(registry.commands);

  for (const item of accepted) {
    const entry = item.entry;
    api.registerCommand({
      name: entry.name,
      nativeNames: buildNativeNames(entry.name, entry.meta),
      description: entry.description || `PIBo Prompt Command: ${entry.name}`,
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx: PluginCommandContext) => runMarkdownCommandByName(api, entry.name, ctx),
    });
  }

  if (process.env.PIBO_DYNAMIC_COMMAND_DEBUG === "1") {
    logRegistrationSummary(api, {
      commandDir: registry.commandDir,
      accepted,
      skipped,
    });
  }
}
