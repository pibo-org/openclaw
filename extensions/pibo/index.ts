import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPiboDelegateContinueTool,
  createPiboDelegateStartTool,
  createPiboDelegateStatusTool,
} from "./src/delegate-tools.js";
import { registerDynamicPromptCommands } from "./src/dynamic-commands.js";
import { handlePiboRawSessionToolGuard } from "./src/raw-session-tool-guard.js";
import { handlePiboCommand } from "./src/router.js";

const PIBO_GLOBAL_SYSTEM_PROMPT_PATH = fileURLToPath(
  new URL("./pibo-global-system-prompt.md", import.meta.url),
);

function readPiboGlobalSystemPrompt(): string {
  const prompt = fs.readFileSync(PIBO_GLOBAL_SYSTEM_PROMPT_PATH, "utf8").trim();
  if (!prompt) {
    throw new Error(`pibo: global system prompt file is empty: ${PIBO_GLOBAL_SYSTEM_PROMPT_PATH}`);
  }
  return prompt;
}

const PIBO_GLOBAL_SYSTEM_PROMPT = readPiboGlobalSystemPrompt();

export default definePluginEntry({
  id: "pibo",
  name: "PIBo",
  description: "Bundled PIBO command/runtime integration",
  register(api) {
    api.logger.info?.("pibo: loading bundled extension");

    api.registerCommand({
      name: "pibo",
      description: "PIBo CLI — /pibo <module> <command> [args]",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx: PluginCommandContext) => ({ text: await handlePiboCommand(api, ctx) }),
    });

    api.registerTool(createPiboDelegateStartTool(api), {
      names: ["pibo_delegate_start"],
    });
    api.registerTool(createPiboDelegateContinueTool(api), {
      names: ["pibo_delegate_continue"],
    });
    api.registerTool(createPiboDelegateStatusTool(api), {
      names: ["pibo_delegate_status"],
    });

    registerDynamicPromptCommands(api);
    api.on("before_prompt_build", () => ({
      prependSystemContext: PIBO_GLOBAL_SYSTEM_PROMPT,
    }));
    api.on("before_tool_call", (event, ctx) => handlePiboRawSessionToolGuard(event, ctx));

    api.logger.info?.("pibo: bundled extension registered");
  },
});
