import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runWorkflowAgentOnSession } from "../agent-runtime.js";
import { writeWorkflowArtifact } from "../store.js";
import type {
  WorkflowModule,
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../types.js";
import { emitTracedWorkflowReportEvent } from "../workflow-reporting.js";
import { ensureWorkflowSessions } from "../workflow-session-helper.js";
import { selfRalphWorkflowModuleManifest } from "./manifests.js";

type ExecutionMode = "plan_only" | "existing_repo" | "bootstrap_project";

type SelfRalphInput = {
  direction: string;
  workingDirectory: string;
  successCriteria: string[];
  constraints: string[];
  maxBrainstormingRounds: number;
  maxSpecsRounds: number;
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

type PhaseName = "brainstorming" | "specs" | "prd";
type PlanningStatus =
  | "brainstorming"
  | "specs"
  | "prd"
  | "ready_for_execution"
  | "planning_done"
  | "execution";

type PhaseReviewVerdict = {
  verdict: "APPROVE" | "REVISE" | "BLOCK";
  reason: string[];
  gaps: string[];
  revisionRequest: string[];
  raw: string;
};

type StorySeed = {
  id: string;
  title: string;
  task: string;
  acceptanceCriteria: string[];
};

type StoryState = StorySeed & {
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

type ExecutionReviewDecision = {
  decision: "DONE" | "CONTINUE" | "BLOCKED";
  reason: string[];
  learnings: string[];
  nextTask: string[];
  raw: string;
};

type WorkspaceContext = {
  workspaceRoot: string;
  workspaceArtifactsDir: string;
};

type ExecutionWorkspaceContext = {
  executionMode: ExecutionMode;
  workspaceRoot: string;
  executionWorkspace: string;
  repoRoot: string;
  absoluteGitDir: string;
  gitCommonDir: string;
  linkedWorktree: boolean;
  bootstrapTargetPath?: string;
};

type VerificationEvidenceKind = "test" | "lint" | "build" | "typecheck" | "smoke" | "check";
type VerificationEvidenceOutcome = "passed" | "failed" | "unknown";

type VerificationEvidenceItem = {
  source: "worker_output";
  kind: VerificationEvidenceKind;
  outcomeHint: VerificationEvidenceOutcome;
  summary: string;
  command?: string;
};

type ExecutionEvidencePack = {
  repoContext: ExecutionWorkspaceContext;
  gitStatus: string[];
  diffStat: string[];
  changedFiles: string[];
  verification: VerificationEvidenceItem[];
  verificationEvidence: string[];
  warnings: string[];
};

type PlanningMetadata = {
  selectedConcept: string | null;
  brainstormingOptions: string[];
};

type ExecutionStateArtifact = {
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

const DEFAULT_MAX_BRAINSTORMING_ROUNDS = 2;
const DEFAULT_MAX_SPECS_ROUNDS = 2;
const DEFAULT_MAX_PRD_ROUNDS = 2;
const DEFAULT_MAX_EXECUTION_ROUNDS = 6;
const DEFAULT_EXECUTION_MODE: ExecutionMode = "bootstrap_project";

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeExecutionMode(value: unknown): ExecutionMode {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_EXECUTION_MODE;
  }
  if (value === "plan_only" || value === "existing_repo" || value === "bootstrap_project") {
    return value;
  }
  throw new Error(
    "self_ralph benötigt für `input.executionMode` einen der Werte `plan_only`, `existing_repo` oder `bootstrap_project`.",
  );
}

function toBulletLines(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
}

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
    executionMode: normalizeExecutionMode(record.executionMode),
    repoRoot: normalizeOptionalString(record.repoRoot)
      ? path.resolve(normalizeOptionalString(record.repoRoot)!)
      : undefined,
    projectSlug: normalizeOptionalString(record.projectSlug),
    bootstrapTemplate: normalizeOptionalString(record.bootstrapTemplate),
  };
}

function parseSection(raw: string, section: string): string[] {
  const normalized = raw.replace(/\r/g, "");
  const pattern = new RegExp(
    `(?:^|\\n)${section}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]+:\\s*(?:\\n|$)|$)`,
  );
  const match = normalized.match(pattern);
  if (!match) {
    return [];
  }
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s*/, "").trim())
    .filter((line) => line && line.toLowerCase() !== "none");
}

function parsePhaseReviewVerdict(raw: string): PhaseReviewVerdict {
  const match = raw.match(/VERDICT:\s*(APPROVE|REVISE|BLOCK)/);
  if (!match) {
    throw new Error(
      `self_ralph phase review unparsbar. Erwartet wurde 'VERDICT: APPROVE|REVISE|BLOCK'.\n\n${raw}`,
    );
  }
  return {
    verdict: match[1] as PhaseReviewVerdict["verdict"],
    reason: parseSection(raw, "REASON"),
    gaps: parseSection(raw, "GAPS"),
    revisionRequest: parseSection(raw, "REVISION_REQUEST"),
    raw,
  };
}

function parseExecutionDecision(raw: string): ExecutionReviewDecision {
  const match = raw.match(/DECISION:\s*(DONE|CONTINUE|BLOCKED)/);
  if (!match) {
    throw new Error(
      `self_ralph execution review unparsbar. Erwartet wurde 'DECISION: DONE|CONTINUE|BLOCKED'.\n\n${raw}`,
    );
  }
  return {
    decision: match[1] as ExecutionReviewDecision["decision"],
    reason: parseSection(raw, "REASON"),
    learnings: parseSection(raw, "LEARNINGS"),
    nextTask: parseSection(raw, "NEXT_TASK"),
    raw,
  };
}

function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error(`self_ralph story backlog unparsbar. JSON fehlt.\n\n${raw}`);
}

function parseStoryBacklog(raw: string): StoryState[] {
  const payload = JSON.parse(extractJsonBlock(raw)) as { stories?: unknown };
  if (!Array.isArray(payload.stories) || payload.stories.length === 0) {
    throw new Error("self_ralph story backlog benötigt mindestens eine Story.");
  }
  return payload.stories.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const task = typeof record.task === "string" ? record.task.trim() : "";
    const idSource = typeof record.id === "string" ? record.id.trim() : `story-${index + 1}`;
    const id = idSource || `story-${index + 1}`;
    if (!title || !task) {
      throw new Error(
        `self_ralph story backlog enthält eine unvollständige Story an Index ${index}.`,
      );
    }
    return {
      id,
      title,
      task,
      acceptanceCriteria: normalizeStringArray(record.acceptanceCriteria),
      status: "open" as const,
      currentTask: task,
      learnings: [],
      attempts: 0,
      lastDecision: null,
      decisionReason: [],
      lastRound: null,
    };
  });
}

