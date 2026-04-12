import { createDefaultDeps } from "../../../cli/deps.js";
import { coreGatewayHandlers } from "../../../gateway/server-methods.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";

type JsonRecord = Record<string, unknown>;

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

export async function callWorkflowGatewayMethod<T = unknown>(
  method: string,
  params: JsonRecord = {},
): Promise<T> {
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

export async function withSuppressedProcessOutput<T>(work: () => Promise<T>): Promise<T> {
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
