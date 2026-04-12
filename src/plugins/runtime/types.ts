import type {
  WorkflowTraceEvent,
  WorkflowTraceEventQuery,
  WorkflowTraceSummary,
} from "../../cli/pibo/workflows/tracing/types.js";
import type {
  WorkflowArtifactContent,
  WorkflowArtifactInfo,
  WorkflowModuleManifest,
  WorkflowProgressSnapshot,
  WorkflowRunRecord,
  WorkflowStartRequest,
  WorkflowWaitResult,
} from "../../cli/pibo/workflows/types.js";
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
  piboWorkflows: {
    list: () => Promise<WorkflowModuleManifest[]>;
    describe: (moduleId: string) => Promise<WorkflowModuleManifest>;
    start: (moduleId: string, request: WorkflowStartRequest) => Promise<WorkflowRunRecord>;
    startAsync: (moduleId: string, request: WorkflowStartRequest) => Promise<WorkflowRunRecord>;
    wait: (runId: string, timeoutMs?: number) => Promise<WorkflowWaitResult>;
    status: (runId: string) => Promise<WorkflowRunRecord>;
    progress: (runId: string) => Promise<WorkflowProgressSnapshot>;
    abort: (runId: string) => Promise<WorkflowRunRecord>;
    runs: (limit?: number) => Promise<WorkflowRunRecord[]>;
    traceSummary: (runId: string) => Promise<WorkflowTraceSummary>;
    traceEvents: (runId: string, query?: WorkflowTraceEventQuery) => Promise<WorkflowTraceEvent[]>;
    artifacts: (runId: string) => Promise<WorkflowArtifactInfo[]>;
    readArtifact: (
      runId: string,
      name: string,
      opts?: { headLines?: number; tailLines?: number },
    ) => Promise<WorkflowArtifactContent>;
  };
  channel: PluginRuntimeChannel;
};
