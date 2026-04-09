import { createDefaultDeps } from "../../../cli/deps.js";
import { coreGatewayHandlers } from "../../../gateway/server-methods.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createRuntimeManagedSessions } from "../../../plugins/runtime/runtime-managed-sessions.js";

type JsonRecord = Record<string, unknown>;

const unavailableSubagent = {
  async run() {
    throw new Error("workflow agent runtime cannot use plugin subagent.run");
  },
  async waitForRun() {
    throw new Error("workflow agent runtime cannot use plugin subagent.waitForRun");
  },
  async getSessionMessages() {
    throw new Error("workflow agent runtime cannot use plugin subagent.getSessionMessages");
  },
  async getSession() {
    throw new Error("workflow agent runtime cannot use plugin subagent.getSession");
  },
  async deleteSession() {
    throw new Error("workflow agent runtime cannot use plugin subagent.deleteSession");
  },
};

const managedSessions = createRuntimeManagedSessions(unavailableSubagent);

function createMinimalGatewayContext(): GatewayRequestContext {
  return {
    deps: createDefaultDeps(),
    cron: {} as GatewayRequestContext["cron"],
    cronStorePath: "/tmp/openclaw-cron.json",
    loadGatewayModelCatalog: async () => [],
    getHealthCache: () => null,
    refreshHealthSnapshot: async () =>
      ({ ok: true }) as unknown as Awaited<
        ReturnType<GatewayRequestContext["refreshHealthSnapshot"]>
      >,
    logHealth: { error: () => {} },
    logGateway: {
      subsystem: "workflow-cli",
      isEnabled: () => false,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: () => undefined,
      withBindings: () => undefined,
    } as unknown as GatewayRequestContext["logGateway"],
    incrementPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    broadcast: () => {},
    broadcastToConnIds: () => {},
    nodeSendToSession: () => {},
    nodeSendToAllSubscribed: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    nodeUnsubscribeAll: () => {},
    hasConnectedMobileNode: () => false,
    nodeRegistry: {} as GatewayRequestContext["nodeRegistry"],
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    addChatRun: () => {},
    removeChatRun: () => undefined,
    subscribeSessionEvents: () => {},
    unsubscribeSessionEvents: () => {},
    subscribeSessionMessageEvents: () => {},
    unsubscribeSessionMessageEvents: () => {},
    unsubscribeAllSessionEvents: () => {},
    getSessionEventSubscriberConnIds: () => new Set(),
    registerToolEventRecipient: () => {},
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: () => null,
    purgeWizardSession: () => {},
    getRuntimeSnapshot: () =>
      ({ channels: [] }) as unknown as ReturnType<GatewayRequestContext["getRuntimeSnapshot"]>,
    startChannel: async () => {},
    stopChannel: async () => {},
    markChannelLoggedOut: () => {},
    wizardRunner: async () => {},
    broadcastVoiceWakeChanged: () => {},
  };
}

async function callGatewayMethod<T = unknown>(method: string, params: JsonRecord = {}) {
  const handler = coreGatewayHandlers[method];
  if (!handler) {
    throw new Error(`Unknown gateway method: ${method}`);
  }

  let result: { ok: boolean; payload?: unknown; error?: { message?: string } } | undefined;
  await handler({
    req: { type: "req", id: `workflow-cli-${Date.now()}`, method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error: error as { message?: string } | undefined };
    },
    context: createMinimalGatewayContext(),
  });

  if (!result) {
    throw new Error(`Gateway method ${method} returned no result`);
  }
  if (!result.ok) {
    throw new Error(result.error?.message ?? `Gateway method ${method} failed`);
  }
  return result.payload as T;
}

async function withSuppressedProcessOutput<T>(work: () => Promise<T>): Promise<T> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  const swallow = (() => true) as typeof process.stdout.write;
  process.stdout.write = swallow;
  process.stderr.write = swallow;

  try {
    return await work();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

type TranscriptMessage = {
  role?: unknown;
  content?: unknown;
};

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (!item || typeof item !== "object") {
        return "";
      }
      const text =
        typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : typeof (item as { content?: unknown }).content === "string"
            ? ((item as { content: string }).content ?? "")
            : "";
      return text.trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractLatestAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as TranscriptMessage | null | undefined;
    if (message?.role !== "assistant") {
      continue;
    }
    const text = contentToText(message.content);
    if (text) {
      return text;
    }
  }
  return "";
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
  const { run, wait, session, text } = await withSuppressedProcessOutput(async () => {
    const run = await callGatewayMethod<{ runId?: string }>("agent", {
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: false,
      suppressRuntimeOutput: true,
      idempotencyKey: params.idempotencyKey,
    });

    if (!run.runId) {
      throw new Error(`Workflow agent run on ${params.sessionKey} returned no runId.`);
    }

    const wait = await callGatewayMethod<{
      status?: "ok" | "error" | "timeout";
      error?: string;
    }>("agent.wait", {
      runId: run.runId,
      timeoutMs: params.timeoutMs ?? 120_000,
    });
    const session = await managedSessions.get({ key: params.sessionKey, limit: 200 });
    return {
      run,
      wait,
      session,
      text: extractLatestAssistantText(session.messages),
    };
  });

  const normalizedWait = {
    status: wait.status ?? "timeout",
    ...(typeof wait.error === "string" && wait.error ? { error: wait.error } : {}),
  } satisfies { status: "ok" | "error" | "timeout"; error?: string };

  if (normalizedWait.status === "error") {
    throw new Error(
      normalizedWait.error || `Workflow agent run failed on session ${params.sessionKey}.`,
    );
  }
  if (!text) {
    throw new Error(`No assistant output found in session ${params.sessionKey}.`);
  }

  return {
    runId: run.runId!,
    text,
    wait: normalizedWait,
    messages: session.messages,
  };
}