function parseBrainstormingMetadata(raw: string): PlanningMetadata {
  const normalized = raw.replace(/\r/g, "");
  const brainstormingOptions = Array.from(
    normalized.matchAll(/^###\s*Concept\s+\d+\s*:\s*(.+)$/gim),
    (match) => match[1]?.trim() ?? "",
  ).filter(Boolean);
  const selectedSection =
    normalized.match(/(?:^|\n)##\s*Selected Concept\s*\n([\s\S]*?)(?=\n##\s+|$)/i)?.[1] ?? "";
  const selectedConceptMatch =
    selectedSection.match(/(?:^|\n)-\s*Title:\s*(.+)$/im) ??
    selectedSection.match(/(?:^|\n)Title:\s*(.+)$/im);
  return {
    selectedConcept: selectedConceptMatch?.[1]?.trim() || brainstormingOptions[0] || null,
    brainstormingOptions,
  };
}

function buildPhaseInstruction(phase: PhaseName): string[] {
  if (phase === "brainstorming") {
    return [
      "Develop 3 to 5 distinct product concepts from the broad direction before narrowing.",
      "Brainstorming must stay ideation-first instead of jumping straight into implementation tasks.",
      "Return markdown with exactly these sections:",
      "# Brainstorming",
      "## Direction",
      "## Concept Options",
      "### Concept 1: <title>",
      "- Target users: ...",
      "- Core problem: ...",
      "- Core loop: ...",
      "- Differentiation: ...",
      "- MVP fit: ...",
      "Repeat for each concept.",
      "## Selected Concept",
      "- Title: ...",
      "- Why selected: ...",
      "- MVP thesis: ...",
    ];
  }
  if (phase === "specs") {
    return [
      "Turn the approved selected concept into a concrete product spec.",
      "Make the artifact implementation-ready enough for a PRD author.",
      "Cover product scope, key objects, key flows, UX assumptions, non-goals, and MVP boundary.",
      "Return markdown only.",
    ];
  }
  return [
    "Turn the approved brainstorming and specs into a PRD.",
    "Cover features, acceptance criteria, system boundaries, MVP scope, and technical guardrails only when needed.",
    "Do not embed the final JSON backlog here. The backlog is generated in the next step.",
    "Return markdown only.",
  ];
}

function buildPhasePrompt(params: {
  phase: PhaseName;
  round: number;
  maxRounds: number;
  direction: string;
  executionMode: ExecutionMode;
  workspaceRoot: string;
  successCriteria: string[];
  constraints: string[];
  brainstorming: string;
  specs: string;
  priorArtifact?: string;
  revisionRequest: string[];
}) {
  return [
    `You are writing the ${params.phase} artifact for an ideation-first self-Ralph workflow.`,
    `Round: ${params.round}/${params.maxRounds}.`,
    `Execution mode after planning: ${params.executionMode}.`,
    `Workspace root for persisted planning artifacts: ${params.workspaceRoot}`,
    "",
    "DIRECTION:",
    params.direction,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.constraints),
    "",
    "APPROVED_BRAINSTORMING:",
    params.brainstorming.trim() || "none",
    "",
    "APPROVED_SPECS:",
    params.specs.trim() || "none",
    "",
    "PREVIOUS_ARTIFACT:",
    params.priorArtifact?.trim() || "none",
    "",
    "REVISION_REQUEST:",
    toBulletLines(params.revisionRequest),
    "",
    "CURRENT_PHASE_GOAL:",
    ...buildPhaseInstruction(params.phase),
  ].join("\n");
}

function buildPhaseReviewPrompt(params: {
  phase: PhaseName;
  round: number;
  maxRounds: number;
  direction: string;
  successCriteria: string[];
  constraints: string[];
  draft: string;
}) {
  const approvalGate =
    params.phase === "brainstorming"
      ? "Approve only when the draft develops multiple serious concepts and names one selected concept worth carrying into specs."
      : params.phase === "specs"
        ? "Approve only when the spec is concrete enough to hand off into a PRD without relying on unstated assumptions."
        : "Approve only when the PRD is concrete enough to generate a small verifiable story backlog.";
  return [
    `You are reviewing the ${params.phase} artifact for an ideation-first self-Ralph workflow.`,
    `Round: ${params.round}/${params.maxRounds}.`,
    "",
    "DIRECTION:",
    params.direction,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.constraints),
    "",
    "DRAFT:",
    params.draft,
    "",
    "Respond exactly in this format:",
    "VERDICT: APPROVE | REVISE | BLOCK",
    "REASON:",
    "- ...",
    "GAPS:",
    "- ...",
    "REVISION_REQUEST:",
    "- ...",
    "",
    approvalGate,
  ].join("\n");
}

function buildStoryPlannerPrompt(params: {
  direction: string;
  selectedConcept: string | null;
  prd: string;
  maxStories?: number;
}) {
  return [
    "Extract a small verifiable story backlog from the approved PRD.",
    params.maxStories
      ? `Return JSON only with at most ${params.maxStories} stories.`
      : "Return JSON only.",
    "",
    "DIRECTION:",
    params.direction,
    "",
    "SELECTED_CONCEPT:",
    params.selectedConcept ?? "none",
    "",
    "PRD:",
    params.prd,
    "",
    "Return exactly:",
    "{",
    '  "stories": [',
    '    { "id": "story-1", "title": "...", "task": "...", "acceptanceCriteria": ["..."] }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- One concrete story per backlog item.",
    "- Stories must be small and verifiable.",
    "- Preserve the intended implementation order.",
  ].join("\n");
}

