import { Type } from "@sinclair/typebox";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  describeSessionsHistoryTool,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSandboxedSessionToolContext,
  resolveVisibleSessionReference,
  stripToolMessages,
} from "./sessions-helpers.js";
import {
  capSessionHistoryMessages,
  sanitizeSessionHistoryMessages,
} from "./sessions-history-sanitize.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: Type.String(),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  includeTools: Type.Optional(Type.Boolean()),
});

type GatewayCaller = typeof callGateway;

// sandbox policy handling is shared with sessions-list-tool via sessions-helpers.ts

export function createSessionsHistoryTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    displaySummary: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsHistoryTool(),
    parameters: SessionsHistoryToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const sessionKeyParam = readStringParam(params, "sessionKey", {
        required: true,
      });
      const cfg = opts?.config ?? loadConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const resolvedSession = await resolveSessionReference({
        sessionKey: sessionKeyParam,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKeyParam,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          status: visibleSession.status,
          error: visibleSession.error,
        });
      }
      // From here on, use the canonical key (sessionId inputs already resolved).
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: access.error,
        });
      }

      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;
      const includeTools = Boolean(params.includeTools);
      const result = await gatewayCall<{ messages: Array<unknown> }>({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit },
      });
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const selectedMessages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      const sanitized = sanitizeSessionHistoryMessages(selectedMessages);
      const capped = capSessionHistoryMessages({
        messages: sanitized.messages,
      });
      return jsonResult({
        sessionKey: displayKey,
        messages: capped.messages,
        truncated: capped.truncated || sanitized.contentTruncated,
        droppedMessages: capped.droppedMessages,
        contentTruncated: sanitized.contentTruncated,
        contentRedacted: sanitized.contentRedacted,
        bytes: capped.bytes,
      });
    },
  };
}
