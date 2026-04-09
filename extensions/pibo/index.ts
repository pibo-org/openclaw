import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerDynamicPromptCommands } from "./src/dynamic-commands.js";
import { handlePiboCommand } from "./src/router.js";
import {
  createPiboWorkflowAbortTool,
  createPiboWorkflowDescribeTool,
  createPiboWorkflowStartTool,
  createPiboWorkflowStatusTool,
} from "./src/workflow-tools.js";

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

    api.registerTool(createPiboWorkflowStartTool(api), {
      names: ["pibo_workflow_start"],
    });
    api.registerTool(createPiboWorkflowStatusTool(api), {
      names: ["pibo_workflow_status"],
    });
    api.registerTool(createPiboWorkflowAbortTool(api), {
      names: ["pibo_workflow_abort"],
    });
    api.registerTool(createPiboWorkflowDescribeTool(api), {
      names: ["pibo_workflow_describe"],
    });

    registerDynamicPromptCommands(api);

    api.logger.info?.("pibo: bundled extension registered");
  },
});
