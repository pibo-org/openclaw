import type {
  WorkflowModule,
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../types.js";
import { emitTracedWorkflowReportEvent } from "../workflow-reporting.js";

function normalizeInput(input: unknown) {
  if (input && typeof input === "object") {
    return input;
  }
  if (typeof input === "string" && input.trim()) {
    return { prompt: input.trim() };
  }
  return { prompt: "noop" };
}

function toPreview(input: unknown) {
  return JSON.stringify(input, null, 2);
}

async function start(
  request: WorkflowStartRequest,
  ctx: WorkflowModuleContext,
): Promise<WorkflowRunRecord> {
  const now = ctx.nowIso();
  const normalized = normalizeInput(request.input);
  ctx.trace.emit({
    kind: "run_started",
    stepId: "run",
    status: "running",
    summary: "Noop workflow started.",
    payload: {
      inputPreview: toPreview(normalized),
    },
  });
  await emitTracedWorkflowReportEvent({
    trace: ctx.trace,
    stepId: "run",
    moduleId: "noop",
    runId: ctx.runId,
    phase: "run_started",
    eventType: "started",
    messageText: `Noop workflow started.\n\nInput preview:\n${toPreview(normalized)}`,
    emittingAgentId: "main",
    origin: request.origin,
    reporting: request.reporting,
    status: "running",
  });
  const record: WorkflowRunRecord = {
    runId: ctx.runId,
    moduleId: "noop",
    status: "done",
    terminalReason: "No-op reference workflow completed immediately.",
    currentRound: 0,
    maxRounds: request.maxRounds ?? null,
    input: normalized,
    artifacts: [],
    sessions: {},
    latestWorkerOutput: `noop accepted input:\n${toPreview(normalized)}`,
    latestCriticVerdict: null,
    originalTask: null,
    currentTask: null,
    ...(request.origin ? { origin: request.origin } : {}),
    ...(request.reporting ? { reporting: request.reporting } : {}),
    createdAt: now,
    updatedAt: now,
  };
  ctx.persist(record);
  ctx.trace.emit({
    kind: "run_completed",
    stepId: "run",
    status: "done",
    summary: record.terminalReason ?? "Noop workflow completed immediately.",
  });
  await emitTracedWorkflowReportEvent({
    trace: ctx.trace,
    stepId: "run",
    moduleId: "noop",
    runId: ctx.runId,
    phase: "workflow_done",
    eventType: "completed",
    messageText: record.latestWorkerOutput ?? "Noop workflow completed immediately.",
    emittingAgentId: "main",
    origin: request.origin,
    reporting: request.reporting,
    status: "done",
  });
  return record;
}

export const noopWorkflowModule: WorkflowModule = {
  manifest: {
    moduleId: "noop",
    displayName: "Noop Reference Workflow",
    description:
      "Minimal referenzierbares Workflow-Modul zum Testen von start/status/describe/runs.",
    kind: "maintenance_workflow",
    version: "1.1.0",
    requiredAgents: [],
    terminalStates: ["done", "aborted", "failed"],
    supportsAbort: true,
    inputSchemaSummary: [
      "beliebiges JSON-Objekt oder String",
      "wird nur als Referenzinput gespeichert",
    ],
    artifactContract: ["keine Artefakte", "latestWorkerOutput enthält nur ein Input-Echo"],
  },
  start,
};
