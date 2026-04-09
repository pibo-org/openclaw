import type { PluginRuntime } from "./types.js";

function normalizeSegment(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "");
}

export type ManagedSessionPolicy = "ephemeral" | "reusable" | "sticky" | "reset-on-reuse";
export type ManagedSessionRole =
  | "worker"
  | "critic"
  | "planner"
  | "orchestrator"
  | "specialist"
  | "scratch";

export type ManagedSessionLifecycleDecision = {
  shouldCreate: boolean;
  shouldResetBeforeRun: boolean;
  shouldDeleteAfterRun: boolean;
};

export function decideManagedSessionLifecycle(params: {
  exists: boolean;
  policy: ManagedSessionPolicy;
}): ManagedSessionLifecycleDecision {
  const { exists, policy } = params;
  switch (policy) {
    case "ephemeral":
      return { shouldCreate: !exists, shouldResetBeforeRun: false, shouldDeleteAfterRun: true };
    case "reset-on-reuse":
      return { shouldCreate: !exists, shouldResetBeforeRun: exists, shouldDeleteAfterRun: false };
    case "sticky":
      return { shouldCreate: !exists, shouldResetBeforeRun: false, shouldDeleteAfterRun: false };
    case "reusable":
    default:
      return { shouldCreate: !exists, shouldResetBeforeRun: false, shouldDeleteAfterRun: false };
  }
}

export type BuildManagedSessionKeyInput = {
  owner: string;
  scope: string;
  role?: string;
  name?: string;
  agentId?: string;
};

export function buildManagedSessionKey(input: BuildManagedSessionKeyInput): string {
  const agentId = normalizeSegment(input.agentId) ?? "pibo";
  const owner = normalizeSegment(input.owner);
  const scope = normalizeSegment(input.scope);
  const role = normalizeSegment(input.role);
  const name = normalizeSegment(input.name);

  if (!owner) {
    throw new Error("buildManagedSessionKey: owner is required");
  }
  if (!scope) {
    throw new Error("buildManagedSessionKey: scope is required");
  }

  return ["agent", agentId, "pibo", owner, scope, role, name].filter(Boolean).join(":");
}

export function buildManagedWorkflowSessionKey(input: {
  flowId: string;
  role: string;
  name?: string;
  agentId?: string;
}): string {
  return buildManagedSessionKey({
    owner: "workflow",
    scope: input.flowId,
    role: input.role,
    name: input.name,
    agentId: input.agentId,
  });
}

export type ManagedSessionResolveResult = {
  found: boolean;
  key: string;
  entry?: unknown;
  payload?: unknown;
};

export type ManagedSessionEnsureInput = {
  flowId: string;
  role: string;
  name?: string;
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  policy?: ManagedSessionPolicy;
};

export type ManagedSessionRunInput = ManagedSessionEnsureInput & {
  message: string;
  provider?: string;
  deliver?: boolean;
  extraSystemPrompt?: string;
  idempotencyKey?: string;
};

export type ManagedSessionsRuntime = {
  buildWorkflowKey: (input: {
    flowId: string;
    role: string;
    name?: string;
    agentId?: string;
  }) => string;
  resolve: (key: string) => Promise<ManagedSessionResolveResult>;
  create: (input: {
    key: string;
    agentId: string;
    label?: string;
    model?: string;
    parentSessionKey?: string;
  }) => Promise<unknown>;
  patch: (input: {
    key: string;
    label?: string | null;
    model?: string | null;
    spawnedBy?: string | null;
    spawnedWorkspaceDir?: string | null;
    spawnDepth?: number | null;
    subagentRole?: "orchestrator" | "leaf" | null;
    subagentControlScope?: "children" | "none" | null;
  }) => Promise<unknown>;
  reset: (key: string, reason?: "new" | "reset") => Promise<unknown>;
  delete: (key: string, deleteTranscript?: boolean) => Promise<void>;
  ensureWorkflowSession: (input: ManagedSessionEnsureInput) => Promise<{
    key: string;
    created: boolean;
    reset: boolean;
    deleteAfterRun: boolean;
    policy: ManagedSessionPolicy;
  }>;
  runOnManagedSession: (input: {
    sessionKey: string;
    message: string;
    provider?: string;
    model?: string;
    deliver?: boolean;
    extraSystemPrompt?: string;
    idempotencyKey?: string;
  }) => Promise<{ runId?: string }>;
  runFirstManagedWorkflowTurn: (input: ManagedSessionRunInput) => Promise<{
    sessionKey: string;
    created: boolean;
    reset: boolean;
    deleteAfterRun: boolean;
    runId?: string;
  }>;
};