function buildExecutionWorkerPrompt(params: {
  story: StoryState;
  round: number;
  maxRounds: number;
  executionContext: ExecutionWorkspaceContext;
  brainstorming: string;
  specs: string;
  prd: string;
  globalLearnings: string[];
  constraints: string[];
  bootstrapTemplate?: string;
}) {
  return [
    "You are the fresh worker for one Ralph iteration.",
    `Iteration: ${params.round}/${params.maxRounds}.`,
    `Execution mode: ${params.executionContext.executionMode}`,
    `Workspace root: ${params.executionContext.workspaceRoot}`,
    `Execution workspace: ${params.executionContext.executionWorkspace}`,
    `Repo root: ${params.executionContext.repoRoot}`,
    ...(params.executionContext.bootstrapTargetPath
      ? [`Bootstrap target path: ${params.executionContext.bootstrapTargetPath}`]
      : []),
    ...(params.bootstrapTemplate ? [`Bootstrap template hint: ${params.bootstrapTemplate}`] : []),
    "",
    "CURRENT_STORY:",
    `- id: ${params.story.id}`,
    `- title: ${params.story.title}`,
    `- task: ${params.story.currentTask}`,
    "",
    "STORY_ACCEPTANCE_CRITERIA:",
    toBulletLines(params.story.acceptanceCriteria),
    "",
    "GLOBAL_CONSTRAINTS:",
    toBulletLines(params.constraints),
    "",
    "GLOBAL_LEARNINGS:",
    toBulletLines(params.globalLearnings),
    "",
    "APPROVED_BRAINSTORMING:",
    params.brainstorming,
    "",
    "APPROVED_SPECS:",
    params.specs,
    "",
    "APPROVED_PRD:",
    params.prd,
    "",
    "Rules:",
    "- Work only on this single story.",
    "- Make concrete repo progress in the execution workspace.",
    "- Verify what you changed when feasible.",
    "- End with a concise evidence-rich summary of files changed, checks run, and open issues.",
  ].join("\n");
}

function buildExecutionReviewPrompt(params: {
  story: StoryState;
  round: number;
  maxRounds: number;
  workerOutput: string;
  evidence: ExecutionEvidencePack;
}) {
  return [
    "You are the Ralph iteration reviewer.",
    `Iteration: ${params.round}/${params.maxRounds}.`,
    "",
    "CURRENT_STORY:",
    `- id: ${params.story.id}`,
    `- title: ${params.story.title}`,
    `- task: ${params.story.currentTask}`,
    "",
    "STORY_ACCEPTANCE_CRITERIA:",
    toBulletLines(params.story.acceptanceCriteria),
    "",
    "WORKER_OUTPUT:",
    params.workerOutput,
    "",
    "REPO_EVIDENCE:",
    "REPO_CONTEXT:",
    toBulletLines([
      `execution_mode=${params.evidence.repoContext.executionMode}`,
      `workspace_root=${params.evidence.repoContext.workspaceRoot}`,
      `execution_workspace=${params.evidence.repoContext.executionWorkspace}`,
      `repo_root=${params.evidence.repoContext.repoRoot}`,
      `absolute_git_dir=${params.evidence.repoContext.absoluteGitDir}`,
      `git_common_dir=${params.evidence.repoContext.gitCommonDir}`,
      `linked_worktree=${params.evidence.repoContext.linkedWorktree ? "yes" : "no"}`,
      ...(params.evidence.repoContext.bootstrapTargetPath
        ? [`bootstrap_target_path=${params.evidence.repoContext.bootstrapTargetPath}`]
        : []),
    ]),
    "",
    "GIT_STATUS:",
    toBulletLines(params.evidence.gitStatus),
    "",
    "DIFF_STAT:",
    toBulletLines(params.evidence.diffStat),
    "",
    "CHANGED_FILES:",
    toBulletLines(params.evidence.changedFiles),
    "",
    "VERIFICATION_EVIDENCE:",
    toBulletLines(params.evidence.verificationEvidence),
    "",
    "EVIDENCE_WARNINGS:",
    toBulletLines(params.evidence.warnings),
    "",
    "Respond exactly in this format:",
    "DECISION: DONE | CONTINUE | BLOCKED",
    "REASON:",
    "- ...",
    "LEARNINGS:",
    "- ...",
    "NEXT_TASK:",
    "- ...",
    "",
    "Use CONTINUE only when there is a specific next task for the same story.",
    "Use DONE only when the current story is complete enough to move to the next story.",
    "Use BLOCKED only for a real blocker.",
    "Treat REPO_EVIDENCE as lightweight structured evidence that informs your judgment, not as a rigid pass/fail rule.",
  ].join("\n");
}

function formatGitProbeError(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr =
      "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : Buffer.isBuffer((error as { stderr?: unknown }).stderr)
          ? (error as { stderr: Buffer }).stderr.toString("utf8").trim()
          : "";
    if (stderr) {
      return stderr;
    }
    const stdout =
      "stdout" in error && typeof error.stdout === "string"
        ? error.stdout.trim()
        : Buffer.isBuffer((error as { stdout?: unknown }).stdout)
          ? (error as { stdout: Buffer }).stdout.toString("utf8").trim()
          : "";
    if (stdout) {
      return stdout;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function runGitProbe(
  cwd: string,
  args: string[],
): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatGitProbeError(error),
    };
  }
}

function runGitReadOnly(cwd: string, args: string[]): string | null {
  const result = runGitProbe(cwd, args);
  return result.ok ? result.output : null;
}

function validateWorkspaceDirectory(workingDirectory: string): WorkspaceContext {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(workingDirectory);
  } catch {
    throw new Error(
      [
        "self_ralph benötigt für `input.workingDirectory` ein existierendes Verzeichnis.",
        `Aufgelöst: ${workingDirectory}`,
      ].join("\n"),
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      [
        "self_ralph benötigt für `input.workingDirectory` ein Verzeichnis statt einer Datei.",
        `Aufgelöst: ${workingDirectory}`,
      ].join("\n"),
    );
  }
  try {
    fs.accessSync(workingDirectory, fs.constants.W_OK);
  } catch {
    throw new Error(
      [
        "self_ralph benötigt für `input.workingDirectory` ein beschreibbares Workspace-Verzeichnis.",
        `Aufgelöst: ${workingDirectory}`,
      ].join("\n"),
    );
  }
  const workspaceArtifactsDir = path.join(workingDirectory, "self-ralph");
  fs.mkdirSync(workspaceArtifactsDir, { recursive: true });
  return {
    workspaceRoot: workingDirectory,
    workspaceArtifactsDir,
  };
}

function buildExecutionTargetValidationError(params: {
  fieldName: "repoRoot" | "bootstrapTargetPath";
  executionWorkspace: string;
  detail: string;
}): Error {
  return new Error(
    [
      `self_ralph konnte \`${params.fieldName}\` nicht als nutzbaren git Repo/Worktree-Kontext validieren.`,
      `Aufgelöst: ${params.executionWorkspace}`,
      `Detail: ${params.detail}`,
      "Erwartet wird ein bestehendes Verzeichnis innerhalb eines git Repos oder Worktrees.",
    ].join("\n"),
  );
}

