import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  deliver?: boolean;
  idempotencyKey?: string;
};

export type SubagentRunResult = {
  runId: string;
};

export type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

export type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

export type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

export type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

/** @deprecated Use SubagentGetSessionMessagesParams. */
export type SubagentGetSessionParams = SubagentGetSessionMessagesParams;

/** @deprecated Use SubagentGetSessionMessagesResult. */
export type SubagentGetSessionResult = SubagentGetSessionMessagesResult;

export type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

export type ManagedSessionPolicy = "ephemeral" | "reusable" | "sticky" | "reset-on-reuse";
export type ManagedSessionRole =
  | "worker"
  | "critic"
  | "planner"
  | "orchestrator"
  | "specialist"
  | "scratch";

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  managedSessions: {
    buildWorkflowKey: (input: {
      flowId: string;
      role: string;
      name?: string;
      agentId?: string;
    }) => string;
    resolve: (key: string) => Promise<{
      found: boolean;
      key: string;
      entry?: unknown;
      payload?: unknown;
    }>;
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
    ensureWorkflowSession: (input: {
      flowId: string;
      role: string;
      name?: string;
      agentId?: string;
      label?: string;
      model?: string;
      parentSessionKey?: string;
      policy?: ManagedSessionPolicy;
    }) => Promise<{
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
    runFirstManagedWorkflowTurn: (input: {
      flowId: string;
      role: string;
      name?: string;
      agentId?: string;
      label?: string;
      model?: string;
      parentSessionKey?: string;
      policy?: ManagedSessionPolicy;
      message: string;
      provider?: string;
      deliver?: boolean;
      extraSystemPrompt?: string;
      idempotencyKey?: string;
    }) => Promise<{
      sessionKey: string;
      created: boolean;
      reset: boolean;
      deleteAfterRun: boolean;
      runId?: string;
    }>;
  };
  channel: PluginRuntimeChannel;
};
