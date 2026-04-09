import type { WorkflowModule, WorkflowRunRecord, WorkflowStartRequest } from "../types.js";

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
  ctx: { runId: string; nowIso(): string; persist(record: WorkflowRunRecord): void },
): Promise<WorkflowRunRecord> {
  const now = ctx.nowIso();
  const normalized = normalizeInput(request.input);
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
    createdAt: now,
    updatedAt: now,
  };
  ctx.persist(record);
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
