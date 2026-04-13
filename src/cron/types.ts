import type { FailoverReason } from "../agents/pi-embedded-helpers.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { HookExternalContentSource } from "../security/external-content.js";
import type { CronJobBase } from "./types-shared.js";

export type CronRunStatus = "ok" | "error" | "skipped";

export type CronRetryOn = "rate_limit" | "overloaded" | "network" | "timeout" | "server_error";

export type CronDeliveryStatus = "not-requested" | "delivered" | "not-delivered" | "unknown";

export type CronUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  workflowRunId?: string;
  workflowModuleId?: string;
  workflowStartMode?: "async";
};

export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  errorKind?: "delivery-target";
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

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | CronAgentTurnPayload
  | CronWorkflowStartPayload;

export type CronPayloadPatch =
  | { kind: "systemEvent"; text?: string }
  | CronAgentTurnPayloadPatch
  | CronWorkflowStartPayloadPatch;

type CronAgentTurnPayloadFields = {
  message: string;
  model?: string;
  fallbacks?: string[];
  toolsAllow?: string[] | null;
  thinking?: string;
  timeoutSeconds?: number;
  lightContext?: boolean;
  allowUnsafeExternalContent?: boolean;
  externalContentSource?: HookExternalContentSource;
};

export type CronAgentTurnPayload = {
  kind: "agentTurn";
} & CronAgentTurnPayloadFields;

type CronAgentTurnPayloadPatch = {
  kind: "agentTurn";
} & Partial<Omit<CronAgentTurnPayloadFields, "toolsAllow">> & {
    toolsAllow?: string[] | null;
  };

type CronWorkflowStartPayloadFields = {
  moduleId: string;
  input?: unknown;
  maxRounds?: number;
  asyncStart?: boolean;
};

export type CronWorkflowStartPayload = {
  kind: "workflowStart";
} & CronWorkflowStartPayloadFields;

type CronWorkflowStartPayloadPatch = {
  kind: "workflowStart";
} & Partial<CronWorkflowStartPayloadFields>;

export type CronScheduleAt = {
  kind: "at";
  at: string;
};

export type CronScheduleEvery = {
  kind: "every";
  everyMs: number;
  anchorMs?: number;
};

export type CronScheduleCron = {
  kind: "cron";
  expr: string;
  tz?: string;
  staggerMs?: number;
};

export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

export type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;

export type CronWakeMode = "next-heartbeat" | "now";

export type CronMessageChannel = ChannelId;

export type CronDeliveryMode = "none" | "announce" | "webhook";

export type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

export type CronDelivery = {
  mode?: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  threadId?: string | number;
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: CronFailureDestination;
};

export type CronDeliveryPatch = Partial<CronDelivery> & {
  failureDestination?: CronFailureDestination | null;
};

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastErrorReason?: FailoverReason;
  lastDurationMs?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: CronDeliveryStatus;
  lastDeliveryError?: string;
  consecutiveErrors?: number;
  lastFailureAlertAtMs?: number;
  scheduleErrorCount?: number;
};

export type CronJob = CronJobBase<
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
  CronDelivery,
  CronFailureAlert | false
> & {
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronStore = CronStoreFile;

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<
  Omit<
    CronJob,
    "id" | "createdAtMs" | "state" | "payload" | "schedule" | "delivery" | "failureAlert"
  >
> & {
  schedule?: CronSchedule;
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  failureAlert?: CronFailureAlert | false;
  state?: Partial<CronJobState>;
};
