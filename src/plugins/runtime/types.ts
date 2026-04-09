import type {
  WorkflowModuleManifest,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../../cli/pibo/workflows/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionsListParams, SessionsResolveParams } from "../../gateway/protocol/index.js";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../gateway/session-utils.js";
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
    buildKey: (input: {
      owner: string;
      scope: string;
      role?: string;
      name?: string;
      agentId?: string;
    }) => string;
    buildWorkflowKey: (input: {
      flowId: string;
      role: string;
      name?: string;
      agentId?: string;
    }) => string;
    list: (input?: SessionsListParams) => Promise<SessionsListResult>;
    get: (input: { key: string; limit?: number }) => Promise<{
      found: boolean;
      key: string;
      row?: GatewaySessionRow;
      entry?: SessionEntry;
      messages: unknown[];
      messageCount: number;
    }>;
    status: (input: { key: string; limit?: number }) => Promise<{
      found: boolean;
      key: string;
      row?: GatewaySessionRow;
      entry?: SessionEntry;
      messages: unknown[];
      messageCount: number;
    }>;
    resolveSelector: (
      input: SessionsResolveParams,
    ) => Promise<
      { ok: true; key: string } | { ok: false; error: { code?: string | number; message: string } }
    >;
    resolve: (key: string) => Promise<{
      found: boolean;
      key: string;
      entry?: unknown;
      payload?: unknown;
      row?: GatewaySessionRow;
      messageCount?: number;
      sessionId?: string;
    }>;
    create: (input: {
      key: string;
      agentId: string;
      label?: string;
      model?: string;
      parentSessionKey?: string;
      task?: string;
      message?: string;
    }) => Promise<{
      ok: true;
      key: string;
      sessionId: string;
      entry: SessionEntry;
      created: boolean;
    }>;
    add: (input: {
      key: string;
      agentId: string;
      label?: string;
      model?: string;
      parentSessionKey?: string;
      task?: string;
      message?: string;
    }) => Promise<{
      ok: true;
      key: string;
      sessionId: string;
      entry: SessionEntry;
      created: boolean;
    }>;
    patch: (input: {
      key: string;
      label?: string | null;
      thinkingLevel?: string | null;
      fastMode?: boolean | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
      responseUsage?: "off" | "tokens" | "full" | "on" | null;
      elevatedLevel?: string | null;
      execHost?: string | null;
      execSecurity?: string | null;
      execAsk?: string | null;
      execNode?: string | null;
      model?: string | null;
      spawnedBy?: string | null;
      spawnedWorkspaceDir?: string | null;
      spawnDepth?: number | null;
      subagentRole?: "orchestrator" | "leaf" | null;
      subagentControlScope?: "children" | "none" | null;
      sendPolicy?: "allow" | "deny" | null;
      groupActivation?: "mention" | "always" | null;
    }) => Promise<SessionsPatchResult>;
    edit: (input: {
      key: string;
      label?: string | null;
      thinkingLevel?: string | null;
      fastMode?: boolean | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
      responseUsage?: "off" | "tokens" | "full" | "on" | null;
      elevatedLevel?: string | null;
      execHost?: string | null;
      execSecurity?: string | null;
      execAsk?: string | null;
      execNode?: string | null;
      model?: string | null;
      spawnedBy?: string | null;
      spawnedWorkspaceDir?: string | null;
      spawnDepth?: number | null;
      subagentRole?: "orchestrator" | "leaf" | null;
      subagentControlScope?: "children" | "none" | null;
      sendPolicy?: "allow" | "deny" | null;
      groupActivation?: "mention" | "always" | null;
    }) => Promise<SessionsPatchResult>;
    reset: (key: string, reason?: "new" | "reset") => Promise<unknown>;
    delete: (key: string, deleteTranscript?: boolean) => Promise<void>;
    compact: (input: { key: string; maxLines?: number }) => Promise<{
      ok: true;
      key: string;
      compacted: boolean;
      archived?: string;
      kept?: number;
      reason?: string;
    }>;
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
  piboWorkflows: {
    list: () => Promise<WorkflowModuleManifest[]>;
    describe: (moduleId: string) => Promise<WorkflowModuleManifest>;
    start: (moduleId: string, request: WorkflowStartRequest) => Promise<WorkflowRunRecord>;
    status: (runId: string) => Promise<WorkflowRunRecord>;
    abort: (runId: string) => Promise<WorkflowRunRecord>;
    runs: (limit?: number) => Promise<WorkflowRunRecord[]>;
  };
  channel: PluginRuntimeChannel;
};