function validateExecutionWorkspace(params: {
  workspaceRoot: string;
  executionWorkspace: string;
  executionMode: ExecutionMode;
  fieldName: "repoRoot" | "bootstrapTargetPath";
  bootstrapTargetPath?: string;
}): ExecutionWorkspaceContext {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(params.executionWorkspace);
  } catch {
    throw new Error(
      [
        `self_ralph benötigt für \`${params.fieldName}\` ein existierendes Verzeichnis vor Execution-Beginn.`,
        `Aufgelöst: ${params.executionWorkspace}`,
      ].join("\n"),
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      [
        `self_ralph benötigt für \`${params.fieldName}\` ein Verzeichnis statt einer Datei.`,
        `Aufgelöst: ${params.executionWorkspace}`,
      ].join("\n"),
    );
  }

  const repoRoot = runGitProbe(params.executionWorkspace, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot.ok || !repoRoot.output) {
    throw buildExecutionTargetValidationError({
      fieldName: params.fieldName,
      executionWorkspace: params.executionWorkspace,
      detail: `git rev-parse --show-toplevel fehlgeschlagen: ${repoRoot.ok ? "leere Ausgabe" : repoRoot.error}`,
    });
  }
  const workTree = runGitProbe(params.executionWorkspace, ["rev-parse", "--is-inside-work-tree"]);
  if (!workTree.ok || workTree.output !== "true") {
    throw buildExecutionTargetValidationError({
      fieldName: params.fieldName,
      executionWorkspace: params.executionWorkspace,
      detail: workTree.ok
        ? `git rev-parse --is-inside-work-tree meldete '${workTree.output}'.`
        : `git rev-parse --is-inside-work-tree fehlgeschlagen: ${workTree.error}`,
    });
  }
  const absoluteGitDir = runGitProbe(params.executionWorkspace, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  if (!absoluteGitDir.ok || !absoluteGitDir.output) {
    throw buildExecutionTargetValidationError({
      fieldName: params.fieldName,
      executionWorkspace: params.executionWorkspace,
      detail: `git rev-parse --absolute-git-dir fehlgeschlagen: ${absoluteGitDir.ok ? "leere Ausgabe" : absoluteGitDir.error}`,
    });
  }

  const gitCommonDirAbsolute = runGitProbe(params.executionWorkspace, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const gitCommonDirFallback = gitCommonDirAbsolute.ok
    ? null
    : runGitProbe(params.executionWorkspace, ["rev-parse", "--git-common-dir"]);
  const gitCommonDirRaw = gitCommonDirAbsolute.ok
    ? gitCommonDirAbsolute.output
    : gitCommonDirFallback?.ok
      ? path.resolve(params.executionWorkspace, gitCommonDirFallback.output)
      : null;
  if (!gitCommonDirRaw) {
    throw buildExecutionTargetValidationError({
      fieldName: params.fieldName,
      executionWorkspace: params.executionWorkspace,
      detail: gitCommonDirAbsolute.ok
        ? "git rev-parse --git-common-dir lieferte keine Ausgabe."
        : `git rev-parse --git-common-dir fehlgeschlagen: ${"error" in gitCommonDirAbsolute ? gitCommonDirAbsolute.error : "unbekannt"}; fallback: ${gitCommonDirFallback && "error" in gitCommonDirFallback ? gitCommonDirFallback.error : "nicht ausgeführt"}`,
    });
  }

  return {
    executionMode: params.executionMode,
    workspaceRoot: params.workspaceRoot,
    executionWorkspace: params.executionWorkspace,
    repoRoot: path.resolve(repoRoot.output),
    absoluteGitDir: path.resolve(absoluteGitDir.output),
    gitCommonDir: path.resolve(gitCommonDirRaw),
    linkedWorktree: path.resolve(absoluteGitDir.output) !== path.resolve(gitCommonDirRaw),
    ...(params.bootstrapTargetPath ? { bootstrapTargetPath: params.bootstrapTargetPath } : {}),
  };
}

function normalizeEvidenceLines(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseGitStatusPaths(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:[ MADRCU?!]{2}|[MADRCU?!])\s+/, "").trim())
    .filter(Boolean);
}

