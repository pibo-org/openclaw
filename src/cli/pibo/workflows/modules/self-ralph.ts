import path from "node:path";
import { runWorkflowAgentOnSession } from "../agent-runtime.js";
import type {
  WorkflowModule,
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../types.js";
import { emitTracedWorkflowReportEvent } from "../workflow-reporting.js";
import { ensureWorkflowSessions } from "../workflow-session-helper.js";
import { selfRalphWorkflowModuleManifest } from "./manifests.js";
import {
  createRalphRuntimeHarness,
  stepIdForPhase,
  summarizeDecisionLines,
} from "./self-ralph/artifacts.js";
import {
  normalizeExecutionMode,
  normalizeOptionalPositiveInteger,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeStringArray,
  parsePhaseReviewVerdict,
} from "./self-ralph/common.js";
import { validateWorkspaceDirectory } from "./self-ralph/execution.js";
import {
  buildPhasePrompt,
  buildPhaseReviewPrompt,
  parseBrainstormingMetadata,
} from "./self-ralph/planning.js";
import { runRalphSharedCoreFromApprovedSpecs } from "./self-ralph/shared-core.js";
import {
  DEFAULT_MAX_BRAINSTORMING_ROUNDS,
  DEFAULT_MAX_EXECUTION_ROUNDS,
  DEFAULT_MAX_PRD_ROUNDS,
  DEFAULT_MAX_SPECS_ROUNDS,
  type RalphWorkflowState,
  type SelfRalphInput,
} from "./self-ralph/types.js";

function normalizeInput(request: WorkflowStartRequest): SelfRalphInput {
  const record = request.input as Record<string, unknown>;
  if (!record || typeof record !== "object") {
    throw new Error("self_ralph erwartet ein JSON-Objekt als Input.");
  }
  const direction = typeof record.direction === "string" ? record.direction.trim() : "";
  const rawWorkingDirectory =
    typeof record.workingDirectory === "string" ? record.workingDirectory.trim() : "";
  if (!direction) {
    throw new Error("self_ralph benötigt ein nicht-leeres Feld `direction`.");
  }
  if (!rawWorkingDirectory) {
    throw new Error("self_ralph benötigt `input.workingDirectory` als Workspace-Root.");
  }
  return {
    direction,
    workingDirectory: path.resolve(rawWorkingDirectory),
    successCriteria: normalizeStringArray(record.successCriteria),
    constraints: normalizeStringArray(record.constraints),
    maxBrainstormingRounds: normalizePositiveInteger(
      record.maxBrainstormingRounds,
      DEFAULT_MAX_BRAINSTORMING_ROUNDS,
    ),
    maxSpecsRounds: normalizePositiveInteger(record.maxSpecsRounds, DEFAULT_MAX_SPECS_ROUNDS),
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
    executionMode: normalizeExecutionMode("self_ralph", record.executionMode),
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
  const workspaceContext = validateWorkspaceDirectory("self_ralph", input.workingDirectory);
  const createdAt = ctx.nowIso();
  const planningRounds = input.maxBrainstormingRounds + input.maxSpecsRounds + input.maxPRDRounds;
  const maxRounds =
    planningRounds + (input.executionMode === "plan_only" ? 0 : input.maxExecutionRounds);
  const artifacts: string[] = [];
  const state: RalphWorkflowState = {
    status: "running",
    terminalReason: null,
    planningStatus: "brainstorming",
    currentTask: input.direction,
    currentRound: 0,
    selectedConcept: null,
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
        label: `Workflow ${ctx.runId} Self Ralph Orchestrator`,
        name: "orchestrator",
        model: input.plannerModel,
        policy: "reset-on-reuse",
      },
    ],
  });

  const harness = createRalphRuntimeHarness({
    moduleId: "self_ralph",
    request,
    ctx,
    input,
    directionLabel: input.direction,
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
    summary: `self_ralph started for ${input.direction}`,
    status: "running",
  });
  harness.persist();

  await emitTracedWorkflowReportEvent({
    trace: ctx.trace,
    stepId: "run",
    moduleId: "self_ralph",
    runId: ctx.runId,
    phase: "run_started",
    eventType: "started",
    messageText: [
      "Started self-Ralph workflow.",
      `Direction: ${input.direction}`,
      `Workspace root: ${input.workingDirectory}`,
      `Execution mode: ${input.executionMode}`,
      `Phase budgets: brainstorm=${input.maxBrainstormingRounds}, specs=${input.maxSpecsRounds}, prd=${input.maxPRDRounds}, execution=${input.maxExecutionRounds}`,
    ].join("\n"),
    emittingAgentId: input.plannerAgentId,
    origin: request.origin,
    reporting: request.reporting,
    status: "running",
    role: "orchestrator",
    targetSessionKey: sessions.orchestrator,
    traceSummary: "workflow start attempted",
  });

  const phaseArtifacts = {
    brainstorming: "",
    specs: "",
  };

  for (const [phaseName, phaseMaxRounds] of [
    ["brainstorming", input.maxBrainstormingRounds],
    ["specs", input.maxSpecsRounds],
  ] as const) {
    let revisionRequest: string[] = [];
    let approved = false;
    let latestPhaseArtifact = phaseArtifacts[phaseName];
    state.planningStatus = phaseName;

    for (let phaseRound = 1; phaseRound <= phaseMaxRounds; phaseRound += 1) {
      ctx.throwIfAbortRequested?.();
      state.currentRound += 1;
      state.currentTask = `${phaseName} round ${phaseRound}`;
      const stepId = stepIdForPhase(phaseName, phaseRound);
      const workerSessions = await ensureWorkflowSessions({
        runId: ctx.runId,
        specs: [
          {
            role: "worker",
            agentId: input.plannerAgentId,
            label: `Workflow ${ctx.runId} ${phaseName} draft ${phaseRound}`,
            name: `${phaseName}-draft-${phaseRound}`,
            model: input.plannerModel,
            policy: "reset-on-reuse",
          },
          {
            role: "critic",
            agentId: input.reviewerAgentId,
            label: `Workflow ${ctx.runId} ${phaseName} review ${phaseRound}`,
            name: `${phaseName}-review-${phaseRound}`,
            model: input.reviewerModel,
            policy: "reset-on-reuse",
          },
        ],
      });
      sessions.worker = workerSessions.worker;
      sessions.critic = workerSessions.critic;

      const phasePrompt = buildPhasePrompt({
        workflowLabel: "an ideation-first self-Ralph workflow",
        phase: phaseName,
        round: phaseRound,
        maxRounds: phaseMaxRounds,
        directionLabel: input.direction,
        executionMode: input.executionMode,
        workspaceRoot: input.workingDirectory,
        successCriteria: input.successCriteria,
        constraints: input.constraints,
        approvedBrainstorming: phaseArtifacts.brainstorming,
        approvedSpecs: phaseArtifacts.specs,
        priorArtifact: latestPhaseArtifact,
        revisionRequest,
      });
      harness.writeArtifact(
        `${phaseName}-round-${phaseRound}-prompt.md`,
        phasePrompt,
        `${phaseName} prompt`,
        stepId,
        "worker",
      );

      const draft = await runWorkflowAgentOnSession({
        sessionKey: workerSessions.worker!,
        message: phasePrompt,
        idempotencyKey: `${ctx.runId}-${phaseName}-draft-${phaseRound}`,
        abortSignal: ctx.abortSignal,
      });
      ctx.throwIfAbortRequested?.();
      state.latestWorkerOutput = draft.text;
      latestPhaseArtifact = draft.text;
      harness.writeArtifact(
        `${phaseName}-round-${phaseRound}-draft.md`,
        draft.text,
        `${phaseName} draft`,
        stepId,
        "worker",
      );

      const reviewPrompt = buildPhaseReviewPrompt({
        workflowLabel: "an ideation-first self-Ralph workflow",
        phase: phaseName,
        round: phaseRound,
        maxRounds: phaseMaxRounds,
        directionLabel: input.direction,
        successCriteria: input.successCriteria,
        constraints: input.constraints,
        draft: draft.text,
      });
      harness.writeArtifact(
        `${phaseName}-round-${phaseRound}-review-prompt.md`,
        reviewPrompt,
        `${phaseName} review prompt`,
        stepId,
        "critic",
      );

      const reviewRun = await runWorkflowAgentOnSession({
        sessionKey: workerSessions.critic!,
        message: reviewPrompt,
        idempotencyKey: `${ctx.runId}-${phaseName}-review-${phaseRound}`,
        abortSignal: ctx.abortSignal,
      });
      const review = parsePhaseReviewVerdict("self_ralph", reviewRun.text);
      state.latestCriticVerdict = review.raw;
      harness.writeArtifact(
        `${phaseName}-round-${phaseRound}-review.txt`,
        review.raw,
        `${phaseName} review verdict ${review.verdict}`,
        stepId,
        "critic",
      );
      harness.persist();

      if (review.verdict === "BLOCK") {
        state.status = "blocked";
        state.terminalReason = `${phaseName} blocked: ${summarizeDecisionLines(review.reason)}`;
        ctx.trace.emit({
          kind: "run_blocked",
          stepId,
          round: state.currentRound,
          role: "critic",
          status: state.status,
          summary: state.terminalReason,
        });
        const summary = harness.writeRunSummary([]);
        await harness.emitTerminalReport(state.status, summary);
        return harness.persist();
      }

      if (review.verdict === "APPROVE") {
        approved = true;
        phaseArtifacts[phaseName] = draft.text;
        harness.writeArtifact(
          `${phaseName}-final.md`,
          draft.text,
          `${phaseName} approved artifact`,
          stepId,
          "worker",
        );
        if (phaseName === "brainstorming") {
          const metadata = parseBrainstormingMetadata(draft.text);
          state.selectedConcept = metadata.selectedConcept;
          state.brainstormingOptions = metadata.brainstormingOptions;
          harness.writeArtifact(
            "brainstorming-options.json",
            JSON.stringify(metadata, null, 2),
            "brainstorming option summary",
            stepId,
            "worker",
          );
        }
        await emitTracedWorkflowReportEvent({
          trace: ctx.trace,
          stepId,
          moduleId: "self_ralph",
          runId: ctx.runId,
          phase: `${phaseName}_approved`,
          eventType: "milestone",
          messageText: [
            `Completed ${phaseName} phase.`,
            `Round: ${phaseRound}/${phaseMaxRounds}`,
            `Reason: ${summarizeDecisionLines(review.reason)}`,
          ].join("\n"),
          emittingAgentId: input.reviewerAgentId,
          origin: request.origin,
          reporting: request.reporting,
          status: "running",
          role: "critic",
          targetSessionKey: sessions.orchestrator,
          traceSummary: `${phaseName} phase approved`,
        });
        break;
      }

      revisionRequest = review.revisionRequest;
    }

    if (!approved) {
      state.status = "max_rounds_reached";
      state.terminalReason = `${phaseName} exhausted its review rounds without approval.`;
      ctx.trace.emit({
        kind: "run_status_changed",
        stepId: `phase-${phaseName}`,
        round: state.currentRound,
        status: state.status,
        summary: state.terminalReason,
      });
      const summary = harness.writeRunSummary([]);
      await harness.emitTerminalReport(state.status, summary);
      return harness.persist();
    }
  }

  return runRalphSharedCoreFromApprovedSpecs({
    moduleId: "self_ralph",
    request,
    ctx,
    input,
    state,
    sessions,
    harness,
    seed: {
      directionLabel: input.direction,
      approvedSpecs: phaseArtifacts.specs,
      approvedBrainstorming: phaseArtifacts.brainstorming,
      selectedConcept: state.selectedConcept,
      brainstormingOptions: state.brainstormingOptions,
    },
  });
}

export const selfRalphWorkflowModule: WorkflowModule = {
  manifest: selfRalphWorkflowModuleManifest,
  start,
};
