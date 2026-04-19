import type { WorkflowRunRecord } from "../../types.js";

export type RalphWorkflowModuleId = "self_ralph" | "ralph_from_specs";

export type ExecutionMode = "plan_only" | "existing_repo" | "bootstrap_project";

export type PhaseName = "brainstorming" | "specs" | "prd";

export type PlanningStatus =
  | "brainstorming"
  | "specs"
  | "prd"
  | "ready_for_execution"
  | "planning_done"
  | "execution";

export type SharedRalphInput = {
  workingDirectory: string;
  successCriteria: string[];
  constraints: string[];
  maxPRDRounds: number;
  maxExecutionRounds: number;
  maxStories?: number;
  plannerAgentId: string;
  reviewerAgentId: string;
  workerAgentId: string;
  plannerModel?: string;
  reviewerModel?: string;
  workerModel?: string;
  executionMode: ExecutionMode;
  repoRoot?: string;
  projectSlug?: string;
  bootstrapTemplate?: string;
};

export type SelfRalphInput = SharedRalphInput & {
  direction: string;
  maxBrainstormingRounds: number;
  maxSpecsRounds: number;
};

export type RalphFromSpecsInput = SharedRalphInput & {
  specs: string;
  direction?: string;
  selectedConcept?: string;
};

export type RalphWorkflowInput = SelfRalphInput | RalphFromSpecsInput;

export type PhaseReviewVerdict = {
  verdict: "APPROVE" | "REVISE" | "BLOCK";
  reason: string[];
  gaps: string[];
  revisionRequest: string[];
  raw: string;
};

export type StorySeed = {
  id: string;
  title: string;
  task: string;
  acceptanceCriteria: string[];
};

export type ExecutionReviewDecision = {
  decision: "DONE" | "CONTINUE" | "BLOCKED";
  reason: string[];
  learnings: string[];
  nextTask: string[];
  raw: string;
};

export type StoryState = StorySeed & {
  status: "open" | "in_progress" | "done" | "blocked";
  currentTask: string;
  learnings: string[];
  attempts: number;
  lastDecision: ExecutionReviewDecision["decision"] | null;
  decisionReason: string[];
  lastRound: number | null;
  completedAt?: string;
  blockedAt?: string;
};

export type WorkspaceContext = {
  workspaceRoot: string;
  workspaceArtifactsDir: string;
};

export type ExecutionWorkspaceContext = {
  executionMode: ExecutionMode;
  workspaceRoot: string;
  executionWorkspace: string;
  repoRoot: string;
  absoluteGitDir: string;
  gitCommonDir: string;
  linkedWorktree: boolean;
  bootstrapTargetPath?: string;
};

export type VerificationEvidenceKind = "test" | "lint" | "build" | "typecheck" | "smoke" | "check";

export type VerificationEvidenceOutcome = "passed" | "failed" | "unknown";

export type VerificationEvidenceItem = {
  source: "worker_output";
  kind: VerificationEvidenceKind;
  outcomeHint: VerificationEvidenceOutcome;
  summary: string;
  command?: string;
};

export type ExecutionEvidencePack = {
  repoContext: ExecutionWorkspaceContext;
  gitStatus: string[];
  diffStat: string[];
  changedFiles: string[];
  verification: VerificationEvidenceItem[];
  verificationEvidence: string[];
  warnings: string[];
};

export type PlanningMetadata = {
  selectedConcept: string | null;
  brainstormingOptions: string[];
};

export type ExecutionStateArtifact = {
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  direction: string;
  planningStatus: PlanningStatus;
  executionMode: ExecutionMode;
  workspaceRoot: string;
  repoRoot?: string;
  bootstrapTargetPath?: string;
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
  completedAt?: string;
  blockedAt?: string;
};

export type ApprovedSpecsSeed = {
  directionLabel: string;
  approvedSpecs: string;
  approvedBrainstorming?: string;
  selectedConcept?: string | null;
  brainstormingOptions?: string[];
};

export type RalphWorkflowState = {
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  planningStatus: PlanningStatus;
  currentTask: string | null;
  currentRound: number;
  selectedConcept: string | null;
  brainstormingOptions: string[];
  executionContext: ExecutionWorkspaceContext | null;
  latestWorkerOutput: string | null;
  latestCriticVerdict: string | null;
};

export const DEFAULT_MAX_BRAINSTORMING_ROUNDS = 2;
export const DEFAULT_MAX_SPECS_ROUNDS = 2;
export const DEFAULT_MAX_PRD_ROUNDS = 2;
export const DEFAULT_MAX_EXECUTION_ROUNDS = 6;
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "bootstrap_project";