function parseGitNameOnly(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function detectVerificationKind(line: string): VerificationEvidenceKind {
  if (/\b(typecheck|tsc|mypy|pyright)\b/i.test(line)) {
    return "typecheck";
  }
  if (/\b(lint|eslint|ruff)\b/i.test(line)) {
    return "lint";
  }
  if (/\b(build|compile)\b/i.test(line)) {
    return "build";
  }
  if (/\b(smoke)\b/i.test(line)) {
    return "smoke";
  }
  if (/\b(test|tests|spec|vitest|jest|pytest)\b/i.test(line)) {
    return "test";
  }
  return "check";
}

function detectVerificationOutcome(line: string): VerificationEvidenceOutcome {
  if (/\b(fail(?:ed|ing)?|error|broken|missing|not run|unable)\b/i.test(line)) {
    return "failed";
  }
  if (/\b(pass(?:ed)?|ok|successful(?:ly)?|clean)\b/i.test(line)) {
    return "passed";
  }
  return "unknown";
}

function extractVerificationCommand(line: string): string | undefined {
  const fencedCommand = line.match(/`([^`]+)`/);
  if (fencedCommand?.[1]) {
    return fencedCommand[1].trim();
  }
  const ranCommand = line.match(/\b(?:ran|run|executed|execute|checked)\s+(.+)/i);
  if (!ranCommand?.[1]) {
    return undefined;
  }
  return ranCommand[1].trim().replace(/[.;,:]+$/, "") || undefined;
}

function collectVerificationEvidence(workerOutput: string): VerificationEvidenceItem[] {
  const seen = new Set<string>();
  return workerOutput
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s*/, "").trim())
    .filter((line) =>
      /(test|spec|verify|verification|validated|checked|check|lint|build|typecheck|smoke)/i.test(
        line,
      ),
    )
    .map((line) => ({
      source: "worker_output" as const,
      kind: detectVerificationKind(line),
      outcomeHint: detectVerificationOutcome(line),
      summary: line,
      command: extractVerificationCommand(line),
    }))
    .filter((item) => {
      const key = item.summary.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function formatVerificationEvidenceLine(item: VerificationEvidenceItem): string {
  const fragments = [`kind=${item.kind}`, `outcome_hint=${item.outcomeHint}`, item.summary];
  if (item.command) {
    fragments.push(`command=${item.command}`);
  }
  return fragments.join(" | ");
}

function collectExecutionEvidence(
  executionContext: ExecutionWorkspaceContext,
  workerOutput: string,
): ExecutionEvidencePack {
  const gitStatusRaw = runGitReadOnly(executionContext.executionWorkspace, ["status", "--short"]);
  const stagedDiffStat = normalizeEvidenceLines(
    runGitReadOnly(executionContext.executionWorkspace, [
      "diff",
      "--stat",
      "--cached",
      "--find-renames",
    ]),
  ).map((line) => `staged: ${line}`);
  const workingTreeDiffStat = normalizeEvidenceLines(
    runGitReadOnly(executionContext.executionWorkspace, ["diff", "--stat", "--find-renames"]),
  ).map((line) => `working_tree: ${line}`);
  const changedFiles = Array.from(
    new Set([
      ...parseGitNameOnly(
        runGitReadOnly(executionContext.executionWorkspace, [
          "diff",
          "--name-only",
          "--cached",
          "--find-renames",
        ]),
      ),
      ...parseGitNameOnly(
        runGitReadOnly(executionContext.executionWorkspace, [
          "diff",
          "--name-only",
          "--find-renames",
        ]),
      ),
      ...parseGitStatusPaths(gitStatusRaw),
    ]),
  );
  const verification = collectVerificationEvidence(workerOutput);
  const warnings: string[] = [];
  if (verification.length === 0) {
    warnings.push("No explicit verification steps were extracted from worker output.");
  }
  if (gitStatusRaw === null) {
    warnings.push("Git status evidence could not be collected after the worker turn.");
  }
  return {
    repoContext: executionContext,
    gitStatus: normalizeEvidenceLines(gitStatusRaw),
    diffStat: [...stagedDiffStat, ...workingTreeDiffStat].slice(0, 20),
    changedFiles: changedFiles.slice(0, 40),
    verification,
    verificationEvidence: verification.map(formatVerificationEvidenceLine),
    warnings,
  };
}

function buildExecutionState(params: {
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  direction: string;
  planningStatus: PlanningStatus;
  executionMode: ExecutionMode;
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

function summarizeDecisionLines(values: string[]): string {
  return values.length ? values.join(" | ") : "none";
}

function buildRunSummary(params: {
  input: SelfRalphInput;
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
    `Direction: ${params.input.direction}`,
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

function buildRecord(params: {
  runId: string;
  input: SelfRalphInput;
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
    moduleId: "self_ralph",
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

function stepIdForPhase(phase: PhaseName, round: number): string {
  return `${phase}-round-${round}`;
}

function stepIdForExecution(round: number): string {
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

function slugify(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "self-ralph-project";
}

function prepareBootstrapProject(params: {
  workspaceRoot: string;
  selectedConcept: string | null;
  direction: string;
  projectSlug?: string;
}): { projectSlug: string; bootstrapTargetPath: string } {
  const projectSlug = slugify(params.projectSlug ?? params.selectedConcept ?? params.direction);
  const bootstrapTargetPath = path.join(params.workspaceRoot, projectSlug);
  fs.mkdirSync(bootstrapTargetPath, { recursive: true });
  try {
    execFileSync("git", ["init", bootstrapTargetPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      [
        "self_ralph konnte für `executionMode=bootstrap_project` kein Git-Repo initialisieren.",
        `Aufgelöst: ${bootstrapTargetPath}`,
        `Detail: ${formatGitProbeError(error)}`,
      ].join("\n"),
      { cause: error },
    );
  }
  return {
    projectSlug,
    bootstrapTargetPath,
  };
}

async function start(
  request: WorkflowStartRequest,
  ctx: WorkflowModuleContext,
): Promise<WorkflowRunRecord> {
  ctx.throwIfAbortRequested?.();
  const input = normalizeInput(request);
  const workspaceContext = validateWorkspaceDirectory(input.workingDirectory);
  const createdAt = ctx.nowIso();
  const planningRounds = input.maxBrainstormingRounds + input.maxSpecsRounds + input.maxPRDRounds;
  const maxRounds =
    planningRounds + (input.executionMode === "plan_only" ? 0 : input.maxExecutionRounds);
  const artifacts: string[] = [];
  let latestWorkerOutput: string | null = null;
  let latestCriticVerdict: string | null = null;
  let terminalReason: string | null = null;
  let status: WorkflowRunRecord["status"] = "running";
  let planningStatus: PlanningStatus = "brainstorming";
  let currentTask: string | null = input.direction;
  let currentRound = 0;
  let selectedConcept: string | null = null;
  let brainstormingOptions: string[] = [];
  let executionContext: ExecutionWorkspaceContext | null = null;

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

  const persist = () => {
    const record = buildRecord({
      runId: ctx.runId,
      input,
      sessions,
      status,
      terminalReason,
      currentRound,
      maxRounds,
      artifacts,
      latestWorkerOutput,
      latestCriticVerdict,
      originalTask: input.direction,
      currentTask,
      origin: request.origin,
      reporting: request.reporting,
      createdAt,
      updatedAt: ctx.nowIso(),
    });
    ctx.persist(ctx.trace.attachToRunRecord(record));
    return record;
  };

  const writeArtifact = (
    name: string,
    content: string,
    summary: string,
    stepId: string,
    role: string,
  ) => {
    const artifactPath = writeWorkflowArtifact(ctx.runId, name, content);
    artifacts.push(artifactPath);
    mirrorWorkspaceArtifact(workspaceContext.workspaceArtifactsDir, name, content);
    ctx.trace.emit({
      kind: "artifact_written",
      stepId,
      round: currentRound,
      role,
      artifactPath,
      summary,
    });
    return artifactPath;
  };

  const emitTerminalReport = async (
    finalStatus: "done" | "planning_done" | "blocked" | "failed" | "max_rounds_reached",
    messageText: string,
  ) => {
    const isCompleted = finalStatus === "done" || finalStatus === "planning_done";
    await emitTracedWorkflowReportEvent({
      trace: ctx.trace,
      stepId: "run",
      moduleId: "self_ralph",
      runId: ctx.runId,
      phase: isCompleted
        ? finalStatus === "planning_done"
          ? "workflow_planning_done"
          : "workflow_done"
        : "workflow_blocked",
      eventType: isCompleted ? "completed" : "blocked",
      messageText,
      emittingAgentId: input.reviewerAgentId,
      origin: request.origin,
      reporting: request.reporting,
      status: finalStatus,
      role: "orchestrator",
      targetSessionKey: sessions.orchestrator,
      traceSummary: isCompleted ? "workflow completed" : "workflow terminal blocked-style report",
    });
  };

  const writeExecutionStateArtifact = (params: {
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
  }) => {
    const snapshot = buildExecutionState({
      status,
      terminalReason,
      direction: input.direction,
      planningStatus,
      executionMode: input.executionMode,
      workspaceRoot: input.workingDirectory,
      executionContext,
      selectedConcept,
      brainstormingOptions,
      activeStoryId: params.activeStoryId,
      nextTask: params.nextTask,
      lastDecision: params.lastDecision,
      decisionReason: params.decisionReason,
      lastRound: params.lastRound,
      globalLearnings: params.globalLearnings,
      stories: params.stories,
      updatedAt: ctx.nowIso(),
      completedAt: params.completedAt,
      blockedAt: params.blockedAt,
    });
    writeArtifact(
      "execution-state.json",
      JSON.stringify(snapshot, null, 2),
      "execution state snapshot",
      params.stepId,
      "orchestrator",
    );
  };

  ctx.trace.emit({
    kind: "run_started",
    stepId: "run",
    summary: `self_ralph started for ${input.direction}`,
    status: "running",
  });
  persist();

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
    prd: "",
  };

  for (const phase of [
    ["brainstorming", input.maxBrainstormingRounds],
    ["specs", input.maxSpecsRounds],
    ["prd", input.maxPRDRounds],
  ] as const) {
    const phaseName = phase[0];
    const phaseMaxRounds = phase[1];
    let revisionRequest: string[] = [];
    let approved = false;
    let latestPhaseArtifact = phaseArtifacts[phaseName];
    planningStatus = phaseName;

    for (let phaseRound = 1; phaseRound <= phaseMaxRounds; phaseRound += 1) {
      ctx.throwIfAbortRequested?.();
      currentRound += 1;
      currentTask = `${phaseName} round ${phaseRound}`;
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
        phase: phaseName,
        round: phaseRound,
        maxRounds: phaseMaxRounds,
        direction: input.direction,
        executionMode: input.executionMode,
        workspaceRoot: input.workingDirectory,
        successCriteria: input.successCriteria,
        constraints: input.constraints,
        brainstorming: phaseArtifacts.brainstorming,
        specs: phaseArtifacts.specs,
        priorArtifact: latestPhaseArtifact,
        revisionRequest,
      });
      writeArtifact(
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
      latestWorkerOutput = draft.text;
      latestPhaseArtifact = draft.text;
      writeArtifact(
        `${phaseName}-round-${phaseRound}-draft.md`,
        draft.text,
        `${phaseName} draft`,
        stepId,
        "worker",
      );

      const reviewPrompt = buildPhaseReviewPrompt({
        phase: phaseName,
        round: phaseRound,
        maxRounds: phaseMaxRounds,
        direction: input.direction,
        successCriteria: input.successCriteria,
        constraints: input.constraints,
        draft: draft.text,
      });
      writeArtifact(
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
      const review = parsePhaseReviewVerdict(reviewRun.text);
      latestCriticVerdict = review.raw;
      writeArtifact(
        `${phaseName}-round-${phaseRound}-review.txt`,
        review.raw,
        `${phaseName} review verdict ${review.verdict}`,
        stepId,
        "critic",
      );
      persist();

      if (review.verdict === "BLOCK") {
        status = "blocked";
        terminalReason = `${phaseName} blocked: ${summarizeDecisionLines(review.reason)}`;
        ctx.trace.emit({
          kind: "run_blocked",
          stepId,
          round: currentRound,
          role: "critic",
          status,
          summary: terminalReason,
        });
        const summary = buildRunSummary({
          input,
          status,
          terminalReason,
          totalRounds: currentRound,
          selectedConcept,
          stories: [],
          sessions,
          executionContext,
        });
        writeArtifact("run-summary.txt", summary, "terminal run summary", "run", "orchestrator");
        await emitTerminalReport(status, summary);
        return persist();
      }

      if (review.verdict === "APPROVE") {
        approved = true;
        phaseArtifacts[phaseName] = draft.text;
        writeArtifact(
          `${phaseName}-final.md`,
          draft.text,
          `${phaseName} approved artifact`,
          stepId,
          "worker",
        );
        if (phaseName === "brainstorming") {
          const metadata = parseBrainstormingMetadata(draft.text);
          selectedConcept = metadata.selectedConcept;
          brainstormingOptions = metadata.brainstormingOptions;
          writeArtifact(
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
      status = "max_rounds_reached";
      terminalReason = `${phaseName} exhausted its review rounds without approval.`;
      ctx.trace.emit({
        kind: "run_status_changed",
        stepId: `phase-${phaseName}`,
        round: currentRound,
        status,
        summary: terminalReason,
      });
      const summary = buildRunSummary({
        input,
        status,
        terminalReason,
        totalRounds: currentRound,
        selectedConcept,
        stories: [],
        sessions,
        executionContext,
      });
      writeArtifact("run-summary.txt", summary, "terminal run summary", "run", "orchestrator");
      await emitTerminalReport(status, summary);
      return persist();
    }
  }

  planningStatus = "ready_for_execution";
  currentTask = "story backlog planning";
  const backlogSessions = await ensureWorkflowSessions({
    runId: ctx.runId,
    specs: [
      {
        role: "worker",
        agentId: input.plannerAgentId,
        label: `Workflow ${ctx.runId} story planner`,
        name: "story-planner",
        model: input.plannerModel,
        policy: "reset-on-reuse",
      },
    ],
  });
  sessions.worker = backlogSessions.worker;
  const backlogPrompt = buildStoryPlannerPrompt({
    direction: input.direction,
    selectedConcept,
    prd: phaseArtifacts.prd,
    maxStories: input.maxStories,
  });
  writeArtifact(
    "story-backlog-prompt.md",
    backlogPrompt,
    "story backlog planner prompt",
    "story-planner",
    "worker",
  );
  const backlogRun = await runWorkflowAgentOnSession({
    sessionKey: backlogSessions.worker!,
    message: backlogPrompt,
    idempotencyKey: `${ctx.runId}-story-backlog`,
    abortSignal: ctx.abortSignal,
  });
  ctx.throwIfAbortRequested?.();
  const stories = parseStoryBacklog(backlogRun.text);
  writeArtifact(
    "story-backlog.json",
    JSON.stringify({ stories }, null, 2),
    "parsed story backlog",
    "story-planner",
    "worker",
  );
  const globalLearnings: string[] = [];
  let lastExecutionDecision: ExecutionReviewDecision["decision"] | null = null;
  let lastExecutionReason: string[] = [];
  let lastExecutionRound: number | null = null;
  let executionCompletedAt: string | null = null;
  let executionBlockedAt: string | null = null;

  const firstStory = stories[0] ?? null;
  writeExecutionStateArtifact({
    stepId: "story-planner",
    activeStoryId: firstStory?.id ?? null,
    nextTask: firstStory?.currentTask ?? null,
    stories,
    lastDecision: lastExecutionDecision,
    decisionReason: lastExecutionReason,
    lastRound: lastExecutionRound,
    globalLearnings,
  });
  persist();

  if (input.executionMode === "plan_only") {
    planningStatus = "planning_done";
    status = "planning_done";
    terminalReason = "Planning completed without execution.";
    currentTask = null;
    writeExecutionStateArtifact({
      stepId: "run",
      activeStoryId: firstStory?.id ?? null,
      nextTask: firstStory?.currentTask ?? null,
      stories,
      lastDecision: lastExecutionDecision,
      decisionReason: lastExecutionReason,
      lastRound: lastExecutionRound,
      globalLearnings,
      completedAt: ctx.nowIso(),
    });
    const summary = buildRunSummary({
      input,
      status,
      terminalReason,
      totalRounds: currentRound,
      selectedConcept,
      stories,
      sessions,
      executionContext,
    });
    writeArtifact("run-summary.txt", summary, "terminal run summary", "run", "orchestrator");
    ctx.trace.emit({
      kind: "run_completed",
      stepId: "run",
      round: currentRound,
      role: "orchestrator",
      status,
      summary: terminalReason,
    });
    await emitTerminalReport(status, summary);
    return persist();
  }

  if (input.executionMode === "existing_repo") {
    if (!input.repoRoot) {
      throw new Error(
        "self_ralph benötigt `input.repoRoot` bei `executionMode=existing_repo` vor Execution-Beginn.",
      );
    }
    executionContext = validateExecutionWorkspace({
      workspaceRoot: input.workingDirectory,
      executionWorkspace: input.repoRoot,
      executionMode: input.executionMode,
      fieldName: "repoRoot",
    });
  } else {
    const bootstrap = prepareBootstrapProject({
      workspaceRoot: input.workingDirectory,
      selectedConcept,
      direction: input.direction,
      projectSlug: input.projectSlug,
    });
    writeArtifact(
      "project-bootstrap.json",
      JSON.stringify(
        {
          executionMode: input.executionMode,
          workspaceRoot: input.workingDirectory,
          projectSlug: bootstrap.projectSlug,
          bootstrapTargetPath: bootstrap.bootstrapTargetPath,
          bootstrapTemplate: input.bootstrapTemplate ?? null,
          derivedFrom: selectedConcept ?? input.direction,
        },
        null,
        2,
      ),
      "bootstrap project preparation",
      "execution-readiness",
      "orchestrator",
    );
    executionContext = validateExecutionWorkspace({
      workspaceRoot: input.workingDirectory,
      executionWorkspace: bootstrap.bootstrapTargetPath,
      executionMode: input.executionMode,
      fieldName: "bootstrapTargetPath",
      bootstrapTargetPath: bootstrap.bootstrapTargetPath,
    });
  }

  planningStatus = "execution";
  writeExecutionStateArtifact({
    stepId: "execution-readiness",
    activeStoryId: firstStory?.id ?? null,
    nextTask: firstStory?.currentTask ?? null,
    stories,
    lastDecision: lastExecutionDecision,
    decisionReason: lastExecutionReason,
    lastRound: lastExecutionRound,
    globalLearnings,
  });
  persist();

  for (let executionRound = 1; executionRound <= input.maxExecutionRounds; executionRound += 1) {
    const story = stories.find((entry) => entry.status !== "done");
    if (!story) {
      status = "done";
      terminalReason = "All stories completed.";
      executionCompletedAt = executionCompletedAt ?? ctx.nowIso();
      break;
    }

    ctx.throwIfAbortRequested?.();
    currentRound += 1;
    story.status = "in_progress";
    story.attempts += 1;
    currentTask = `${story.id}: ${story.currentTask}`;
    const stepId = stepIdForExecution(executionRound);
    const iterationSessions = await ensureWorkflowSessions({
      runId: ctx.runId,
      specs: [
        {
          role: "worker",
          agentId: input.workerAgentId,
          label: `Workflow ${ctx.runId} ${story.id} worker ${story.attempts}`,
          name: `execution-worker-${story.id}-attempt-${story.attempts}`,
          model: input.workerModel,
          policy: "reset-on-reuse",
        },
        {
          role: "critic",
          agentId: input.reviewerAgentId,
          label: `Workflow ${ctx.runId} ${story.id} review ${story.attempts}`,
          name: `execution-review-${story.id}-attempt-${story.attempts}`,
          model: input.reviewerModel,
          policy: "reset-on-reuse",
        },
      ],
    });
    sessions.worker = iterationSessions.worker;
    sessions.critic = iterationSessions.critic;

    const workerPrompt = buildExecutionWorkerPrompt({
      story,
      round: executionRound,
      maxRounds: input.maxExecutionRounds,
      executionContext,
      brainstorming: phaseArtifacts.brainstorming,
      specs: phaseArtifacts.specs,
      prd: phaseArtifacts.prd,
      globalLearnings,
      constraints: input.constraints,
      bootstrapTemplate: input.bootstrapTemplate,
    });
    writeArtifact(
      `execution-round-${executionRound}-worker-prompt.md`,
      workerPrompt,
      `execution round ${executionRound} worker prompt`,
      stepId,
      "worker",
    );
    const workerRun = await runWorkflowAgentOnSession({
      sessionKey: iterationSessions.worker!,
      message: workerPrompt,
      idempotencyKey: `${ctx.runId}-execution-worker-${executionRound}`,
      workspaceDir: executionContext.executionWorkspace,
      abortSignal: ctx.abortSignal,
    });
    ctx.throwIfAbortRequested?.();
    latestWorkerOutput = workerRun.text;
    writeArtifact(
      `execution-round-${executionRound}-worker.txt`,
      workerRun.text,
      `execution round ${executionRound} worker output`,
      stepId,
      "worker",
    );

    const evidence = collectExecutionEvidence(executionContext, workerRun.text);
    writeArtifact(
      `execution-round-${executionRound}-evidence.json`,
      JSON.stringify(evidence, null, 2),
      `execution round ${executionRound} evidence pack`,
      stepId,
      "orchestrator",
    );
    const reviewPrompt = buildExecutionReviewPrompt({
      story,
      round: executionRound,
      maxRounds: input.maxExecutionRounds,
      workerOutput: workerRun.text,
      evidence,
    });
    writeArtifact(
      `execution-round-${executionRound}-review-prompt.md`,
      reviewPrompt,
      `execution round ${executionRound} review prompt`,
      stepId,
      "critic",
    );
    const reviewRun = await runWorkflowAgentOnSession({
      sessionKey: iterationSessions.critic!,
      message: reviewPrompt,
      idempotencyKey: `${ctx.runId}-execution-review-${executionRound}`,
      workspaceDir: executionContext.executionWorkspace,
      abortSignal: ctx.abortSignal,
    });
    const decision = parseExecutionDecision(reviewRun.text);
    latestCriticVerdict = decision.raw;
    writeArtifact(
      `execution-round-${executionRound}-review.txt`,
      decision.raw,
      `execution round ${executionRound} review decision ${decision.decision}`,
      stepId,
      "critic",
    );

    for (const learning of decision.learnings) {
      if (!globalLearnings.includes(learning)) {
        globalLearnings.push(learning);
      }
      if (!story.learnings.includes(learning)) {
        story.learnings.push(learning);
      }
    }
    lastExecutionDecision = decision.decision;
    lastExecutionReason = [...decision.reason];
    lastExecutionRound = executionRound;
    story.lastDecision = decision.decision;
    story.decisionReason = [...decision.reason];
    story.lastRound = executionRound;

    if (decision.decision === "BLOCKED") {
      story.status = "blocked";
      story.blockedAt = ctx.nowIso();
      status = "blocked";
      executionBlockedAt = story.blockedAt;
      terminalReason = `${story.id} blocked: ${summarizeDecisionLines(decision.reason)}`;
      writeExecutionStateArtifact({
        stepId,
        activeStoryId: story.id,
        nextTask: decision.nextTask[0] ?? null,
        stories,
        lastDecision: lastExecutionDecision,
        decisionReason: lastExecutionReason,
        lastRound: lastExecutionRound,
        globalLearnings,
        blockedAt: executionBlockedAt,
      });
      persist();
      break;
    }

    if (decision.decision === "DONE") {
      story.status = "done";
      story.completedAt = ctx.nowIso();
      const nextStory = stories.find((entry) => entry.status !== "done");
      if (!nextStory) {
        status = "done";
        terminalReason = "All stories completed.";
        currentTask = null;
        executionCompletedAt = ctx.nowIso();
      } else {
        currentTask = nextStory.currentTask;
      }
      writeExecutionStateArtifact({
        stepId,
        activeStoryId: nextStory?.id ?? null,
        nextTask: nextStory?.currentTask ?? null,
        stories,
        lastDecision: lastExecutionDecision,
        decisionReason: lastExecutionReason,
        lastRound: lastExecutionRound,
        globalLearnings,
        completedAt: executionCompletedAt,
      });
      persist();
      await emitTracedWorkflowReportEvent({
        trace: ctx.trace,
        stepId,
        moduleId: "self_ralph",
        runId: ctx.runId,
        phase: "execution_story_done",
        eventType: "milestone",
        messageText: [
          `Completed story ${story.id}.`,
          `Title: ${story.title}`,
          `Decision reason: ${summarizeDecisionLines(decision.reason)}`,
        ].join("\n"),
        emittingAgentId: input.reviewerAgentId,
        origin: request.origin,
        reporting: request.reporting,
        status: "running",
        role: "critic",
        targetSessionKey: sessions.orchestrator,
        traceSummary: `${story.id} completed`,
      });
      if (status === "done") {
        break;
      }
      continue;
    }

    const nextTask = decision.nextTask[0] ?? story.currentTask;
    story.currentTask = nextTask;
    currentTask = `${story.id}: ${story.currentTask}`;
    story.status = "in_progress";
    writeExecutionStateArtifact({
      stepId,
      activeStoryId: story.id,
      nextTask: story.currentTask,
      stories,
      lastDecision: lastExecutionDecision,
      decisionReason: lastExecutionReason,
      lastRound: lastExecutionRound,
      globalLearnings,
    });
    persist();
  }

  if (status === "running") {
    const remainingStory = stories.find((story) => story.status !== "done");
    if (remainingStory) {
      status = "max_rounds_reached";
      terminalReason = `Execution budget exhausted with remaining story ${remainingStory.id}.`;
      writeExecutionStateArtifact({
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
      status = "done";
      terminalReason = terminalReason ?? "All stories completed.";
      executionCompletedAt = executionCompletedAt ?? ctx.nowIso();
      writeExecutionStateArtifact({
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

  const summary = buildRunSummary({
    input,
    status,
    terminalReason,
    totalRounds: currentRound,
    selectedConcept,
    stories,
    sessions,
    executionContext,
  });
  writeArtifact("run-summary.txt", summary, "terminal run summary", "run", "orchestrator");

  if (status === "done") {
    ctx.trace.emit({
      kind: "run_completed",
      stepId: "run",
      round: currentRound,
      role: "orchestrator",
      status,
      summary: terminalReason ?? "workflow completed",
    });
    await emitTerminalReport(status, summary);
  } else {
    ctx.trace.emit({
      kind: "run_blocked",
      stepId: "run",
      round: currentRound,
      role: "orchestrator",
      status,
      summary: terminalReason ?? "workflow stopped",
    });
    await emitTerminalReport(status, summary);
  }

  return persist();
}

export const selfRalphWorkflowModule: WorkflowModule = {
  manifest: selfRalphWorkflowModuleManifest,
  start,
};
