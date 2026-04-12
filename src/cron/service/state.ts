import type { CronConfig } from "../../config/types.cron.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronStore } from "../types.js";
import type {
  CronDeliveryStatus,
  CronFailureAlert,
  CronJob,
  CronMessageChannel,
  CronRetryOn,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
} from "../types.js";

export type CronEvent = {
  action: "updated" | "tick" | "finished";
  jobId: string;
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  nextRunAtMs?: number;
} & CronRunTelemetry;

export type CronServiceDeps = {
  nowMs: () => number;
  loadStore: (path: string) => Promise<CronStore>;
  saveStore: (path: string, store: CronStore) => Promise<void>;
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
  runHeartbeatOnce: (opts?: {
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
  runIsolatedAgentJob: (params: {
    job: CronJob;
    message: string;
    abortSignal?: AbortSignal;
  }) => Promise<
    {
      sessionId?: string;
      sessionKey?: string;
    } & CronRunOutcome &
      CronRunTelemetry
  >;
  sendCronFailureAlert?: (params: {
    job: CronJob;
    text: string;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
  }) => Promise<void>;
  onEvent?: (event: CronEvent) => void;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
    debug?: (obj: unknown, msg?: string) => void;
  };
  cronEnabled?: boolean;
  cronConfig?: CronConfig;
  defaultAgentId?: string;
  sessionStorePath?: string;
  resolveSessionStorePath?: (agentId?: string) => string;
};

export type CronServiceState = {
  storePath: string;
  store?: CronStore;
  loadedAtMs?: number;
  saving?: Promise<void>;
  timer?: NodeJS.Timeout;
  running?: boolean;
  deps: CronServiceDeps;
};

export type CronRetryConfig = {
  maxAttempts: number;
  backoffMs: number[];
  retryOn?: CronRetryOn[];
};

export type CronFailureAlertConfig = CronFailureAlert & {
  enabled?: boolean;
};
