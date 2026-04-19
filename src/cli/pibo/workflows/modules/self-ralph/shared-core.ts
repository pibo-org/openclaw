import { runWorkflowAgentOnSession } from "../../agent-runtime.js";
import type { WorkflowModuleContext, WorkflowRunSessions, WorkflowStartRequest } from "../../types.js";
import { emitTracedWorkflowReportEvent } from "../../workflow-reporting.js";
import { ensureWorkflowSessions } from "../../workflow-session-helper.js";
import { summarizeDecisionLines, stepIdForPhase } from "./artifacts.js";
import type { RalphRuntimeHarness } from "./artifacts.js";
import { parsePhaseReviewVerdict, parseStoryBacklog } from "./common.js";
import {
  prepareBootstrapProject,
  runRalphExecutionLoop,
  validateExecutionWorkspace,
} from "./execution.js";
import { buildPhasePrompt, buildPhaseReviewPrompt, buildStoryPlannerPrompt } from "./planning.js";
import type {
  ApprovedSpecsSeed,
  RalphWorkflowInput,
  RalphWorkflowModuleId,
  RalphWorkflowState,
  StoryState,
} from "./types.js";

export async function runRalphSharedCoreFromApprovedSpecs(params: {
  moduleId: RalphWorkflowModuleId;
  request: WorkflowStartRequest;
  ctx: WorkflowModuleContext;
  input: RalphWorkflowInput;
  state: RalphWorkflowState;
  sessions: WorkflowRunSessions;
  harness: RalphRuntimeHarness;
  seed: ApprovedSpecsSeed;
}) {
  const phaseArtifacts = {
    brainstorming: params.seed.approvedBrainstorming ?? "",
    specs: params.seed.approvedSpecs,
    prd: "",
  };
  params.state.selectedConcept = params.seed.selectedConcept ?? params.state.selectedConcept;
  params.state.brainstormingOptions = [...(params.seed.brainstormingOptions ?? [])];

  let revisionRequest: string[] = [];
  let approved = false;
  let latestPhaseArtifact = "";
  params.state.planningStatus = "prd";

  for (let phaseRound = 1; phaseRound <= params.input.maxPRDRounds; phaseRound += 1) {
    params.ctx.throwIfAbortRequested?.();
    params.state.currentRound += 1;
    params.state.currentTask = `prd round ${phaseRound}`;
    const stepId = stepIdForPhase("prd", phaseRound);
    const workerSessions = await ensureWorkflowSessions({
      runId: params.ctx.runId,
      specs: [
        {
          role: "worker",
          agentId: params.input.plannerAgentId,
          label: `Workflow ${params.ctx.runId} prd draft ${phaseRound}`,
          name: `prd-draft-${phaseRound}`,
          model: params.input.plannerModel,
          policy: "reset-on-reuse",
        },
        {
          role: "critic",
          agentId: params.input.reviewerAgentId,
          label: `Workflow ${params.ctx.runId} prd review ${phaseRound}`,
          name: `prd-review-${phaseRound}`,
          model: params.input.reviewerModel,
          policy: "reset-on-reuse",
        },
      ],
    });
    params.sessions.worker = workerSessions.worker;
    params.sessions.critic = workerSessions.critic;

    const phasePrompt = buildPhasePrompt({
      workflowLabel: "a Ralph workflow operating from approved specs",
      phase: "prd",
      round: phaseRound,
      maxRounds: params.input.maxPRDRounds,
      directionLabel: params.seed.directionLabel,
      executionMode: params.input.executionMode,
      workspaceRoot: params.input.workingDirectory,
      successCriteria: params.input.successCriteria,
      constraints: params.input.constraints,
      approvedBrainstorming: phaseArtifacts.brainstorming,
      approvedSpecs: phaseArtifacts.specs,
      priorArtifact: latestPhaseArtifact,
      revisionRequest,
    });
    params.harness.writeArtifact(
      `prd-round-${phaseRound}-prompt.md`,
      phasePrompt,
      "prd prompt",
      stepId,
      "worker",
    );

    const draft = await runWorkflowAgentOnSession({
      sessionKey: workerSessions.worker!,
      message: phasePrompt,
      idempotencyKey: `${params.ctx.runId}-prd-draft-${phaseRound}`,
      abortSignal: params.ctx.abortSignal,
    });
    params.ctx.throwIfAbortRequested?.();
    params.state.latestWorkerOutput = draft.text;
    latestPhaseArtifact = draft.text;
    params.harness.writeArtifact(
      `prd-round-${phaseRound}-draft.md`,
      draft.text,
      "prd draft",
      stepId,
      "worker",
    );

    const reviewPrompt = buildPhaseReviewPrompt({
      workflowLabel: "a Ralph workflow operating from approved specs",
      phase: "prd",
      round: phaseRound,
      maxRounds: params.input.maxPRDRounds,
      directionLabel: params.seed.directionLabel,
      successCriteria: params.input.successCriteria,
      constraints: params.input.constraints,
      draft: draft.text,
    });
    params.harness.writeArtifact(
      `prd-round-${phaseRound}-review-prompt.md`,
      reviewPrompt,
      "prd review prompt",
      stepId,
      "critic",
    );

    const reviewRun = await runWorkflowAgentOnSession({
      sessionKey: workerSessions.critic!,
      message: reviewPrompt,
      idempotencyKey: `${params.ctx.runId}-prd-review-${phaseRound}`,
      abortSignal: params.ctx.abortSignal,
    });
    const review = parsePhaseReviewVerdict(params.moduleId, reviewRun.text);
    params.state.latestCriticVerdict = review.raw;
    params.harness.writeArtifact(
      `prd-round-${phaseRound}-review.txt`,
      review.raw,
      `prd review verdict ${review.verdict}`,
      stepId,
      "critic",
    );
    params.harness.persist();

    if (review.verdict === "BLOCK") {
      params.state.status = "blocked";
      params.state.terminalReason = `prd blocked: ${summarizeDecisionLines(review.reason)}`;
      params.ctx.trace.emit({
        kind: "run_blocked",
        stepId,
        round: params.state.currentRound,
        role: "critic",
        status: params.state.status,
        summary: params.state.terminalReason,
      });
      const summary = params.harness.writeRunSummary([]);
      await params.harness.emitTerminalReport(params.state.status, summary);
      return params.harness.persist();
    }

    if (review.verdict === "APPROVE") {
      approved = true;
      phaseArtifacts.prd = draft.text;
      params.harness.writeArtifact(
        "prd-final.md",
        draft.text,
        "prd approved artifact",
        stepId,
        "worker",
      );
      await emitTracedWorkflowReportEvent({
        trace: params.ctx.trace,
        stepId,
        moduleId: params.moduleId,
        runId: params.ctx.runId,
        phase: "prd_approved",
        eventType: "milestone",
        messageText: [
          "Completed prd phase.",
          `Round: ${phaseRound}/${params.input.maxPRDRounds}`,
          `Reason: ${summarizeDecisionLines(review.reason)}`,
        ].join("\n"),
        emittingAgentId: params.input.reviewerAgentId,
        origin: params.request.origin,
        reporting: params.request.reporting,
        status: "running",
        role: "critic",
        targetSessionKey: params.sessions.orchestrator,
        traceSummary: "prd phase approved",
      });
      break;
    }

    revisionRequest = review.revisionRequest;
  }

  if (!approved) {
    params.state.status = "max_rounds_reached";
    params.state.terminalReason = "prd exhausted its review rounds without approval.";
    params.ctx.trace.emit({
      kind: "run_status_changed",
      stepId: "phase-prd",
      round: params.state.currentRound,
      status: params.state.status,
      summary: params.state.terminalReason,
    });
    const summary = params.harness.writeRunSummary([]);
    await params.harness.emitTerminalReport(params.state.status, summary);
    return params.harness.persist();
  }

  params.state.planningStatus = "ready_for_execution";
  params.state.currentTask = "story backlog planning";
  const backlogSessions = await ensureWorkflowSessions({
    runId: params.ctx.runId,
    specs: [
      {
        role: "worker",
        agentId: params.input.plannerAgentId,
        label: `Workflow ${params.ctx.runId} story planner`,
        name: "story-planner",
        model: params.input.plannerModel,
        policy: "reset-on-reuse",
      },
    ],
  });
  params.sessions.worker = backlogSessions.worker;
  const backlogPrompt = buildStoryPlannerPrompt({
    directionLabel: params.seed.directionLabel,
    selectedConcept: params.state.selectedConcept,
    prd: phaseArtifacts.prd,
    maxStories: params.input.maxStories,
  });
  params.harness.writeArtifact(
    "story-backlog-prompt.md",
    backlogPrompt,
    "story backlog planner prompt",
    "story-planner",
    "worker",
  );
  const backlogRun = await runWorkflowAgentOnSession({
    sessionKey: backlogSessions.worker!,
    message: backlogPrompt,
    idempotencyKey: `${params.ctx.runId}-story-backlog`,
    abortSignal: params.ctx.abortSignal,
  });
  params.ctx.throwIfAbortRequested?.();
  const stories = parseStoryBacklog(params.moduleId, backlogRun.text);
  params.harness.writeArtifact(
    "story-backlog.json",
    JSON.stringify({ stories }, null, 2),
    "parsed story backlog",
    "story-planner",
    "worker",
  );

  const globalLearnings: string[] = [];
  const firstStory = stories[0] ?? null;
  let lastExecutionDecision: StoryState["lastDecision"] = null;
  let lastExecutionReason: string[] = [];
  let lastExecutionRound: number | null = null;
  let executionCompletedAt: string | null = null;
  let executionBlockedAt: string | null = null;

  params.harness.writeExecutionStateArtifact({
    stepId: "story-planner",
    activeStoryId: firstStory?.id ?? null,
    nextTask: firstStory?.currentTask ?? null,
    stories,
    lastDecision: lastExecutionDecision,
    decisionReason: lastExecutionReason,
    lastRound: lastExecutionRound,
    globalLearnings,
  });
  params.harness.persist();

  if (params.input.executionMode === "plan_only") {
    params.state.planningStatus = "planning_done";
    params.state.status = "planning_done";
    params.state.terminalReason = "Planning completed without execution.";
    params.state.currentTask = null;
    params.harness.writeExecutionStateArtifact({
      stepId: "run",
      activeStoryId: firstStory?.id ?? null,
      nextTask: firstStory?.currentTask ?? null,
      stories,
      lastDecision: lastExecutionDecision,
      decisionReason: lastExecutionReason,
      lastRound: lastExecutionRound,
      globalLearnings,
      completedAt: params.ctx.nowIso(),
    });
    const summary = params.harness.writeRunSummary(stories);
    params.ctx.trace.emit({
      kind: "run_completed",
      stepId: "run",
      round: params.state.currentRound,
      role: "orchestrator",
      status: params.state.status,
      summary: params.state.terminalReason,
    });
    await params.harness.emitTerminalReport(params.state.status, summary);
    return params.harness.persist();
  }

  if (params.input.executionMode === "existing_repo") {
    if (!params.input.repoRoot) {
      throw new Error(
        `${params.moduleId} benötigt \`input.repoRoot\` bei \`executionMode=existing_repo\` vor Execution-Beginn.`,
      );
    }
    params.state.executionContext = validateExecutionWorkspace({
      moduleId: params.moduleId,
      workspaceRoot: params.input.workingDirectory,
      executionWorkspace: params.input.repoRoot,
      executionMode: params.input.executionMode,
      fieldName: "repoRoot",
    });
  } else {
    const bootstrap = prepareBootstrapProject({
      moduleId: params.moduleId,
      workspaceRoot: params.input.workingDirectory,
      selectedConcept: params.state.selectedConcept,
      directionLabel: params.seed.directionLabel,
      projectSlug: params.input.projectSlug,
    });
    params.harness.writeArtifact(
      "project-bootstrap.json",
      JSON.stringify(
        {
          executionMode: params.input.executionMode,
          workspaceRoot: params.input.workingDirectory,
          projectSlug: bootstrap.projectSlug,
          bootstrapTargetPath: bootstrap.bootstrapTargetPath,
          bootstrapTemplate: params.input.bootstrapTemplate ?? null,
          derivedFrom: params.state.selectedConcept ?? params.seed.directionLabel,
        },
        null,
        2,
      ),
      "bootstrap project preparation",
      "execution-readiness",
      "orchestrator",
    );
    params.state.executionContext = validateExecutionWorkspace({
      moduleId: params.moduleId,
      workspaceRoot: params.input.workingDirectory,
      executionWorkspace: bootstrap.bootstrapTargetPath,
      executionMode: params.input.executionMode,
      fieldName: "bootstrapTargetPath",
      bootstrapTargetPath: bootstrap.bootstrapTargetPath,
    });
  }

  params.state.planningStatus = "execution";
  params.harness.writeExecutionStateArtifact({
    stepId: "execution-readiness",
    activeStoryId: firstStory?.id ?? null,
    nextTask: firstStory?.currentTask ?? null,
    stories,
    lastDecision: lastExecutionDecision,
    decisionReason: lastExecutionReason,
    lastRound: lastExecutionRound,
    globalLearnings,
  });
  params.harness.persist();

  const executionResult = await runRalphExecutionLoop({
    moduleId: params.moduleId,
    request: params.request,
    ctx: params.ctx,
    input: params.input,
    state: params.state,
    sessions: params.sessions,
    harness: params.harness,
    stories,
    approvedBrainstorming: phaseArtifacts.brainstorming,
    approvedSpecs: phaseArtifacts.specs,
    prd: phaseArtifacts.prd,
    globalLearnings,
  });
  lastExecutionDecision = executionResult.lastExecutionDecision;
  lastExecutionReason = executionResult.lastExecutionReason;
  lastExecutionRound = executionResult.lastExecutionRound;
  executionCompletedAt = executionResult.executionCompletedAt;
  executionBlockedAt = executionResult.executionBlockedAt;

  if (params.state.status === "running") {
    const remainingStory = stories.find((story) => story.status !== "done");
    if (remainingStory) {
      params.state.status = "max_rounds_reached";
      params.state.terminalReason = `Execution budget exhausted with remaining story ${remainingStory.id}.`;
      params.harness.writeExecutionStateArtifact({
        stepId: "run",
        activeStoryId: remainingStory.id,
        nextTask: remainingStory.currentTask,
        stories,
        lastDecision: lastExecutionDecision,
        decisionReason: lastExecutionReason,
        lastRound: lastExecutionRound,
        globalLearnings,
        blockedAt: executionBlockedAt,
      });
    } else {
      params.state.status = "done";
      params.state.terminalReason = params.state.terminalReason ?? "All stories completed.";
      executionCompletedAt = executionCompletedAt ?? params.ctx.nowIso();
      params.harness.writeExecutionStateArtifact({
        stepId: "run",
        activeStoryId: null,
        nextTask: null,
        stories,
        lastDecision: lastExecutionDecision,
        decisionReason: lastExecutionReason,
        lastRound: lastExecutionRound,
        globalLearnings,
        completedAt: executionCompletedAt,
        blockedAt: executionBlockedAt,
      });
    }
  }

  const summary = params.harness.writeRunSummary(stories);
  if (params.state.status === "done") {
    params.ctx.trace.emit({
      kind: "run_completed",
      stepId: "run",
      round: params.state.currentRound,
      role: "orchestrator",
      status: params.state.status,
      summary: params.state.terminalReason ?? "workflow completed",
    });
    await params.harness.emitTerminalReport(params.state.status, summary);
  } else {
    params.ctx.trace.emit({
      kind: "run_blocked",
      stepId: "run",
      round: params.state.currentRound,
      role: "orchestrator",
      status: params.state.status,
      summary: params.state.terminalReason ?? "workflow stopped",
    });
    await params.harness.emitTerminalReport(params.state.status, summary);
  }

  return params.harness.persist();
}