export function createRuntimeManagedSessions(
  subagent: PluginRuntime["subagent"],
): ManagedSessionsRuntime {
  return {
    buildWorkflowKey(input) {
      return buildManagedWorkflowSessionKey(input);
    },
    async resolve(key) {
      const getSession = subagent.getSessionMessages as unknown as
        | ((params: { sessionKey: string; limit?: number }) => Promise<{ messages: unknown[] }>)
        | undefined;
      try {
        const payload = getSession
          ? await getSession({ sessionKey: key, limit: 1 })
          : { messages: [] };
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        return {
          found: messages.length > 0,
          key,
          entry: messages.length > 0 ? { hasMessages: true } : undefined,
          payload,
        };
      } catch {
        return { found: false, key };
      }
    },
    async create(input) {
      // Creating is done lazily through the first run on the session key.
      // For managed sessions, we still return a useful record for callers.
      return {
        ok: true,
        key: input.key,
        lazy: true,
        agentId: input.agentId,
        label: input.label,
        model: input.model,
        parentSessionKey: input.parentSessionKey,
      };
    },
    async patch(input) {
      // Reserved for future explicit gateway-session mutation wiring.
      return { ok: true, key: input.key, patched: true, input };
    },
    async reset(key, _reason = "reset") {
      // Best-effort reset by deleting the session transcript/store entry.
      await subagent.deleteSession({ sessionKey: key, deleteTranscript: true });
      return { ok: true, key, reset: true };
    },
    async delete(key, deleteTranscript = true) {
      await subagent.deleteSession({ sessionKey: key, deleteTranscript });
    },
    async ensureWorkflowSession(input) {
      const key = buildManagedWorkflowSessionKey({
        flowId: input.flowId,
        role: input.role,
        name: input.name,
        agentId: input.agentId,
      });
      const resolved = await this.resolve(key);
      const policy = input.policy ?? "reusable";
      const lifecycle = decideManagedSessionLifecycle({ exists: resolved.found, policy });

      if (lifecycle.shouldCreate) {
        await this.create({
          key,
          agentId: input.agentId ?? "pibo",
          label: input.label,
          model: input.model,
          parentSessionKey: input.parentSessionKey,
        });
      }

      if (lifecycle.shouldResetBeforeRun) {
        await this.reset(key, "reset");
      }

      return {
        key,
        created: lifecycle.shouldCreate,
        reset: lifecycle.shouldResetBeforeRun,
        deleteAfterRun: lifecycle.shouldDeleteAfterRun,
        policy,
      };
    },
    async runOnManagedSession(input) {
      return await subagent.run({
        sessionKey: input.sessionKey,
        message: input.message,
        provider: input.provider,
        model: input.model,
        deliver: input.deliver ?? false,
        extraSystemPrompt: input.extraSystemPrompt,
        idempotencyKey: input.idempotencyKey,
      });
    },
    async runFirstManagedWorkflowTurn(input) {
      const ensured = await this.ensureWorkflowSession(input);
      const run = await this.runOnManagedSession({
        sessionKey: ensured.key,
        message: input.message,
        provider: input.provider,
        model: input.model,
        deliver: input.deliver ?? false,
        extraSystemPrompt: input.extraSystemPrompt,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        sessionKey: ensured.key,
        created: ensured.created,
        reset: ensured.reset,
        deleteAfterRun: ensured.deleteAfterRun,
        runId: run.runId,
      };
    },
  };
}
