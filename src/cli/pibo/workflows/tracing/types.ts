import type { WorkflowRunStatus, WorkflowTraceLevel } from "../types.js";

export type WorkflowTraceEventKind =
  | "run_started"
  | "run_status_changed"
  | "round_started"
  | "role_turn_started"
  | "role_turn_completed"
  | "artifact_written"
  | "report_delivery_attempted"
  | "report_delivered"
  | "report_failed"
  | "run_completed"
  | "run_blocked"
  | "run_failed"
  | "warning"
  | "custom";

export interface WorkflowTraceEvent {
  eventId: string;
  runId: string;
  moduleId: string;
  ts: string;
  seq: number;
  kind: WorkflowTraceEventKind;
  stepId?: string;
  round?: number;
  role?: string;
  sessionKey?: string;
  agentId?: string;
  artifactPath?: string;
  status?: WorkflowRunStatus;
  summary?: string;
  payload?: unknown;
}

export interface WorkflowTraceSummary {
  runId: string;
  moduleId: string;
  traceLevel: WorkflowTraceLevel;
  status?: WorkflowRunStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  eventCount: number;
  stepCount: number;
  roundCount: number;
  rolesSeen: string[];
  artifactCount: number;
  lastEventKind?: WorkflowTraceEventKind;
  errorSummary?: string | null;
}

export interface WorkflowTraceEventQuery {
  limit?: number;
  sinceSeq?: number;
  role?: string;
  kind?: WorkflowTraceEventKind;
}
