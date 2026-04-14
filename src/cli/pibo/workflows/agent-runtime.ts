import { agentCommand } from "../../../agents/agent-command.js";
import {
  readLatestAssistantReplySnapshot,
  type AssistantReplySnapshot,
} from "../../../agents/run-wait.js";
import type { callGateway, CallGatewayOptions } from "../../../gateway/call.js";
import { callWorkflowGatewayMethod } from "./workflow-gateway.js";

const WORKFLOW_HISTORY_LIMIT = 100;
const TRANSCRIPT_SETTLE_WAIT_MS = 1_500;
const TRANSCRIPT_SETTLE_INTERVAL_MS = 100;

type GatewayCaller = typeof callGateway;

function createWorkflowGatewayCaller(): GatewayCaller {
  return async <T = unknown>(request: CallGatewayOptions) =>
    await callWorkflowGatewayMethod<T>(
      request.method,
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {},
    );
}

async function readUpdatedAssistantReplyWithRetry(params: {
  sessionKey: string;
  baseline: AssistantReplySnapshot;
  callGateway: GatewayCaller;
}): Promise<AssistantReplySnapshot> {
  const deadlineAt = Date.now() + TRANSCRIPT_SETTLE_WAIT_MS;
  let latest: AssistantReplySnapshot = {};

  while (Date.now() <= deadlineAt) {
    latest = await readLatestAssistantReplySnapshot({
      sessionKey: params.sessionKey,
      limit: WORKFLOW_HISTORY_LIMIT,
      callGateway: params.callGateway,
    });
    if (
      latest.text &&
      (!params.baseline.fingerprint || latest.fingerprint !== params.baseline.fingerprint)
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_SETTLE_INTERVAL_MS));
  }

  return latest;
}

export async function runWorkflowAgentOnSession(params: {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  timeoutMs?: number;
  workspaceDir?: string;
}): Promise<{
  runId: string;
  text: string;
  wait: { status: "ok" | "error" | "timeout"; error?: string } | null;
  messages: unknown[];
}> {
  const callGateway = createWorkflowGatewayCaller();
  const baseline = await readLatestAssistantReplySnapshot({
    sessionKey: params.sessionKey,
    limit: WORKFLOW_HISTORY_LIMIT,
    callGateway,
  });
  const runId = params.idempotencyKey;
  const timeout =
    params.timeoutMs !== undefined
      ? String(Math.max(1, Math.ceil(params.timeoutMs / 1_000)))
      : undefined;
  await agentCommand({
    sessionKey: params.sessionKey,
    message: params.message,
    deliver: false,
    suppressRuntimeOutput: true,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    runId,
    ...(timeout ? { timeout } : {}),
  });

  const settledReply =
    (
      await readUpdatedAssistantReplyWithRetry({
        sessionKey: params.sessionKey,
        baseline,
        callGateway,
      })
    ).text?.trim() || "";

  const history = await callWorkflowGatewayMethod<{ messages?: unknown[] }>("chat.history", {
    sessionKey: params.sessionKey,
    limit: WORKFLOW_HISTORY_LIMIT,
  });
  if (!settledReply) {
    throw new Error(`No assistant output found in session ${params.sessionKey}.`);
  }

  return {
    runId,
    text: settledReply,
    wait: { status: "ok" },
    messages: history.messages ?? [],
  };
}
