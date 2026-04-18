import { loadConfig, type OpenClawConfig } from "../../../config/config.js";
import { resolveOutboundChannelPlugin } from "../../../infra/outbound/channel-resolution.js";
import { deliverOutboundPayloads } from "../../../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../../../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../../../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../../../infra/outbound/targets.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { normalizeAccountId } from "../../../utils/account-id.js";
import { isDeliverableMessageChannel } from "../../../utils/message-channel.js";
import type { WorkflowTraceRuntime } from "./tracing/runtime.js";
import type { WorkflowOriginContext, WorkflowReportingConfig } from "./types.js";

const log = createSubsystemLogger("pibo/workflow-reporting");

export type WorkflowReportEventType = "started" | "milestone" | "blocked" | "completed";

export type WorkflowReportEvent = {
  moduleId: string;
  runId: string;
  phase: string;
  eventType: WorkflowReportEventType;
  messageText: string;
  emittingAgentId: string;
  origin?: WorkflowOriginContext;
  reporting?: WorkflowReportingConfig;
  status?: "running" | "blocked" | "done" | "planning_done" | "failed" | "max_rounds_reached";
  role?: string;
  round?: number;
  targetSessionKey?: string;
  cfg?: OpenClawConfig;
};

export type WorkflowReportDeliveryResult = {
  attempted: boolean;
  delivered: boolean;
  skipped?: string;
  error?: string;
  channel?: string;
  to?: string;
  accountId?: string;
};

export type TracedWorkflowReportEvent = WorkflowReportEvent & {
  trace?: WorkflowTraceRuntime;
  stepId?: string;
  traceSummary?: string;
};

