import type { WorkflowRunStatus, WorkflowTraceLevel } from "../types.js";
import type { WorkflowTraceEvent, WorkflowTraceEventKind, WorkflowTraceSummary } from "./types.js";

type WorkflowTraceSummaryState = {
  summary: WorkflowTraceSummary;
  stepIds: Set<string>;
  rounds: Set<number>;
  roles: Set<string>;
  artifacts: Set<string>;
};

function statusFromTerminalEvent(event: WorkflowTraceEvent): WorkflowRunStatus | undefined {
  if (event.kind === "run_completed") {
    return event.status ?? "done";
  }
  if (event.kind === "run_blocked") {
    return event.status ?? "blocked";
  }
  if (event.kind === "run_failed") {
    return "failed";
  }
  return event.status;
}

function isTerminalEventKind(kind: WorkflowTraceEventKind): boolean {
  return kind === "run_completed" || kind === "run_blocked" || kind === "run_failed";
}

export function createWorkflowTraceSummaryState(params: {
  runId: string;
  moduleId: string;
  level: WorkflowTraceLevel;
}): WorkflowTraceSummaryState {
  return {
    summary: {
      runId: params.runId,
      moduleId: params.moduleId,
      traceLevel: params.level,
      eventCount: 0,
      stepCount: 0,
      roundCount: 0,
      rolesSeen: [],
      artifactCount: 0,
      errorSummary: null,
    },
    stepIds: new Set(),
    rounds: new Set(),
    roles: new Set(),
    artifacts: new Set(),
  };
}

export function applyTraceEventToSummaryState(
  state: WorkflowTraceSummaryState,
  event: WorkflowTraceEvent,
) {
  state.summary.eventCount = event.seq;
  state.summary.lastEventKind = event.kind;
  state.summary.startedAt ??= event.ts;

  if (event.stepId) {
    state.stepIds.add(event.stepId);
  }
  if (typeof event.round === "number") {
    state.rounds.add(event.round);
  }
  if (event.role) {
    state.roles.add(event.role);
  }
  if (event.artifactPath) {
    state.artifacts.add(event.artifactPath);
  }

  const nextStatus = statusFromTerminalEvent(event);
  if (nextStatus) {
    state.summary.status = nextStatus;
  }
  if (isTerminalEventKind(event.kind)) {
    state.summary.endedAt = event.ts;
  }
  if (event.kind === "warning" || event.kind === "report_failed" || event.kind === "run_failed") {
    state.summary.errorSummary = event.summary ?? state.summary.errorSummary ?? null;
  }

  state.summary.stepCount = state.stepIds.size;
  state.summary.roundCount = state.rounds.size;
  state.summary.rolesSeen = Array.from(state.roles);
  state.summary.artifactCount = state.artifacts.size;

  if (state.summary.startedAt && state.summary.endedAt) {
    const startedAtMs = Date.parse(state.summary.startedAt);
    const endedAtMs = Date.parse(state.summary.endedAt);
    if (Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && endedAtMs >= startedAtMs) {
      state.summary.durationMs = endedAtMs - startedAtMs;
    }
  }
}

export function snapshotWorkflowTraceSummary(
  state: WorkflowTraceSummaryState,
): WorkflowTraceSummary {
  return {
    ...state.summary,
    rolesSeen: [...state.summary.rolesSeen],
  };
}
