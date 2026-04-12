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
import {
  createPiboWorkflowArtifactTool,
  createPiboWorkflowArtifactsTool,
  createPiboWorkflowAbortTool,
  createPiboWorkflowDescribeTool,
  createPiboWorkflowProgressTool,
  createPiboWorkflowStartAsyncTool,
  createPiboWorkflowStartTool,
  createPiboWorkflowStatusTool,
  createPiboWorkflowTraceEventsTool,
  createPiboWorkflowTraceSummaryTool,
  createPiboWorkflowWaitTool,
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
    api.registerTool(createPiboWorkflowStartAsyncTool(api), {
      names: ["pibo_workflow_start_async"],
    });
    api.registerTool(createPiboWorkflowStatusTool(api), {
      names: ["pibo_workflow_status"],
    });
    api.registerTool(createPiboWorkflowProgressTool(api), {
      names: ["pibo_workflow_progress"],
    });
    api.registerTool(createPiboWorkflowWaitTool(api), {
      names: ["pibo_workflow_wait"],
    });
    api.registerTool(createPiboWorkflowAbortTool(api), {
      names: ["pibo_workflow_abort"],
    });
    api.registerTool(createPiboWorkflowDescribeTool(api), {
      names: ["pibo_workflow_describe"],
    });
    api.registerTool(createPiboWorkflowTraceSummaryTool(api), {
      names: ["pibo_workflow_trace_summary"],
    });
    api.registerTool(createPiboWorkflowTraceEventsTool(api), {
      names: ["pibo_workflow_trace_events"],
    });
    api.registerTool(createPiboWorkflowArtifactsTool(api), {
      names: ["pibo_workflow_artifacts"],
    });
    api.registerTool(createPiboWorkflowArtifactTool(api), {
      names: ["pibo_workflow_artifact"],
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
    api.on("before_tool_call", (event, ctx) => handlePiboRawSessionToolGuard(event, ctx));

    api.logger.info?.("pibo: bundled extension registered");
  },
});
