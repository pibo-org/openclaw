import { agentCommand } from "../../../agents/agent-command.js";
import {
  readLatestAssistantReplySnapshot,
  type AssistantReplySnapshot,
} from "../../../agents/run-wait.js";
import { callWorkflowGatewayMethod } from "./workflow-gateway.js";

const WORKFLOW_HISTORY_LIMIT = 100;
const TRANSCRIPT_SETTLE_WAIT_MS = 1_500;
const TRANSCRIPT_SETTLE_INTERVAL_MS = 100;

type GatewayCaller = <T = unknown>(params: {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<T>;

function createWorkflowGatewayCaller(): GatewayCaller {
  return async <T = unknown>(request: {
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }) => await callWorkflowGatewayMethod<T>(request.method, request.params ?? {});
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
  await agentCommand({
    sessionKey: params.sessionKey,
    message: params.message,
    deliver: false,
    suppressRuntimeOutput: true,
    runId,
    timeout: Math.max(1, Math.ceil((params.timeoutMs ?? 120_000) / 1_000)),
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
