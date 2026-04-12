import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "../../../src/plugins/types.js";
import { resolveAgentIdFromSessionKey } from "../../../src/routing/session-key.js";

const PIBO_GUARDED_AGENT_IDS = new Set(["main"]);
const PIBO_RAW_SESSION_TOOL_NAMES = new Set(["sessions_spawn", "sessions_send", "subagents"]);

function resolveAgentId(ctx: PluginHookToolContext): string | undefined {
  if (typeof ctx.agentId === "string" && ctx.agentId.trim()) {
    return ctx.agentId.trim().toLowerCase();
  }
  return resolveAgentIdFromSessionKey(ctx.sessionKey)?.trim().toLowerCase();
}

export function shouldBlockPiboRawSessionTool(params: {
  agentId?: string;
  toolName?: string;
}): boolean {
  const agentId = params.agentId?.trim().toLowerCase();
  const toolName = params.toolName?.trim();
  if (!agentId || !toolName) {
    return false;
  }
  return PIBO_GUARDED_AGENT_IDS.has(agentId) && PIBO_RAW_SESSION_TOOL_NAMES.has(toolName);
}

export function handlePiboRawSessionToolGuard(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): PluginHookBeforeToolCallResult | void {
  const agentId = resolveAgentId(ctx);
  if (
    !shouldBlockPiboRawSessionTool({
      agentId,
      toolName: event.toolName,
    })
  ) {
    return;
  }

  return {
    block: true,
    blockReason:
      `Raw session tool "${event.toolName}" is disabled for PIBO agent "${agentId}". ` +
      "Use the PIBO orchestration layer instead of direct session tools.",
  };
}

export const __testing = {
  PIBO_GUARDED_AGENT_IDS,
  PIBO_RAW_SESSION_TOOL_NAMES,
};
