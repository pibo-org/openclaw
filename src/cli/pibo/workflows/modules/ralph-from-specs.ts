import path from "node:path";
import type {
  WorkflowModule,
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../types.js";
import { emitTracedWorkflowReportEvent } from "../workflow-reporting.js";
import { ensureWorkflowSessions } from "../workflow-session-helper.js";
import { ralphFromSpecsWorkflowModuleManifest } from "./manifests.js";
import { createRalphRuntimeHarness } from "./self-ralph/artifacts.js";
import {
  normalizeExecutionMode,
  normalizeOptionalPositiveInteger,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeStringArray,
} from "./self-ralph/common.js";
import { validateWorkspaceDirectory } from "./self-ralph/execution.js";
import { runRalphSharedCoreFromApprovedSpecs } from "./self-ralph/shared-core.js";
import {
  DEFAULT_MAX_EXECUTION_ROUNDS,
  DEFAULT_MAX_PRD_ROUNDS,
  type RalphFromSpecsInput,
  type RalphWorkflowState,
} from "./self-ralph/types.js";

function normalizeInput(request: WorkflowStartRequest): RalphFromSpecsInput {
  const record = request.input as Record<string, unknown>;
  if (!record || typeof record !== "object") {
    throw new Error("ralph_from_specs erwartet ein JSON-Objekt als Input.");
  }
  const specs = typeof record.specs === "string" ? record.specs.trim() : "";
  const rawWorkingDirectory =
    typeof record.workingDirectory === "string" ? record.workingDirectory.trim() : "";
  if (!specs) {
    throw new Error("ralph_from_specs benötigt ein nicht-leeres Feld `specs`.");
  }
  if (!rawWorkingDirectory) {
    throw new Error("ralph_from_specs benötigt `input.workingDirectory` als Workspace-Root.");
  }
  return {
    specs,
    direction: normalizeOptionalString(record.direction),
    selectedConcept: normalizeOptionalString(record.selectedConcept),
    workingDirectory: path.resolve(rawWorkingDirectory),
    successCriteria: normalizeStringArray(record.successCriteria),
    constraints: normalizeStringArray(record.constraints),
    maxPRDRounds: normalizePositiveInteger(record.maxPRDRounds, DEFAULT_MAX_PRD_ROUNDS),
    maxExecutionRounds: normalizePositiveInteger(
      record.maxExecutionRounds ?? request.maxRounds,
      DEFAULT_MAX_EXECUTION_ROUNDS,
    ),
    maxStories: normalizeOptionalPositiveInteger(record.maxStories),
    plannerAgentId: normalizeOptionalString(record.plannerAgentId) ?? "codex-controller",
    reviewerAgentId: normalizeOptionalString(record.reviewerAgentId) ?? "codex-controller",
    workerAgentId: normalizeOptionalString(record.workerAgentId) ?? "codex",
    plannerModel: normalizeOptionalString(record.plannerModel),
    reviewerModel: normalizeOptionalString(record.reviewerModel),
    workerModel: normalizeOptionalString(record.workerModel),
    executionMode: normalizeExecutionMode("ralph_from_specs", record.executionMode),
    repoRoot: normalizeOptionalString(record.repoRoot)
      ? path.resolve(normalizeOptionalString(record.repoRoot)!)
      : undefined,
    projectSlug: normalizeOptionalString(record.projectSlug),
    bootstrapTemplate: normalizeOptionalString(record.bootstrapTemplate),
  };
}

async function start(
  request: WorkflowStartRequest,
  ctx: WorkflowModuleContext,
): Promise<WorkflowRunRecord> {
  ctx.throwIfAbortRequested?.();
  const input = normalizeInput(request);
  const workspaceContext = validateWorkspaceDirectory("ralph_from_specs", input.workingDirectory);
  const createdAt = ctx.nowIso();
  const maxRounds =
    input.maxPRDRounds + (input.executionMode === "plan_only" ? 0 : input.maxExecutionRounds);
  const artifacts: string[] = [];
  const directionLabel = input.direction ?? input.selectedConcept ?? "Approved specs input";
  const state: RalphWorkflowState = {
    status: "running",
    terminalReason: null,
    planningStatus: "specs",
    currentTask: "trusted specs intake",
    currentRound: 0,
    selectedConcept: input.selectedConcept ?? null,
    brainstormingOptions: [],
    executionContext: null,
    latestWorkerOutput: null,
    latestCriticVerdict: null,
  };

  const sessions = await ensureWorkflowSessions({
    runId: ctx.runId,
    specs: [
      {
        role: "orchestrator",
        agentId: input.plannerAgentId,
        label: `Workflow ${ctx.runId} Ralph From Specs Orchestrator`,
        name: "orchestrator",
        model: input.plannerModel,
        policy: "reset-on-reuse",
      },
    ],
  });

  const harness = createRalphRuntimeHarness({
    moduleId: "ralph_from_specs",
    request,
    ctx,
    input,
    directionLabel,
    createdAt,
    workspaceContext,
    sessions,
    artifacts,
    state,
    maxRounds,
  });

  ctx.trace.emit({
    kind: "run_started",
    stepId: "run",
    summary: `ralph_from_specs started for ${directionLabel}`,
    status: "running",
  });
  harness.persist();

  await emitTracedWorkflowReportEvent({
    trace: ctx.trace,
    stepId: "run",
    moduleId: "ralph_from_specs",
    runId: ctx.runId,
    phase: "run_started",
    eventType: "started",
    messageText: [
      "Started Ralph-from-specs workflow.",
      `Direction: ${directionLabel}`,
      `Workspace root: ${input.workingDirectory}`,
      `Execution mode: ${input.executionMode}`,
      `Phase budgets: prd=${input.maxPRDRounds}, execution=${input.maxExecutionRounds}`,
    ].join("\n"),
    emittingAgentId: input.plannerAgentId,
    origin: request.origin,
    reporting: request.reporting,
    status: "running",
    role: "orchestrator",
    targetSessionKey: sessions.orchestrator,
    traceSummary: "workflow start attempted",
  });

  harness.writeArtifact(
    "specs-final.md",
    input.specs,
    "trusted approved specs",
    "specs-intake",
    "orchestrator",
  );
  harness.persist();

  return runRalphSharedCoreFromApprovedSpecs({
    moduleId: "ralph_from_specs",
    request,
    ctx,
    input,
    state,
    sessions,
    harness,
    seed: {
      directionLabel,
      approvedSpecs: input.specs,
      selectedConcept: input.selectedConcept ?? null,
      brainstormingOptions: [],
    },
  });
}

export const ralphFromSpecsWorkflowModule: WorkflowModule = {
  manifest: ralphFromSpecsWorkflowModuleManifest,
  start,
};
