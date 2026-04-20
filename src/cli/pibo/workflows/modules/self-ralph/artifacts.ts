import fs from "node:fs";
import path from "node:path";
import { writeWorkflowArtifact } from "../../store.js";
import type {
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../../types.js";
import type { WorkflowReportEvent } from "../../workflow-reporting.js";
import { emitTracedWorkflowReportEvent } from "../../workflow-reporting.js";
import { workspaceArtifactDirectoryName } from "./common.js";
import type {
  ExecutionReviewDecision,
  ExecutionStateArtifact,
  ExecutionWorkspaceContext,
  PlanningStatus,
  RalphWorkflowInput,
  RalphWorkflowModuleId,
  RalphWorkflowState,
  StoryState,
  WorkspaceContext,
} from "./types.js";

export function buildExecutionState(params: {
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  direction: string;
  planningStatus: PlanningStatus;
  executionMode: RalphWorkflowInput["executionMode"];
  workspaceRoot: string;
  executionContext: ExecutionWorkspaceContext | null;
  selectedConcept: string | null;
  brainstormingOptions: string[];
  activeStoryId: string | null;
  nextTask: string | null;
  lastDecision: ExecutionReviewDecision["decision"] | null;
  decisionReason: string[];
  lastRound: number | null;
  globalLearnings: string[];
  stories: StoryState[];
  updatedAt: string;
  completedAt?: string | null;
  blockedAt?: string | null;
}): ExecutionStateArtifact {
  return {
    status: params.status,
    terminalReason: params.terminalReason,
    direction: params.direction,
    planningStatus: params.planningStatus,
    executionMode: params.executionMode,
    workspaceRoot: params.workspaceRoot,
    ...(params.executionContext?.repoRoot ? { repoRoot: params.executionContext.repoRoot } : {}),
    ...(params.executionContext?.bootstrapTargetPath
      ? { bootstrapTargetPath: params.executionContext.bootstrapTargetPath }
      : {}),
    selectedConcept: params.selectedConcept,
    brainstormingOptions: [...params.brainstormingOptions],
    activeStoryId: params.activeStoryId,
    nextTask: params.nextTask,
    lastDecision: params.lastDecision,
    decisionReason: [...params.decisionReason],
    lastRound: params.lastRound,
    globalLearnings: [...params.globalLearnings],
    stories: params.stories.map((story) => ({
      ...story,
      acceptanceCriteria: [...story.acceptanceCriteria],
      learnings: [...story.learnings],
      decisionReason: [...story.decisionReason],
    })),
    updatedAt: params.updatedAt,
    ...(params.completedAt ? { completedAt: params.completedAt } : {}),
    ...(params.blockedAt ? { blockedAt: params.blockedAt } : {}),
  };
}

export function summarizeDecisionLines(values: string[]): string {
  return values.length ? values.join(" | ") : "none";
}

export function buildRunSummary(params: {
  input: RalphWorkflowInput;
  directionLabel: string;
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  totalRounds: number;
  selectedConcept: string | null;
  stories: StoryState[];
  sessions: WorkflowRunRecord["sessions"];
  executionContext: ExecutionWorkspaceContext | null;
}) {
  return [
    `Status: ${params.status}`,
    `Terminal reason: ${params.terminalReason ?? "n/a"}`,
    `Total rounds: ${params.totalRounds}`,
    `Direction: ${params.directionLabel}`,
    `Execution mode: ${params.input.executionMode}`,
    `Workspace root: ${params.input.workingDirectory}`,
    `Selected concept: ${params.selectedConcept ?? "n/a"}`,
    `Execution workspace: ${params.executionContext?.executionWorkspace ?? "n/a"}`,
    `Repo root: ${params.executionContext?.repoRoot ?? params.input.repoRoot ?? "n/a"}`,
    `Planner agent: ${params.input.plannerAgentId}`,
    `Reviewer agent: ${params.input.reviewerAgentId}`,
    `Worker agent: ${params.input.workerAgentId}`,
    `Orchestrator session: ${params.sessions.orchestrator ?? "n/a"}`,
    `Last worker session: ${params.sessions.worker ?? "n/a"}`,
    `Last critic session: ${params.sessions.critic ?? "n/a"}`,
    "",
    "Stories:",
    ...params.stories.map(
      (story) =>
        `- ${story.id} [${story.status}] ${story.title} :: attempts=${story.attempts} :: currentTask=${story.currentTask}`,
    ),
  ].join("\n");
}

export function buildRecord(params: {
  moduleId: RalphWorkflowModuleId;
  runId: string;
  input: RalphWorkflowInput;
  sessions: WorkflowRunRecord["sessions"];
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  currentRound: number;
  maxRounds: number;
  artifacts: string[];
  latestWorkerOutput: string | null;
  latestCriticVerdict: string | null;
  originalTask: string;
  currentTask: string | null;
  origin?: WorkflowRunRecord["origin"];
  reporting?: WorkflowRunRecord["reporting"];
  createdAt: string;
  updatedAt: string;
}): WorkflowRunRecord {
  return {
    runId: params.runId,
    moduleId: params.moduleId,
    status: params.status,
    terminalReason: params.terminalReason,
    abortRequested: false,
    abortRequestedAt: null,
    currentRound: params.currentRound,
    maxRounds: params.maxRounds,
    input: params.input,
    artifacts: [...params.artifacts],
    sessions: params.sessions,
    latestWorkerOutput: params.latestWorkerOutput,
    latestCriticVerdict: params.latestCriticVerdict,
    originalTask: params.originalTask,
    currentTask: params.currentTask,
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.reporting ? { reporting: params.reporting } : {}),
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

export function stepIdForPhase(phase: "brainstorming" | "specs" | "prd", round: number): string {
  return `${phase}-round-${round}`;
}

export function stepIdForExecution(round: number): string {
  return `execution-round-${round}`;
}

function shouldMirrorWorkspaceArtifact(name: string): boolean {
  return (
    name === "brainstorming-final.md" ||
    name === "brainstorming-options.json" ||
    name === "specs-final.md" ||
    name === "prd-final.md" ||
    name === "story-backlog.json" ||
    name === "execution-state.json" ||
    name === "run-summary.txt" ||
    name === "project-bootstrap.json" ||
    /^execution-round-\d+-evidence\.json$/.test(name)
  );
}

function mirrorWorkspaceArtifact(workspaceArtifactsDir: string, name: string, content: string) {
  if (!shouldMirrorWorkspaceArtifact(name)) {
    return;
  }
  fs.mkdirSync(workspaceArtifactsDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceArtifactsDir, name), content, "utf8");
}

export type RalphRuntimeHarness = {
  persist(): WorkflowRunRecord;
  writeArtifact(
    name: string,
    content: string,
    summary: string,
    stepId: string,
    role: string,
  ): string;
  emitTerminalReport(finalStatus: WorkflowRunRecord["status"], messageText: string): Promise<void>;
  writeExecutionStateArtifact(params: {
    stepId: string;
    activeStoryId: string | null;
    nextTask: string | null;
    stories: StoryState[];
    lastDecision: ExecutionReviewDecision["decision"] | null;
    decisionReason: string[];
    lastRound: number | null;
    globalLearnings: string[];
    completedAt?: string | null;
    blockedAt?: string | null;
  }): void;
  writeRunSummary(stories: StoryState[]): string;
};

export function createRalphRuntimeHarness(params: {
  moduleId: RalphWorkflowModuleId;
  request: WorkflowStartRequest;
  ctx: WorkflowModuleContext;
  input: RalphWorkflowInput;
  directionLabel: string;
  createdAt: string;
  workspaceContext: WorkspaceContext;
  sessions: WorkflowRunRecord["sessions"];
  artifacts: string[];
  state: RalphWorkflowState;
  maxRounds: number;
}): RalphRuntimeHarness {
  type RalphTerminalReportStatus = Exclude<WorkflowReportEvent["status"], "running" | undefined>;

  const toTerminalReportStatus = (
    status: WorkflowRunRecord["status"],
  ): RalphTerminalReportStatus => {
    switch (status) {
      case "done":
      case "planning_done":
      case "blocked":
      case "failed":
      case "max_rounds_reached":
        return status;
      default:
        throw new Error(
          `self_ralph cannot emit terminal report for non-terminal status ${status}.`,
        );
    }
  };

  const persist = () => {
    const record = buildRecord({
      moduleId: params.moduleId,
      runId: params.ctx.runId,
      input: params.input,
      sessions: params.sessions,
      status: params.state.status,
      terminalReason: params.state.terminalReason,
      currentRound: params.state.currentRound,
      maxRounds: params.maxRounds,
      artifacts: params.artifacts,
      latestWorkerOutput: params.state.latestWorkerOutput,
      latestCriticVerdict: params.state.latestCriticVerdict,
      originalTask: params.directionLabel,
      currentTask: params.state.currentTask,
      origin: params.request.origin,
      reporting: params.request.reporting,
      createdAt: params.createdAt,
      updatedAt: params.ctx.nowIso(),
    });
    params.ctx.persist(params.ctx.trace.attachToRunRecord(record));
    return record;
  };

  const writeArtifact = (
    name: string,
    content: string,
    summary: string,
    stepId: string,
    role: string,
  ) => {
    const artifactPath = writeWorkflowArtifact(params.ctx.runId, name, content);
    params.artifacts.push(artifactPath);
    mirrorWorkspaceArtifact(params.workspaceContext.workspaceArtifactsDir, name, content);
    params.ctx.trace.emit({
      kind: "artifact_written",
      stepId,
      round: params.state.currentRound,
      role,
      artifactPath,
      summary,
    });
    return artifactPath;
  };

  const emitTerminalReport: RalphRuntimeHarness["emitTerminalReport"] = async (
    finalStatus,
    messageText,
  ) => {
    const isCompleted = finalStatus === "done" || finalStatus === "planning_done";
    const reportStatus = toTerminalReportStatus(finalStatus);
    await emitTracedWorkflowReportEvent({
      trace: params.ctx.trace,
      stepId: "run",
      moduleId: params.moduleId,
      runId: params.ctx.runId,
      phase: isCompleted
        ? finalStatus === "planning_done"
          ? "workflow_planning_done"
          : "workflow_done"
        : "workflow_blocked",
      eventType: isCompleted ? "completed" : "blocked",
      messageText,
      emittingAgentId: params.input.reviewerAgentId,
      origin: params.request.origin,
      reporting: params.request.reporting,
      status: reportStatus,
      role: "orchestrator",
      targetSessionKey: params.sessions.orchestrator,
      traceSummary: isCompleted ? "workflow completed" : "workflow terminal blocked-style report",
    });
  };

  const writeExecutionStateArtifact: RalphRuntimeHarness["writeExecutionStateArtifact"] = (
    executionState,
  ) => {
    const snapshot = buildExecutionState({
      status: params.state.status,
      terminalReason: params.state.terminalReason,
      direction: params.directionLabel,
      planningStatus: params.state.planningStatus,
      executionMode: params.input.executionMode,
      workspaceRoot: params.input.workingDirectory,
      executionContext: params.state.executionContext,
      selectedConcept: params.state.selectedConcept,
      brainstormingOptions: params.state.brainstormingOptions,
      activeStoryId: executionState.activeStoryId,
      nextTask: executionState.nextTask,
      lastDecision: executionState.lastDecision,
      decisionReason: executionState.decisionReason,
      lastRound: executionState.lastRound,
      globalLearnings: executionState.globalLearnings,
      stories: executionState.stories,
      updatedAt: params.ctx.nowIso(),
      completedAt: executionState.completedAt,
      blockedAt: executionState.blockedAt,
    });
    writeArtifact(
      "execution-state.json",
      JSON.stringify(snapshot, null, 2),
      "execution state snapshot",
      executionState.stepId,
      "orchestrator",
    );
  };

  const writeRunSummary = (stories: StoryState[]) => {
    const summary = buildRunSummary({
      input: params.input,
      directionLabel: params.directionLabel,
      status: params.state.status,
      terminalReason: params.state.terminalReason,
      totalRounds: params.state.currentRound,
      selectedConcept: params.state.selectedConcept,
      stories,
      sessions: params.sessions,
      executionContext: params.state.executionContext,
    });
    writeArtifact("run-summary.txt", summary, "terminal run summary", "run", "orchestrator");
    return summary;
  };

  return {
    persist,
    writeArtifact,
    emitTerminalReport,
    writeExecutionStateArtifact,
    writeRunSummary,
  };
}

export function resolveWorkspaceArtifactsDir(
  moduleId: RalphWorkflowModuleId,
  workingDirectory: string,
): string {
  return path.join(workingDirectory, workspaceArtifactDirectoryName(moduleId));
}
