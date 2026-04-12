export type CronRunStatus = "ok" | "error" | "skipped";

export type CronRetryOn = "rate_limit" | "overloaded" | "network" | "timeout" | "server_error";

export type CronDeliveryStatus = "not-requested" | "delivered" | "not-delivered" | "unknown";

export type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  // Delivery diagnostics for surfaced summaries/announcements.
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
};

export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  delivered?: boolean;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
};

export type CronFailureAlert = {
  after?: number;
  channel?: CronMessageChannel;
  to?: string;
  mode?: "announce" | "webhook";
  cooldownMs?: number;
  accountId?: string;
};

export type CronPayload = { kind: "systemEvent"; text: string } | CronAgentTurnPayload;

export type CronPayloadPatch = { kind: "systemEvent"; text?: string } | CronAgentTurnPayloadPatch;

type CronAgentTurnPayloadFields = {
  message: string;
  model?: string;
  fallbacks?: string[];
  toolsAllow?: string[] | null;
  thinking?: string;
  timeoutSeconds?: number;
  lightContext?: boolean;
  allowUnsafeExternalContent?: boolean;
};

export type CronAgentTurnPayload = {
  kind: "agentTurn";
} & CronAgentTurnPayloadFields;

type CronAgentTurnPayloadPatch = {
  kind: "agentTurn";
} & Partial<Omit<CronAgentTurnPayloadFields, "toolsAllow">> & {
    toolsAllow?: string[] | null;
  };
export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastStatus?: CronRunStatus;
  lastError?: string;
  // Normalized failover reason (for UI/API consumers) derived from the last error.
  lastErrorReason?: string;
  lastDurationMs?: number;
  // Whether the last run's summary/announcement was delivered successfully.
  lastDelivered?: boolean;
  // Delivery status for the last run (requested + outcome aware).
  lastDeliveryStatus?: CronDeliveryStatus;
  // Delivery-specific error when delivery was attempted but failed.
  lastDeliveryError?: string;
  // Consecutive error count for retry/backoff/auto-disable.
  consecutiveErrors?: number;
  // Timestamp of the last emitted failure alert for cooldown handling.
  lastFailureAlertAtMs?: number;
};

export type CronScheduleAt = {
  kind: "at";
  /**
   * Absolute wall-clock time for one-shot schedules, serialized as an ISO string.
   * Older data may still carry `atMs`; normalization/migrations should coerce to `at`.
   */
  at: string;
};

export type CronScheduleEvery = {
  kind: "every";
  everyMs: number;
  /**
   * Stable anchor timestamp in milliseconds since epoch.
   * If omitted, the scheduler uses job.createdAtMs as the initial anchor.
   * This keeps repeating schedules phase-stable across restarts and edits.
   */
  anchorMs?: number;
};

export type CronScheduleCron = {
  kind: "cron";
  expr: string;
  tz?: string;
  /**
   * Optional per-job stagger window (ms) for cron expressions. Jobs are
   * deterministically offset within this window based on job id, avoiding
   * thundering herds after restarts while remaining stable over time.
   * `0` disables staggering for the job.
   */
  staggerMs?: number;
};

export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

export type CronMessageChannel = "last" | "telegram" | "signal" | "discord" | "slack";

export type CronDeliveryMode = "none" | "announce" | "webhook";

export type CronDelivery = {
  mode?: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  threadId?: string;
  accountId?: string;
  /**
   * If true, job success is preserved even when summary delivery fails.
   * When false/omitted, delivery failure marks the run as error.
   */
  bestEffort?: boolean;
  /**
   * Optional alternate destination for failure notifications. When omitted,
   * failures may be announced to the primary delivery channel depending on
   * scheduler/global policy.
   */
  failureDestination?: {
    mode?: CronDeliveryMode | "announce" | "webhook";
    channel?: CronMessageChannel;
    to?: string;
    accountId?: string;
  };
};

export type CronDeliveryPatch = {
  mode?: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  threadId?: string;
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: {
    mode?: CronDeliveryMode | "announce" | "webhook";
    channel?: CronMessageChannel;
    to?: string;
    accountId?: string;
  } | null;
};

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  agentId?: string;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
  sessionKey?: string;
  payload: CronPayload;
  wakeMode?: "now" | "next-heartbeat";
  /** Optional delivery configuration for isolated jobs. */
  delivery?: CronDelivery;
  /** Optional failure alert policy. */
  failureAlert?: CronFailureAlert | false;
  createdAtMs: number;
  updatedAtMs: number;
  state: CronJobState;
  deleteAfterRun?: boolean;
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  deleteAfterRun?: boolean;
};

export type CronJobPatch = Partial<
  Omit<CronJobCreate, "payload" | "schedule" | "delivery" | "failureAlert">
> & {
  schedule?: Partial<CronScheduleAt> | Partial<CronScheduleEvery> | Partial<CronScheduleCron>;
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  failureAlert?: CronFailureAlert | false;
};

export type CronStore = {
  jobs: CronJob[];
};
