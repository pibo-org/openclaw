import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runWorkflowAgentOnSession } from "../../agent-runtime.js";
import type {
  WorkflowModuleContext,
  WorkflowRunSessions,
  WorkflowStartRequest,
} from "../../types.js";
import { emitTracedWorkflowReportEvent } from "../../workflow-reporting.js";
import { ensureWorkflowSessions } from "../../workflow-session-helper.js";
import { stepIdForExecution } from "./artifacts.js";
import type { RalphRuntimeHarness } from "./artifacts.js";
import { resolveWorkspaceArtifactsDir } from "./artifacts.js";
import { parseExecutionDecision, slugify, toBulletLines } from "./common.js";
import type {
  ExecutionEvidencePack,
  ExecutionMode,
  ExecutionReviewDecision,
  ExecutionWorkspaceContext,
  RalphWorkflowInput,
  RalphWorkflowModuleId,
  RalphWorkflowState,
  StoryState,
  VerificationEvidenceItem,
  VerificationEvidenceKind,
  VerificationEvidenceOutcome,
  WorkspaceContext,
} from "./types.js";

export function buildExecutionWorkerPrompt(params: {
  story: StoryState;
  round: number;
  maxRounds: number;
  executionContext: ExecutionWorkspaceContext;
  approvedBrainstorming?: string;
  approvedSpecs: string;
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
    params.approvedBrainstorming?.trim() || "none",
    "",
    "APPROVED_SPECS:",
    params.approvedSpecs,
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

export function formatGitProbeError(error: unknown): string {
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

export function validateWorkspaceDirectory(
  moduleId: RalphWorkflowModuleId,
  workingDirectory: string,
): WorkspaceContext {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(workingDirectory);
  } catch {
    throw new Error(
      [
        `${moduleId} benötigt für \`input.workingDirectory\` ein existierendes Verzeichnis.`,
        `Aufgelöst: ${workingDirectory}`,
      ].join("\n"),
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      [
        `${moduleId} benötigt für \`input.workingDirectory\` ein Verzeichnis statt einer Datei.`,
        `Aufgelöst: ${workingDirectory}`,
      ].join("\n"),
    );
  }
  try {
    fs.accessSync(workingDirectory, fs.constants.W_OK);
  } catch {
    throw new Error(
      [
        `${moduleId} benötigt für \`input.workingDirectory\` ein beschreibbares Workspace-Verzeichnis.`,
        `Aufgelöst: ${workingDirectory}`,
      ].join("\n"),
    );
  }
  const workspaceArtifactsDir = resolveWorkspaceArtifactsDir(moduleId, workingDirectory);
  fs.mkdirSync(workspaceArtifactsDir, { recursive: true });
  return {
    workspaceRoot: workingDirectory,
    workspaceArtifactsDir,
  };
}

function buildExecutionTargetValidationError(params: {
  moduleId: RalphWorkflowModuleId;
  fieldName: "repoRoot" | "bootstrapTargetPath";
  executionWorkspace: string;
  detail: string;
}): Error {
  return new Error(
    [
      `${params.moduleId} konnte \`${params.fieldName}\` nicht als nutzbaren git Repo/Worktree-Kontext validieren.`,
      `Aufgelöst: ${params.executionWorkspace}`,
      `Detail: ${params.detail}`,
      "Erwartet wird ein bestehendes Verzeichnis innerhalb eines git Repos oder Worktrees.",
    ].join("\n"),
  );
}

export function validateExecutionWorkspace(params: {
  moduleId: RalphWorkflowModuleId;
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
        `${params.moduleId} benötigt für \`${params.fieldName}\` ein existierendes Verzeichnis vor Execution-Beginn.`,
        `Aufgelöst: ${params.executionWorkspace}`,
      ].join("\n"),
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      [
        `${params.moduleId} benötigt für \`${params.fieldName}\` ein Verzeichnis statt einer Datei.`,
        `Aufgelöst: ${params.executionWorkspace}`,
      ].join("\n"),
    );
  }

  const repoRoot = runGitProbe(params.executionWorkspace, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot.ok || !repoRoot.output) {
    throw buildExecutionTargetValidationError({
      moduleId: params.moduleId,
      fieldName: params.fieldName,
      executionWorkspace: params.executionWorkspace,
      detail: `git rev-parse --show-toplevel fehlgeschlagen: ${repoRoot.ok ? "leere Ausgabe" : repoRoot.error}`,
    });
  }
  const workTree = runGitProbe(params.executionWorkspace, ["rev-parse", "--is-inside-work-tree"]);
  if (!workTree.ok || workTree.output !== "true") {
    throw buildExecutionTargetValidationError({
      moduleId: params.moduleId,
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
      moduleId: params.moduleId,
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
      moduleId: params.moduleId,
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

export function prepareBootstrapProject(params: {
  moduleId: RalphWorkflowModuleId;
  workspaceRoot: string;
  selectedConcept: string | null;
  directionLabel: string;
  projectSlug?: string;
}): { projectSlug: string; bootstrapTargetPath: string } {
  const projectSlug = slugify(
    params.projectSlug ?? params.selectedConcept ?? params.directionLabel,
  );
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
        `${params.moduleId} konnte für \`executionMode=bootstrap_project\` kein Git-Repo initialisieren.`,
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

export async function runRalphExecutionLoop(params: {
  moduleId: RalphWorkflowModuleId;
  request: WorkflowStartRequest;
  ctx: WorkflowModuleContext;
  input: RalphWorkflowInput;
  state: RalphWorkflowState;
  sessions: WorkflowRunSessions;
  harness: RalphRuntimeHarness;
  stories: StoryState[];
  approvedBrainstorming?: string;
  approvedSpecs: string;
  prd: string;
  globalLearnings: string[];
}) {
  let lastExecutionDecision: ExecutionReviewDecision["decision"] | null = null;
  let lastExecutionReason: string[] = [];
  let lastExecutionRound: number | null = null;
  let executionCompletedAt: string | null = null;
  let executionBlockedAt: string | null = null;

  for (
    let executionRound = 1;
    executionRound <= params.input.maxExecutionRounds;
    executionRound += 1
  ) {
    const story = params.stories.find((entry) => entry.status !== "done");
    if (!story) {
      params.state.status = "done";
      params.state.terminalReason = "All stories completed.";
      executionCompletedAt = executionCompletedAt ?? params.ctx.nowIso();
      break;
    }

    params.ctx.throwIfAbortRequested?.();
    params.state.currentRound += 1;
    story.status = "in_progress";
    story.attempts += 1;
    params.state.currentTask = `${story.id}: ${story.currentTask}`;
    const stepId = stepIdForExecution(executionRound);
    const iterationSessions = await ensureWorkflowSessions({
      runId: params.ctx.runId,
      specs: [
        {
          role: "worker",
          agentId: params.input.workerAgentId,
          label: `Workflow ${params.ctx.runId} ${story.id} worker ${story.attempts}`,
          name: `execution-worker-${story.id}-attempt-${story.attempts}`,
          model: params.input.workerModel,
          policy: "reset-on-reuse",
        },
        {
          role: "critic",
          agentId: params.input.reviewerAgentId,
          label: `Workflow ${params.ctx.runId} ${story.id} review ${story.attempts}`,
          name: `execution-review-${story.id}-attempt-${story.attempts}`,
          model: params.input.reviewerModel,
          policy: "reset-on-reuse",
        },
      ],
    });
    params.sessions.worker = iterationSessions.worker;
    params.sessions.critic = iterationSessions.critic;

    const workerPrompt = buildExecutionWorkerPrompt({
      story,
      round: executionRound,
      maxRounds: params.input.maxExecutionRounds,
      executionContext: params.state.executionContext!,
      approvedBrainstorming: params.approvedBrainstorming,
      approvedSpecs: params.approvedSpecs,
      prd: params.prd,
      globalLearnings: params.globalLearnings,
      constraints: params.input.constraints,
      bootstrapTemplate: params.input.bootstrapTemplate,
    });
    params.harness.writeArtifact(
      `execution-round-${executionRound}-worker-prompt.md`,
      workerPrompt,
      `execution round ${executionRound} worker prompt`,
      stepId,
      "worker",
    );
    const workerRun = await runWorkflowAgentOnSession({
      sessionKey: iterationSessions.worker!,
      message: workerPrompt,
      idempotencyKey: `${params.ctx.runId}-execution-worker-${executionRound}`,
      workspaceDir: params.state.executionContext!.executionWorkspace,
      abortSignal: params.ctx.abortSignal,
    });
    params.ctx.throwIfAbortRequested?.();
    params.state.latestWorkerOutput = workerRun.text;
    params.harness.writeArtifact(
      `execution-round-${executionRound}-worker.txt`,
      workerRun.text,
      `execution round ${executionRound} worker output`,
      stepId,
      "worker",
    );

    const evidence = collectExecutionEvidence(params.state.executionContext!, workerRun.text);
    params.harness.writeArtifact(
      `execution-round-${executionRound}-evidence.json`,
      JSON.stringify(evidence, null, 2),
      `execution round ${executionRound} evidence pack`,
      stepId,
      "orchestrator",
    );
    const reviewPrompt = buildExecutionReviewPrompt({
      story,
      round: executionRound,
      maxRounds: params.input.maxExecutionRounds,
      workerOutput: workerRun.text,
      evidence,
    });
    params.harness.writeArtifact(
      `execution-round-${executionRound}-review-prompt.md`,
      reviewPrompt,
      `execution round ${executionRound} review prompt`,
      stepId,
      "critic",
    );
    const reviewRun = await runWorkflowAgentOnSession({
      sessionKey: iterationSessions.critic!,
      message: reviewPrompt,
      idempotencyKey: `${params.ctx.runId}-execution-review-${executionRound}`,
      workspaceDir: params.state.executionContext!.executionWorkspace,
      abortSignal: params.ctx.abortSignal,
    });
    const decision = parseExecutionDecision(params.moduleId, reviewRun.text);
    params.state.latestCriticVerdict = decision.raw;
    params.harness.writeArtifact(
      `execution-round-${executionRound}-review.txt`,
      decision.raw,
      `execution round ${executionRound} review decision ${decision.decision}`,
      stepId,
      "critic",
    );

    for (const learning of decision.learnings) {
      if (!params.globalLearnings.includes(learning)) {
        params.globalLearnings.push(learning);
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
      story.blockedAt = params.ctx.nowIso();
      params.state.status = "blocked";
      executionBlockedAt = story.blockedAt;
      params.state.terminalReason = `${story.id} blocked: ${decision.reason.join(" | ")}`;
      params.harness.writeExecutionStateArtifact({
        stepId,
        activeStoryId: story.id,
        nextTask: decision.nextTask[0] ?? null,
        stories: params.stories,
        lastDecision: lastExecutionDecision,
        decisionReason: lastExecutionReason,
        lastRound: lastExecutionRound,
        globalLearnings: params.globalLearnings,
        blockedAt: executionBlockedAt,
      });
      params.harness.persist();
      break;
    }

    if (decision.decision === "DONE") {
      story.status = "done";
      story.completedAt = params.ctx.nowIso();
      const nextStory = params.stories.find((entry) => entry.status !== "done");
      if (!nextStory) {
        params.state.status = "done";
        params.state.terminalReason = "All stories completed.";
        params.state.currentTask = null;
        executionCompletedAt = params.ctx.nowIso();
      } else {
        params.state.currentTask = nextStory.currentTask;
      }
      params.harness.writeExecutionStateArtifact({
        stepId,
        activeStoryId: nextStory?.id ?? null,
        nextTask: nextStory?.currentTask ?? null,
        stories: params.stories,
        lastDecision: lastExecutionDecision,
        decisionReason: lastExecutionReason,
        lastRound: lastExecutionRound,
        globalLearnings: params.globalLearnings,
        completedAt: executionCompletedAt,
      });
      params.harness.persist();
      await emitTracedWorkflowReportEvent({
        trace: params.ctx.trace,
        stepId,
        moduleId: params.moduleId,
        runId: params.ctx.runId,
        phase: "execution_story_done",
        eventType: "milestone",
        messageText: [
          `Completed story ${story.id}.`,
          `Title: ${story.title}`,
          `Decision reason: ${decision.reason.join(" | ") || "none"}`,
        ].join("\n"),
        emittingAgentId: params.input.reviewerAgentId,
        origin: params.request.origin,
        reporting: params.request.reporting,
        status: "running",
        role: "critic",
        targetSessionKey: params.sessions.orchestrator,
        traceSummary: `${story.id} completed`,
      });
      if (params.state.status === "done") {
        break;
      }
      continue;
    }

    const nextTask = decision.nextTask[0] ?? story.currentTask;
    story.currentTask = nextTask;
    params.state.currentTask = `${story.id}: ${story.currentTask}`;
    story.status = "in_progress";
    params.harness.writeExecutionStateArtifact({
      stepId,
      activeStoryId: story.id,
      nextTask: story.currentTask,
      stories: params.stories,
      lastDecision: lastExecutionDecision,
      decisionReason: lastExecutionReason,
      lastRound: lastExecutionRound,
      globalLearnings: params.globalLearnings,
    });
    params.harness.persist();
  }

  return {
    lastExecutionDecision,
    lastExecutionReason,
    lastExecutionRound,
    executionCompletedAt,
    executionBlockedAt,
  };
}
