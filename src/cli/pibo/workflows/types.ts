import type { WorkflowTraceRuntime } from "./tracing/runtime.js";

export type WorkflowModuleKind = "agent_workflow" | "analysis_workflow" | "maintenance_workflow";

export type WorkflowTerminalState =
  | "done"
  | "planning_done"
  | "blocked"
  | "aborted"
  | "failed"
  | "max_rounds_reached";

export type WorkflowRunStatus = "pending" | "running" | WorkflowTerminalState;
export type WorkflowTraceLevel = 0 | 1 | 2 | 3;
export type WorkflowStatusPhase =
  | "bootstrapping"
  | "starting_controller"
  | "starting_worker"
  | "running_round"
  | "assessing_closeout";

export interface WorkflowTraceRef {
  version: "v1";
  level: WorkflowTraceLevel;
  eventLogPath: string;
  summaryPath: string;
  eventCount?: number;
  updatedAt?: string;
}

export interface WorkflowProgressSnapshot {
  runId: string;
  moduleId: string;
  status: WorkflowRunStatus;
  statusPhase: WorkflowStatusPhase | null;
  isTerminal: boolean;
  abortRequested: boolean;
  abortRequestedAt: string | null;
  currentRound: number;
  maxRounds: number | null;
  traceLevel: WorkflowTraceLevel;
  eventCount: number;
  artifactCount: number;
  startedAt: string;
  updatedAt: string;
  terminalReason: string | null;
  currentStepId: string | null;
  activeRole: string | null;
  lastCompletedRole: string | null;
  lastArtifactPath: string | null;
  lastArtifactName: string | null;
  lastEventSeq: number | null;
  lastEventKind: string | null;
  lastEventAt: string | null;
  lastEventSummary: string | null;
  sessions: WorkflowRunSessions;
  humanSummary: string;
}

export interface WorkflowArtifactInfo {
  name: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface WorkflowArtifactContent extends WorkflowArtifactInfo {
  mode: "full" | "head" | "tail";
  totalLines: number;
  truncated: boolean;
  content: string;
}

export type WorkflowRunSessions = {
  orchestrator?: string;
  worker?: string;
  critic?: string;
  extras?: Record<string, string>;
};

export interface WorkflowOriginContext {
  ownerSessionKey: string;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
}

export interface WorkflowReportingConfig {
  deliveryMode?: "topic_origin";
  senderPolicy?: "emitting_agent";
  headerMode?: "runtime_header";
  events?: Array<"started" | "milestone" | "blocked" | "completed">;
}

export interface WorkflowModuleManifest {
  moduleId: string;
  displayName: string;
  description: string;
  kind: WorkflowModuleKind;
  version: string;
  requiredAgents: string[];
  terminalStates: WorkflowTerminalState[];
  supportsAbort: boolean;
  inputSchemaSummary: string[];
  artifactContract: string[];
}

export interface WorkflowRunRecord {
  runId: string;
  moduleId: string;
  status: WorkflowRunStatus;
  terminalReason: string | null;
  abortRequested: boolean;
  abortRequestedAt: string | null;
  currentRound: number;
  maxRounds: number | null;
  input: unknown;
  artifacts: string[];
  sessions: WorkflowRunSessions;
  latestWorkerOutput: string | null;
  latestCriticVerdict: string | null;
  originalTask: string | null;
  currentTask: string | null;
  origin?: WorkflowOriginContext;
  reporting?: WorkflowReportingConfig;
  trace?: WorkflowTraceRef;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStartRequest {
  input: unknown;
  maxRounds?: number | null;
  origin?: WorkflowOriginContext;
  reporting?: WorkflowReportingConfig;
}

export interface WorkflowWaitResult {
  status: "ok" | "timeout" | "error";
  run?: WorkflowRunRecord;
  error?: string;
}

export interface WorkflowModuleContext {
  runId: string;
  nowIso(): string;
  persist(record: WorkflowRunRecord): void;
  abortSignal: AbortSignal;
  throwIfAbortRequested(): void;
  trace: WorkflowTraceRuntime;
}

export interface WorkflowModule {
  manifest: WorkflowModuleManifest;
  start(request: WorkflowStartRequest, ctx: WorkflowModuleContext): Promise<WorkflowRunRecord>;
}
