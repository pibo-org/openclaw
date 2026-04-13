import type { CronConfig } from "../../config/types.cron.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type {
  CronDeliveryStatus,
  CronFailureAlert,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronMessageChannel,
  CronRetryOn,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
  CronStoreFile,
} from "../types.js";

export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type CronEvent = {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "tick" | "finished";
  runAtMs?: number;
  durationMs?: number;
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryAttempted?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  nextRunAtMs?: number;
  workflowRunId?: string;
  workflowModuleId?: string;
  workflowStartMode?: "async";
} & CronRunTelemetry;

export type CronServiceDeps = {
  nowMs?: () => number;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  cronConfig?: CronConfig;
  defaultAgentId?: string;
  resolveSessionStorePath?: (agentId?: string) => string;
  sessionStorePath?: string;
  missedJobStaggerMs?: number;
  maxMissedJobsPerRestart?: number;
  enqueueSystemEvent: (
    text: string,
    opts?: {
      agentId?: string;
      sessionKey?: string;
      contextKey?: string;
      sessionId?: string;
    },
  ) => void;
  requestHeartbeatNow: (opts?: { reason?: string; agentId?: string; sessionKey?: string }) => void;
  runHeartbeatOnce?: (opts?: {
    reason?: string;
    agentId?: string;
    sessionKey?: string;
    heartbeat?: {
      target?: string;
      model?: string;
      maxTokens?: number;
      toolMode?: "full" | "none";
      suppressAmbientWhenMessagePending?: boolean;
      ambientPrompt?: string;
      emitAssistantUsage?: boolean;
    };
  }) => Promise<HeartbeatRunResult>;
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  wakeNowHeartbeatBusyRetryDelayMs?: number;
  runIsolatedAgentJob: (params: {
    job: CronJob;
    message: string;
    abortSignal?: AbortSignal;
  }) => Promise<
    {
      summary?: string;
      outputText?: string;
      delivered?: boolean;
      deliveryAttempted?: boolean;
      sessionId?: string;
      sessionKey?: string;
    } & CronRunOutcome &
      CronRunTelemetry
  >;
  runWorkflowJob?: (params: {
    job: CronJob;
    abortSignal?: AbortSignal;
  }) => Promise<CronRunOutcome & CronRunTelemetry>;
  sendCronFailureAlert?: (params: {
    job: CronJob;
    text: string;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
  }) => Promise<void>;
  onEvent?: (evt: CronEvent) => void;
};

export type CronServiceDepsInternal = Omit<CronServiceDeps, "nowMs" | "runWorkflowJob"> & {
  nowMs: () => number;
  runWorkflowJob: NonNullable<CronServiceDeps["runWorkflowJob"]>;
};

export type CronServiceState = {
  deps: CronServiceDepsInternal;
  store: CronStoreFile | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  op: Promise<unknown>;
  warnedDisabled: boolean;
  storeLoadedAtMs: number | null;
  storeFileMtimeMs: number | null;
};

export function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: {
      ...deps,
      nowMs: deps.nowMs ?? (() => Date.now()),
      runWorkflowJob:
        deps.runWorkflowJob ??
        (async () => ({
          status: "error" as const,
          error: "workflowStart cron jobs are unavailable in this runtime",
        })),
    },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    storeLoadedAtMs: null,
    storeFileMtimeMs: null,
  };
}

export type CronRetryConfig = {
  maxAttempts: number;
  backoffMs: number[];
  retryOn?: CronRetryOn[];
};

export type CronFailureAlertConfig = CronFailureAlert & {
  enabled?: boolean;
};

export type CronRunMode = "due" | "force";
export type CronWakeMode = "now" | "next-heartbeat";

export type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId: string }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: true; ran: false; reason: "already-running" }
  | { ok: false };

export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

export type CronAddResult = CronJob;
export type CronUpdateResult = CronJob;

export type CronListResult = CronJob[];
export type CronAddInput = CronJobCreate;
export type CronUpdateInput = CronJobPatch;