function formatRunRef(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function buildWorkflowHeader(params: {
  moduleId: string;
  phase: string;
  runId: string;
  round?: number;
  role?: string;
  status?: WorkflowReportEvent["status"];
}): string {
  const parts = [
    `Workflow: ${params.moduleId}`,
    `Phase: ${params.phase}`,
    `Run: ${formatRunRef(params.runId)}`,
    ...(typeof params.round === "number" ? [`Round: ${params.round}`] : []),
    ...(params.role ? [`Role: ${params.role}`] : []),
    ...(params.status ? [`Status: ${params.status}`] : []),
  ];
  return `[${parts.join(" | ")}]`;
}

async function resolveVisibleAccountId(params: {
  cfg: OpenClawConfig;
  channel: string;
  originAccountId?: string;
  emittingAgentId: string;
}): Promise<string | undefined> {
  const originAccountId = normalizeAccountId(params.originAccountId);
  const candidateAccountId = normalizeAccountId(params.emittingAgentId);
  if (!candidateAccountId) {
    return originAccountId;
  }
  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
  });
  if (!plugin) {
    return originAccountId;
  }

  const accountIds = new Set(
    plugin.config.listAccountIds(params.cfg).map((accountId) => normalizeAccountId(accountId)),
  );
  if (!accountIds.has(candidateAccountId)) {
    return originAccountId;
  }

  try {
    const account = plugin.config.resolveAccount(params.cfg, candidateAccountId);
    if (plugin.config.isEnabled && !plugin.config.isEnabled(account, params.cfg)) {
      return originAccountId;
    }
    if (plugin.config.isConfigured) {
      const configured = await plugin.config.isConfigured(account, params.cfg);
      if (!configured) {
        return originAccountId;
      }
    }
    return candidateAccountId;
  } catch (error) {
    log.warn(
      `workflow report account resolution failed for ${params.channel}:${candidateAccountId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return originAccountId;
  }
}

function shouldEmitWorkflowReport(params: {
  eventType: WorkflowReportEventType;
  reporting?: WorkflowReportingConfig;
}): boolean {
  if (!params.reporting) {
    return false;
  }
  if (params.reporting.deliveryMode && params.reporting.deliveryMode !== "topic_origin") {
    return false;
  }
  if (Array.isArray(params.reporting.events) && params.reporting.events.length > 0) {
    return params.reporting.events.includes(params.eventType);
  }
  return false;
}

export async function emitWorkflowReportEvent(
  params: WorkflowReportEvent,
): Promise<WorkflowReportDeliveryResult> {
  const messageText = params.messageText.trim();
  if (!messageText) {
    return { attempted: false, delivered: false, skipped: "empty-message" };
  }
  if (!shouldEmitWorkflowReport({ eventType: params.eventType, reporting: params.reporting })) {
    return { attempted: false, delivered: false, skipped: "event-disabled" };
  }
  const origin = params.origin;
  if (!origin?.channel || !origin.to) {
    return { attempted: false, delivered: false, skipped: "missing-origin" };
  }
  if (!isDeliverableMessageChannel(origin.channel)) {
    return {
      attempted: false,
      delivered: false,
      skipped: "unsupported-channel",
    };
  }

  const cfg = params.cfg ?? loadConfig();
  const resolvedAccountId = await resolveVisibleAccountId({
    cfg,
    channel: origin.channel,
    originAccountId: origin.accountId,
    emittingAgentId: params.emittingAgentId,
  });
  const resolvedTarget = resolveOutboundTarget({
    channel: origin.channel,
    to: origin.to,
    cfg,
    accountId: resolvedAccountId,
    mode: "explicit",
  });
  if (!resolvedTarget.ok) {
    const error =
      resolvedTarget.error instanceof Error
        ? resolvedTarget.error.message
        : String(resolvedTarget.error);
    log.warn(`workflow report target resolution failed: ${error}`);
    return {
      attempted: true,
      delivered: false,
      error,
      channel: origin.channel,
      to: origin.to,
      accountId: resolvedAccountId,
    };
  }

  const content = `${buildWorkflowHeader({
    moduleId: params.moduleId,
    phase: params.phase,
    runId: params.runId,
    round: params.round,
    role: params.role,
    status: params.status,
  })}\n\n${messageText}`;

  try {
    await deliverOutboundPayloads({
      cfg,
      channel: origin.channel,
      to: resolvedTarget.to,
      accountId: resolvedAccountId,
      threadId: origin.threadId,
      payloads: [{ text: content }],
      session: buildOutboundSessionContext({
        cfg,
        sessionKey: params.targetSessionKey,
        agentId: params.emittingAgentId,
      }),
      mirror: params.targetSessionKey
        ? {
            sessionKey: params.targetSessionKey,
            agentId: params.emittingAgentId,
            text: content,
            idempotencyKey: [
              "workflow-report",
              params.runId,
              params.eventType,
              params.phase,
              params.round != null ? String(params.round) : "",
              params.status ?? "",
              params.emittingAgentId,
            ]
              .filter(Boolean)
              .join(":"),
          }
        : undefined,
      identity: resolveAgentOutboundIdentity(cfg, params.emittingAgentId),
      bestEffort: false,
    });
    return {
      attempted: true,
      delivered: true,
      channel: origin.channel,
      to: resolvedTarget.to,
      accountId: resolvedAccountId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`workflow report delivery failed: ${message}`);
    return {
      attempted: true,
      delivered: false,
      error: message,
      channel: origin.channel,
      to: resolvedTarget.to,
      accountId: resolvedAccountId,
    };
  }
}

export async function emitTracedWorkflowReportEvent(
  params: TracedWorkflowReportEvent,
): Promise<WorkflowReportDeliveryResult> {
  params.trace?.emit({
    kind: "report_delivery_attempted",
    stepId: params.stepId,
    round: params.round,
    role: params.role,
    status: params.status,
    summary:
      params.traceSummary ?? `report ${params.eventType} for phase ${params.phase} attempted`,
    payload: {
      eventType: params.eventType,
      phase: params.phase,
      channel: params.origin?.channel,
      to: params.origin?.to,
      accountId: params.origin?.accountId,
    },
  });

  const result = await emitWorkflowReportEvent(params);

  params.trace?.emit({
    kind: result.delivered ? "report_delivered" : "report_failed",
    stepId: params.stepId,
    round: params.round,
    role: params.role,
    status: params.status,
    summary: result.delivered
      ? (params.traceSummary ?? `report ${params.eventType} delivered`)
      : (result.error ?? result.skipped ?? `report ${params.eventType} not delivered`),
    payload: {
      eventType: params.eventType,
      phase: params.phase,
      attempted: result.attempted,
      delivered: result.delivered,
      skipped: result.skipped,
      error: result.error,
      channel: result.channel,
      to: result.to,
      accountId: result.accountId,
    },
  });

  return result;
}
