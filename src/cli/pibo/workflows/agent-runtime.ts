import { agentCommand } from "../../../agents/agent-command.js";
import {
  readLatestAssistantReplySnapshot,
  type AssistantReplySnapshot,
} from "../../../agents/run-wait.js";
import type { callGateway, CallGatewayOptions } from "../../../gateway/call.js";
import { createWorkflowAbortError, throwIfWorkflowAbortRequested } from "./abort.js";
import { callWorkflowGatewayMethod } from "./workflow-gateway.js";

const WORKFLOW_HISTORY_LIMIT = 100;
// Workflow runtime reuses assistant replies as machine state, so it must bypass
// the UI-safe 12k chat.history default while staying inside the RPC schema cap.
const WORKFLOW_HISTORY_MAX_CHARS = 500_000;
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
  abortSignal?: AbortSignal;
}): Promise<AssistantReplySnapshot> {
  const deadlineAt = Date.now() + TRANSCRIPT_SETTLE_WAIT_MS;
  let latest: AssistantReplySnapshot = {};

  while (Date.now() <= deadlineAt) {
    throwIfWorkflowAbortRequested(params.abortSignal);
    latest = await readLatestAssistantReplySnapshot({
      sessionKey: params.sessionKey,
      limit: WORKFLOW_HISTORY_LIMIT,
      maxChars: WORKFLOW_HISTORY_MAX_CHARS,
      callGateway: params.callGateway,
    });
    if (
      latest.text &&
      (!params.baseline.fingerprint || latest.fingerprint !== params.baseline.fingerprint)
    ) {
      return latest;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        params.abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      }, TRANSCRIPT_SETTLE_INTERVAL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        params.abortSignal?.removeEventListener("abort", onAbort);
        reject(createWorkflowAbortError(params.abortSignal?.reason));
      };
      params.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (params.abortSignal?.aborted) {
        onAbort();
      }
    });
  }

  return latest;
}

export async function runWorkflowAgentOnSession(params: {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  timeoutMs?: number;
  workspaceDir?: string;
  abortSignal?: AbortSignal;
}): Promise<{
  runId: string;
  text: string;
  wait: { status: "ok" | "error" | "timeout"; error?: string } | null;
  messages: unknown[];
}> {
  const callGateway = createWorkflowGatewayCaller();
  throwIfWorkflowAbortRequested(params.abortSignal);
  const baseline = await readLatestAssistantReplySnapshot({
    sessionKey: params.sessionKey,
    limit: WORKFLOW_HISTORY_LIMIT,
    maxChars: WORKFLOW_HISTORY_MAX_CHARS,
    callGateway,
  });
  throwIfWorkflowAbortRequested(params.abortSignal);
  const runId = params.idempotencyKey;
  const timeout =
    params.timeoutMs !== undefined
      ? String(Math.max(1, Math.ceil(params.timeoutMs / 1_000)))
      : undefined;
  const abortSession = async () => {
    await callWorkflowGatewayMethod("sessions.abort", {
      key: params.sessionKey,
      runId,
    }).catch(() => undefined);
  };
  const onAbort = () => {
    void abortSession();
  };
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (params.abortSignal?.aborted) {
    onAbort();
  }
  try {
    await agentCommand({
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: false,
      suppressRuntimeOutput: true,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      runId,
      ...(timeout ? { timeout } : {}),
      abortSignal: params.abortSignal,
    });
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
  }

  const settledReply =
    (
      await readUpdatedAssistantReplyWithRetry({
        sessionKey: params.sessionKey,
        baseline,
        callGateway,
        abortSignal: params.abortSignal,
      })
    ).text?.trim() || "";

  throwIfWorkflowAbortRequested(params.abortSignal);
  const history = await callWorkflowGatewayMethod<{ messages?: unknown[] }>("chat.history", {
    sessionKey: params.sessionKey,
    limit: WORKFLOW_HISTORY_LIMIT,
    maxChars: WORKFLOW_HISTORY_MAX_CHARS,
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
