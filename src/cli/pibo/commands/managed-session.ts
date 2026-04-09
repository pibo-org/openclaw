import { createDefaultDeps } from "../../../cli/deps.js";
import { resolveDefaultAgentId } from "../../../agents/agent-scope.js";
import { loadConfig } from "../../../config/config.js";
import { coreGatewayHandlers } from "../../../gateway/server-methods.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { buildManagedWorkflowSessionKey } from "../../../plugins/runtime/runtime-managed-sessions.js";

function createMinimalGatewayContext(): GatewayRequestContext {
  return {
    deps: createDefaultDeps(),
    cron: {} as GatewayRequestContext["cron"],
    cronStorePath: "/tmp/openclaw-cron.json",
    loadGatewayModelCatalog: async () => [],
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({ ok: true } as unknown as Awaited<ReturnType<GatewayRequestContext["refreshHealthSnapshot"]>>),
    logHealth: { error: () => {} },
    logGateway: ({
      subsystem: "managed-session-smoke",
      isEnabled: () => false,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: () => undefined,
      withBindings: () => undefined,
    } as unknown) as GatewayRequestContext["logGateway"],
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
    getRuntimeSnapshot: () => ({ channels: [] } as unknown as ReturnType<GatewayRequestContext["getRuntimeSnapshot"]>),
    startChannel: async () => {},
    stopChannel: async () => {},
    markChannelLoggedOut: () => {},
    wizardRunner: async () => {},
    broadcastVoiceWakeChanged: () => {},
  };
}

async function callGatewayMethod<T = unknown>(method: string, params: Record<string, unknown>) {
  const handler = coreGatewayHandlers[method];
  if (!handler) {
    throw new Error(`Unknown gateway method: ${method}`);
  }

  let result: { ok: boolean; payload?: unknown; error?: { message?: string } } | undefined;
  await handler({
    req: { type: "req", id: `managed-session-smoke-${Date.now()}`, method, params },
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

export async function managedSessionSmoke() {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const flowId = `smoke-${Date.now()}`;
  const sessionKey = buildManagedWorkflowSessionKey({
    flowId,
    role: "worker",
    name: "main",
    agentId,
  });

  let created: { key: string; sessionId: string } | { reused: true; key: string };
  try {
    created = await callGatewayMethod<{ key: string; sessionId: string }>("sessions.create", {
      key: sessionKey,
      agentId,
      label: `PIBo Managed Session Smoke ${flowId}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already in use")) {
      throw error;
    }
    created = { reused: true, key: sessionKey };
  }

  const run = await callGatewayMethod<{ runId?: string }>("agent", {
    sessionKey,
    message: "This is a managed-session smoke test. Reply with exactly: MANAGED_SESSION_SMOKE_OK",
    deliver: false,
    idempotencyKey: `managed-session-smoke-${Date.now()}`,
  });

  const waited = run.runId
    ? await callGatewayMethod<{ status?: string; error?: string }>("agent.wait", {
        runId: run.runId,
        timeoutMs: 120000,
      })
    : undefined;

  const session = await callGatewayMethod<{ messages?: unknown[] }>("sessions.get", {
    key: sessionKey,
    limit: 20,
  });

  console.log(
    JSON.stringify(
      {
        agentId,
        flowId,
        sessionKey,
        created,
        run,
        waited,
        messages: session.messages,
      },
      null,
      2,
    ),
  );

  return {
    agentId,
    flowId,
    sessionKey,
    created,
    run,
    waited,
    messages: session.messages,
  };
}
