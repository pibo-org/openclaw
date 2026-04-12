import { createDefaultDeps } from "../cli/deps.js";
import { coreGatewayHandlers } from "../gateway/server-methods.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { asNullableRecord, readStringField } from "../shared/record-coerce.js";

type JsonRecord = Record<string, unknown>;

type SessionsCompactGatewayPayload = {
  ok?: boolean;
  key?: string;
  compacted?: boolean;
  reason?: string;
  result?: Record<string, unknown>;
  [key: string]: unknown;
};

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
      subsystem: "sessions-compact-cli",
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

async function callSessionsCompactGatewayMethod(
  params: JsonRecord,
): Promise<SessionsCompactGatewayPayload> {
  const handler = coreGatewayHandlers["sessions.compact"];
  if (!handler) {
    throw new Error("Unknown gateway method: sessions.compact");
  }

  let result: { ok: boolean; payload?: unknown; error?: { message?: string } } | undefined;
  await handler({
    req: {
      type: "req",
      id: `sessions-compact-cli-${Date.now()}`,
      method: "sessions.compact",
      params,
    },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error: error as { message?: string } | undefined };
    },
    context: createMinimalGatewayContext(),
  });

  if (!result) {
    throw new Error("Gateway method sessions.compact returned no result");
  }
  if (!result.ok) {
    throw new Error(result.error?.message ?? "Gateway method sessions.compact failed");
  }

  const payload = asNullableRecord(result.payload);
  if (!payload) {
    throw new Error("Gateway method sessions.compact returned an invalid payload");
  }
  return payload as SessionsCompactGatewayPayload;
}

function buildTextSummary(params: {
  requestedKey: string;
  payload: SessionsCompactGatewayPayload;
}): string {
  const displayKey = params.requestedKey;
  const reason = readStringField(params.payload, "reason");

  if (params.payload.compacted === true) {
    return `Compacted session ${displayKey}.`;
  }
  if (params.payload.ok === false) {
    return reason
      ? `Session ${displayKey} compaction failed: ${reason}.`
      : `Session ${displayKey} compaction failed.`;
  }
  return reason
    ? `Session ${displayKey} was not compacted: ${reason}.`
    : `Session ${displayKey} was not compacted.`;
}

export async function sessionsCompactCommand(
  opts: { key: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const key = opts.key.trim();
  if (!key) {
    throw new Error("Session key is required");
  }

  let payload: SessionsCompactGatewayPayload;
  try {
    payload = await callSessionsCompactGatewayMethod({ key });
  } catch (error) {
    throw new Error(`Failed to compact session ${key}: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(buildTextSummary({ requestedKey: key, payload }));
}
