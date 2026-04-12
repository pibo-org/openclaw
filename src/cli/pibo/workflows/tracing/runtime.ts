import fs from "node:fs";
import path from "node:path";
import { workflowTraceEventLogPath, workflowTraceSummaryPath } from "../store.js";
import type { WorkflowRunRecord, WorkflowTraceLevel, WorkflowTraceRef } from "../types.js";
import { createWorkflowTraceEventId } from "./ids.js";
import { redactTraceValue } from "./redact.js";
import { appendWorkflowTraceEventJsonl } from "./sinks/jsonl.js";
import {
  applyTraceEventToSummaryState,
  createWorkflowTraceSummaryState,
  snapshotWorkflowTraceSummary,
} from "./summary.js";
import type { WorkflowTraceEvent, WorkflowTraceEventQuery, WorkflowTraceSummary } from "./types.js";

export interface WorkflowTraceRuntime {
  readonly runId: string;
  readonly moduleId: string;
  readonly level: WorkflowTraceLevel;
  emit(
    event: Omit<WorkflowTraceEvent, "eventId" | "moduleId" | "runId" | "seq" | "ts"> & {
      ts?: string;
    },
  ): WorkflowTraceEvent;
  attachToRunRecord(record: WorkflowRunRecord): WorkflowRunRecord;
  getRef(updatedAt?: string): WorkflowTraceRef;
  getSummary(): WorkflowTraceSummary;
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function buildWorkflowTraceRef(params: {
  runId: string;
  level: WorkflowTraceLevel;
  eventCount?: number;
  updatedAt?: string;
}): WorkflowTraceRef {
  return {
    version: "v1",
    level: params.level,
    eventLogPath: workflowTraceEventLogPath(params.runId),
    summaryPath: workflowTraceSummaryPath(params.runId),
    ...(typeof params.eventCount === "number" ? { eventCount: params.eventCount } : {}),
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
  };
}

function writeWorkflowTraceSummaryFile(summaryPath: string, summary: WorkflowTraceSummary) {
  ensureParentDir(summaryPath);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export function createWorkflowTraceRuntime(params: {
  runId: string;
  moduleId: string;
  level: WorkflowTraceLevel;
  nowIso?: () => string;
}): WorkflowTraceRuntime {
  const nowIso = params.nowIso ?? (() => new Date().toISOString());
  const eventLogPath = workflowTraceEventLogPath(params.runId);
  const summaryPath = workflowTraceSummaryPath(params.runId);
  const summaryState = createWorkflowTraceSummaryState({
    runId: params.runId,
    moduleId: params.moduleId,
    level: params.level,
  });
  let seq = 0;

  const getSummary = () => snapshotWorkflowTraceSummary(summaryState);

  return {
    runId: params.runId,
    moduleId: params.moduleId,
    level: params.level,
    emit(event) {
      seq += 1;
      const normalized: WorkflowTraceEvent = {
        eventId: createWorkflowTraceEventId(),
        runId: params.runId,
        moduleId: params.moduleId,
        ts: event.ts ?? nowIso(),
        seq,
        kind: event.kind,
        ...(event.stepId ? { stepId: event.stepId } : {}),
        ...(typeof event.round === "number" ? { round: event.round } : {}),
        ...(event.role ? { role: event.role } : {}),
        ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.artifactPath ? { artifactPath: event.artifactPath } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(event.summary ? { summary: String(redactTraceValue(event.summary)) } : {}),
        ...(event.payload === undefined ? {} : { payload: redactTraceValue(event.payload) }),
      };
      appendWorkflowTraceEventJsonl(eventLogPath, normalized);
      applyTraceEventToSummaryState(summaryState, normalized);
      writeWorkflowTraceSummaryFile(summaryPath, getSummary());
      return normalized;
    },
    attachToRunRecord(record) {
      return {
        ...record,
        trace: this.getRef(record.updatedAt),
      };
    },
    getRef(updatedAt) {
      const summary = getSummary();
      return buildWorkflowTraceRef({
        runId: params.runId,
        level: summary.eventCount > 0 ? params.level : 0,
        eventCount: summary.eventCount,
        updatedAt: updatedAt ?? summary.endedAt ?? summary.startedAt,
      });
    },
    getSummary,
  };
}

export function readWorkflowTraceSummary(runId: string): WorkflowTraceSummary | null {
  const summaryPath = workflowTraceSummaryPath(runId);
  if (!fs.existsSync(summaryPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(summaryPath, "utf8")) as WorkflowTraceSummary;
}

export function readWorkflowTraceEvents(
  runId: string,
  query?: WorkflowTraceEventQuery,
): WorkflowTraceEvent[] {
  const eventLogPath = workflowTraceEventLogPath(runId);
  if (!fs.existsSync(eventLogPath)) {
    return [];
  }
  const events = fs
    .readFileSync(eventLogPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkflowTraceEvent);
  const filtered = events.filter((event) => {
    if (typeof query?.sinceSeq === "number" && Number.isFinite(query.sinceSeq)) {
      if (event.seq <= Math.floor(query.sinceSeq)) {
        return false;
      }
    }
    if (query?.role && event.role !== query.role) {
      return false;
    }
    if (query?.kind && event.kind !== query.kind) {
      return false;
    }
    return true;
  });
  const limit =
    typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
      ? Math.floor(query.limit)
      : undefined;
  return limit ? filtered.slice(-limit) : filtered;
}

export function deriveWorkflowTraceSummaryFromRun(record: WorkflowRunRecord): WorkflowTraceSummary {
  const rolesSeen = [
    ...(record.sessions.orchestrator ? ["orchestrator"] : []),
    ...(record.sessions.worker ? ["worker"] : []),
    ...(record.sessions.critic ? ["critic"] : []),
  ];
  const stepCount =
    record.currentRound > 0 ? record.currentRound : record.status === "pending" ? 0 : 1;
  const endedAt =
    record.status === "pending" || record.status === "running" ? undefined : record.updatedAt;
  const durationMs =
    endedAt && record.createdAt
      ? Math.max(0, Date.parse(endedAt) - Date.parse(record.createdAt))
      : undefined;

  return {
    runId: record.runId,
    moduleId: record.moduleId,
    traceLevel: record.trace?.level ?? 0,
    status: record.status,
    startedAt: record.createdAt,
    ...(endedAt ? { endedAt } : {}),
    ...(typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs } : {}),
    eventCount: record.trace?.eventCount ?? 0,
    stepCount,
    roundCount: record.currentRound,
    rolesSeen,
    artifactCount: record.artifacts.length,
    errorSummary:
      record.status === "failed" ||
      record.status === "blocked" ||
      record.status === "max_rounds_reached"
        ? record.terminalReason
        : null,
  };
}
