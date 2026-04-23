import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveAgentWorkspaceDir } from "../../../../agents/agent-scope.js";
import { loadConfig } from "../../../../config/config.js";
import { findGitRoot } from "../../../../infra/git-root.js";
import {
  createWorkflowAbortError,
  isWorkflowAbortError,
  throwIfWorkflowAbortRequested,
} from "../abort.js";
import { runWorkflowAgentOnSession } from "../agent-runtime.js";
import {
  workflowArtifactPath,
  workflowOwnedWorktreesDir,
  writeWorkflowArtifact,
} from "../store.js";
import type {
  WorkflowModule,
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../types.js";
import { emitTracedWorkflowReportEvent } from "../workflow-reporting.js";
import { ensureWorkflowSessions } from "../workflow-session-helper.js";
import {
  createCodexSdkWorkerRuntime,
  resolveCodexWorkerDefaultOptions,
  type CodexWorkerCompactionResult,
  type CodexWorkerReasoningEffort,
  type CodexWorkerRuntime,
  type CodexWorkerTurnResult,
} from "./codex-sdk-runtime.js";
import { codexControllerWorkflowModuleManifest } from "./manifests.js";

type WorkerCompactionMode = "off" | "app_server";
type WorkingDirectoryMode = "workflow_owned_worktree" | "existing";
type WorkspaceOwnership = "workflow_owned" | "operator_owned";

type WorkflowOwnedWorktree = {
  kind: "linked_worktree";
  rootPath: string;
  sourceRepoRoot: string;
};

type CodexControllerInput = {
  task: string;
  workingDirectory: string;
  repoRoot?: string;
  workingDirectoryMode?: WorkingDirectoryMode;
  agentId?: string;
  maxRetries?: number;
  successCriteria: string[];
  constraints: string[];
  codexAgentId: string;
  controllerAgentId: string;
  controllerPromptPath: string;
  workerModel?: string;
  workerReasoningEffort?: CodexWorkerReasoningEffort;
  workerCompactionMode?: WorkerCompactionMode;
  workerCompactionAfterRound?: number;
};

type RequestedCodexControllerInput = Omit<
  Required<CodexControllerInput>,
  "repoRoot" | "agentId" | "workerModel" | "workerReasoningEffort" | "workingDirectoryMode"
> & {
  requestedWorkingDirectory: string;
  requestedRepoRoot?: string;
  requestedWorkingDirectoryMode?: WorkingDirectoryMode;
  agentId?: string;
  workerModel?: string;
  workerReasoningEffort?: CodexWorkerReasoningEffort;
  closeoutContextSource: "repoRoot" | "workingDirectory";
};

type NormalizedCodexControllerInput = Omit<
  Required<CodexControllerInput>,
  "agentId" | "workerModel" | "workerReasoningEffort"
> & {
  agentId?: string;
  workerModel?: string;
  workerReasoningEffort?: CodexWorkerReasoningEffort;
  requestedWorkingDirectory: string;
  workspaceOwnership: WorkspaceOwnership;
  workflowOwnedWorktree?: WorkflowOwnedWorktree;
  closeoutContextSource: "repoRoot" | "workingDirectory";
};

type CloseoutContext = Pick<
  NormalizedCodexControllerInput,
  | "workingDirectory"
  | "requestedWorkingDirectory"
  | "repoRoot"
  | "workingDirectoryMode"
  | "workspaceOwnership"
  | "workflowOwnedWorktree"
  | "closeoutContextSource"
>;

type CloseoutMode =
  | "repo_integrated"
  | "linked_worktree_local"
  | "workflow_owned_worktree_local";

type CloseoutCheckCode =
  | "git_repo_missing"
  | "git_head_missing"
  | "dirty_repo"
  | "open_worktree"
  | "integration_ref_missing"
  | "integration_merge_base_missing"
  | "not_integrated";

type CloseoutCheck = {
  code: CloseoutCheckCode;
  ok: boolean;
  summary: string;
  detail?: string;
};

type CloseoutAssessment = {
  status: "pass" | "blocked";
  reason: string;
  trace: string[];
  context: {
    workingDirectory: string;
    requestedWorkingDirectory: string;
    requestedRepoRoot: string;
    workingDirectoryMode: WorkingDirectoryMode;
    workspaceOwnership: WorkspaceOwnership;
    workflowOwnedWorktreeRoot: string | null;
    closeoutContextSource: CloseoutContext["closeoutContextSource"];
    closeoutMode: CloseoutMode;
    resolvedRepoRoot: string | null;
  };
  git: {
    head: string | null;
    baseRef: string | null;
    mergeBase: string | null;
    dirtyPaths: string[];
    worktreePaths: string[];
  };
  checks: CloseoutCheck[];
};

type CloseoutPreflightFailureClass =
  | "worker_fixable"
  | "ambient_repo_state"
  | "operator_blocker"
  | "unknown";

type CloseoutPreflightCheckValue = boolean | "unknown";

type CloseoutPreflight = {
  status: "pass" | "fail" | "unknown";
  failureClass: CloseoutPreflightFailureClass;
  summary: string;
  reason: string;
  mode: CloseoutMode;
  repoRoot: string | null;
  workingDirectory: string;
  requestedWorkingDirectory: string;
  baseRef: string | null;
  head: string | null;
  checks: {
    repoClean: CloseoutPreflightCheckValue;
    noOpenLinkedWorktrees: CloseoutPreflightCheckValue;
    headIntegratedIntoBase: CloseoutPreflightCheckValue;
  };
  dirtyPaths: string[];
  openWorktreePaths: string[];
  trace: string[];
};

type WorkspaceCleanupResult = {
  status: "not_applicable" | "skipped" | "passed" | "blocked";
  reason: string;
  trace: string[];
};

type ControllerDecision = {
  decision: "CONTINUE" | "ESCALATE_BLOCKED" | "DONE";
  reason: string[];
  nextInstruction: string[];
  blocker: string[];
  raw: string;
};

type WorkerRoundSummary = {
  round: number;
  excerpt: string;
  claims: string[];
  evidence: string[];
  blockers: string[];
  questions: string[];
  statusHint: string;
  narrativeOnly: boolean;
};

type ControllerRoundSummary = {
  round: number;
  decision: ControllerDecision["decision"];
  reason: string[];
  nextInstruction: string[];
  blocker: string[];
};

type DriftAssessment = {
  repetitiveNarrative: boolean;
  repeatedClaim: boolean;
  evidenceThin: boolean;
  signals: string[];
  recommendation: "normal_continue" | "corrective_continue_required" | "escalate_or_correct";
};

type CodexControllerRunContract = {
  version: 1;
  moduleId: "codex_controller";
  runId: string;
  createdAt: string;
  input: NormalizedCodexControllerInput;
  controllerPrompt: string;
  workerDeveloperInstructions: string;
  contextWorkspaceDir?: string;
};

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_CONTROLLER_PROMPT_PATH =
  "/home/pibo/.openclaw/workspace/prompts/coding-controller-prompt.md";
const DEFAULT_WORKER_COMPACTION_MODE: WorkerCompactionMode = "off";
const DEFAULT_WORKER_COMPACTION_AFTER_ROUND = 3;
const CODEX_CONTROLLER_RUN_CONTRACT_ARTIFACT = "codex-controller-run-contract.json";
const CODEX_WORKER_HARD_TURN_TIMEOUT_SECONDS = 2 * 60 * 60;
const CODEX_WORKER_IDLE_TIMEOUT_SECONDS = 8 * 60;
const CODEX_WORKER_RETRY_DELAYS_MS = [1_000] as const;
const CODEX_WORKER_TRANSPORT_TRANSITION_RETRY_DELAY_MS = 250;
const WORKER_FINISH_QUALITY_LINES = [
  "Before claiming done, remove avoidable transient artifacts created only during verification, such as __pycache__/ and .pytest_cache/, unless the task explicitly wants them kept.",
  "Keep README usage aligned with the commands that actually work in this repository.",
  "If you run tests or smoke checks, make sure the repository is left in a tidy post-verification state.",
] as const;
const RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE = [
  /\btimed out after \d+ms\b/i,
  /\brpc timeout\b/i,
  /\bprompt(?:\s+\w+){0,6}\s+(?:timed out|timeout)\b/i,
  /\bprompt completion failed\b.*\b(timeout|temporar|transient|overload|unavailable|connection|closed|reset|network|fetch failed)\b/i,
  /\b(connection (?:closed|reset|error)|transport closed|fetch failed|econnreset|ehostdown|epipe|gateway timeout|service unavailable|temporarily unavailable|overloaded)\b/i,
  /\b(falling back from websockets to https transport|reconnecting\.\.\.|transport fallback)\b/i,
  /\btimeout waiting for child process to exit\b/i,
] as const;
const NON_RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE = [
  /\b(permission denied|unauthori(?:s|z)ed|forbidden|not accept config key|unsupported|invalid|not found|prompt exceeds maximum allowed size|tool approval|approval denied|schema|validation)\b/i,
] as const;
type CodexWorkerRetryClassification = {
  retryable: boolean;
  reason: "timeout" | "transient_prompt_failure" | "transport_transition" | "non_retryable";
  errorCode?: string;
  message: string;
};

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeCompactionMode(value: unknown): WorkerCompactionMode {
  if (value === "app_server" || value === "acp_control_command") {
    return "app_server";
  }
  return DEFAULT_WORKER_COMPACTION_MODE;
}

function normalizeWorkingDirectoryMode(value: unknown): WorkingDirectoryMode | undefined {
  if (value === "existing" || value === "workflow_owned_worktree") {
    return value;
  }
  return undefined;
}

function runGitCommand(cwd: string, args: string[]): { ok: true; output: string } | {
  ok: false;
  message: string;
} {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    return { ok: false, message };
  }
}

function normalizeRequestedInput(request: WorkflowStartRequest): RequestedCodexControllerInput {
  const record = request.input as Record<string, unknown>;
  if (!record || typeof record !== "object") {
    throw new Error("codex_controller erwartet ein JSON-Objekt als Input.");
  }
  const task = typeof record.task === "string" ? record.task.trim() : "";
  const rawWorkingDirectory =
    typeof record.workingDirectory === "string" ? record.workingDirectory.trim() : "";
  const rawRepoRoot = typeof record.repoRoot === "string" ? record.repoRoot.trim() : "";
  const agentId =
    typeof record.agentId === "string" && record.agentId.trim() ? record.agentId.trim() : undefined;
  if (!task) {
    throw new Error("codex_controller benötigt ein nicht-leeres Feld `task`.");
  }
  if (!rawWorkingDirectory) {
    throw new Error(
      "codex_controller benötigt `input.workingDirectory`. Falls `repoPath` übergeben wurde, bitte in `workingDirectory` umbenennen.",
    );
  }
  const maxRetries =
    normalizePositiveInteger(record.maxRetries) ??
    normalizePositiveInteger(record.maxRounds) ??
    normalizePositiveInteger(request.maxRounds) ??
    DEFAULT_MAX_ROUNDS;
  const workerDefaults = resolveCodexWorkerDefaultOptions({
    model:
      typeof record.workerModel === "string" && record.workerModel.trim()
        ? record.workerModel.trim()
        : undefined,
    reasoningEffort: record.workerReasoningEffort,
  });
  return {
    task,
    requestedWorkingDirectory: path.resolve(rawWorkingDirectory),
    ...(rawRepoRoot ? { requestedRepoRoot: path.resolve(rawRepoRoot) } : {}),
    ...(normalizeWorkingDirectoryMode(record.workingDirectoryMode)
      ? { requestedWorkingDirectoryMode: normalizeWorkingDirectoryMode(record.workingDirectoryMode) }
      : {}),
    agentId,
    maxRetries,
    successCriteria: normalizeStringArray(record.successCriteria),
    constraints: normalizeStringArray(record.constraints),
    codexAgentId:
      typeof record.codexAgentId === "string" && record.codexAgentId.trim()
        ? record.codexAgentId.trim()
        : "codex",
    controllerAgentId:
      typeof record.controllerAgentId === "string" && record.controllerAgentId.trim()
        ? record.controllerAgentId.trim()
        : "codex-controller",
    controllerPromptPath:
      typeof record.controllerPromptPath === "string" && record.controllerPromptPath.trim()
        ? record.controllerPromptPath.trim()
        : DEFAULT_CONTROLLER_PROMPT_PATH,
    workerModel: workerDefaults.model,
    workerReasoningEffort: workerDefaults.reasoningEffort,
    workerCompactionMode: normalizeCompactionMode(record.workerCompactionMode),
    workerCompactionAfterRound:
      normalizePositiveInteger(record.workerCompactionAfterRound) ??
      DEFAULT_WORKER_COMPACTION_AFTER_ROUND,
    closeoutContextSource: rawRepoRoot ? "repoRoot" : "workingDirectory",
  };
}

function normalizePersistedInput(record: Record<string, unknown>): NormalizedCodexControllerInput {
  const requested = normalizeRequestedInput({
    input: {
      ...record,
      workingDirectory:
        typeof record.requestedWorkingDirectory === "string" && record.requestedWorkingDirectory.trim()
          ? record.requestedWorkingDirectory
          : record.workingDirectory,
      repoRoot:
        typeof record.repoRoot === "string" && record.repoRoot.trim() ? record.repoRoot : undefined,
      workingDirectoryMode:
        typeof record.workingDirectoryMode === "string" && record.workingDirectoryMode.trim()
          ? record.workingDirectoryMode
          : "existing",
    },
  });
  const workingDirectory =
    typeof record.workingDirectory === "string" && record.workingDirectory.trim()
      ? path.resolve(record.workingDirectory)
      : requested.requestedWorkingDirectory;
  const workspaceOwnership: WorkspaceOwnership =
    record.workspaceOwnership === "workflow_owned" ? "workflow_owned" : "operator_owned";
  const workflowOwnedWorktree =
    workspaceOwnership === "workflow_owned" &&
    record.workflowOwnedWorktree &&
    typeof record.workflowOwnedWorktree === "object"
      ? ({
          kind: "linked_worktree",
          rootPath: path.resolve(
            String(
              (record.workflowOwnedWorktree as { rootPath?: unknown }).rootPath ?? workingDirectory,
            ),
          ),
          sourceRepoRoot: path.resolve(
            String(
              (record.workflowOwnedWorktree as { sourceRepoRoot?: unknown }).sourceRepoRoot ??
                requested.requestedRepoRoot ??
                requested.requestedWorkingDirectory,
            ),
          ),
        } satisfies WorkflowOwnedWorktree)
      : undefined;
  return {
    task: requested.task,
    workingDirectory,
    requestedWorkingDirectory: requested.requestedWorkingDirectory,
    repoRoot: path.resolve(requested.requestedRepoRoot ?? workingDirectory),
    workingDirectoryMode:
      normalizeWorkingDirectoryMode(record.workingDirectoryMode) ??
      (workflowOwnedWorktree ? "workflow_owned_worktree" : "existing"),
    workspaceOwnership,
    ...(workflowOwnedWorktree ? { workflowOwnedWorktree } : {}),
    agentId: requested.agentId,
    maxRetries: requested.maxRetries,
    successCriteria: requested.successCriteria,
    constraints: requested.constraints,
    codexAgentId: requested.codexAgentId,
    controllerAgentId: requested.controllerAgentId,
    controllerPromptPath: requested.controllerPromptPath,
    workerModel: requested.workerModel,
    workerReasoningEffort: requested.workerReasoningEffort,
    workerCompactionMode: requested.workerCompactionMode,
    workerCompactionAfterRound: requested.workerCompactionAfterRound,
    closeoutContextSource: requested.closeoutContextSource,
  };
}

function buildWorkflowOwnedWorktreeRoot(runId: string): string {
  const worktreeDir = path.resolve(workflowOwnedWorktreesDir());
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(worktreeDir, safeRunId);
}

function resolveGitTopLevel(startPath: string): string | null {
  return (
    runGitReadOnly(startPath, ["rev-parse", "--show-toplevel"]) ??
    findGitRoot(startPath) ??
    null
  );
}

function resolveExecutionWorkspace(params: {
  runId: string;
  requestedInput: RequestedCodexControllerInput;
}): NormalizedCodexControllerInput {
  const requestedMode = params.requestedInput.requestedWorkingDirectoryMode;
  const sourceRepoRoot = resolveGitTopLevel(params.requestedInput.requestedWorkingDirectory);
  const shouldUseWorkflowOwnedWorktree =
    requestedMode === "workflow_owned_worktree" ||
    (requestedMode === undefined && sourceRepoRoot !== null);
  if (requestedMode === "workflow_owned_worktree" && !sourceRepoRoot) {
    throw new Error(
      `codex_controller konnte kein workflow-eigenes linked worktree anlegen, weil ${params.requestedInput.requestedWorkingDirectory} kein git checkout ist.`,
    );
  }
  if (!shouldUseWorkflowOwnedWorktree || !sourceRepoRoot) {
    return {
      task: params.requestedInput.task,
      workingDirectory: params.requestedInput.requestedWorkingDirectory,
      requestedWorkingDirectory: params.requestedInput.requestedWorkingDirectory,
      repoRoot: path.resolve(
        params.requestedInput.requestedRepoRoot ?? params.requestedInput.requestedWorkingDirectory,
      ),
      workingDirectoryMode: "existing",
      workspaceOwnership: "operator_owned",
      agentId: params.requestedInput.agentId,
      maxRetries: params.requestedInput.maxRetries,
      successCriteria: params.requestedInput.successCriteria,
      constraints: params.requestedInput.constraints,
      codexAgentId: params.requestedInput.codexAgentId,
      controllerAgentId: params.requestedInput.controllerAgentId,
      controllerPromptPath: params.requestedInput.controllerPromptPath,
      workerModel: params.requestedInput.workerModel,
      workerReasoningEffort: params.requestedInput.workerReasoningEffort,
      workerCompactionMode: params.requestedInput.workerCompactionMode,
      workerCompactionAfterRound: params.requestedInput.workerCompactionAfterRound,
      closeoutContextSource: params.requestedInput.closeoutContextSource,
    };
  }
  const relativeWorkingDirectory = path.relative(
    sourceRepoRoot,
    params.requestedInput.requestedWorkingDirectory,
  );
  const worktreeRootPath = buildWorkflowOwnedWorktreeRoot(params.runId);
  mkdirSync(path.dirname(worktreeRootPath), { recursive: true });
  const addResult = runGitCommand(sourceRepoRoot, [
    "worktree",
    "add",
    "--detach",
    worktreeRootPath,
    "HEAD",
  ]);
  if (!addResult.ok) {
    throw new Error(
      `codex_controller konnte kein workflow-eigenes linked worktree anlegen: ${addResult.message}`,
    );
  }
  const workingDirectory =
    relativeWorkingDirectory && relativeWorkingDirectory !== "."
      ? path.join(worktreeRootPath, relativeWorkingDirectory)
      : worktreeRootPath;
  return {
    task: params.requestedInput.task,
    workingDirectory,
    requestedWorkingDirectory: params.requestedInput.requestedWorkingDirectory,
    repoRoot: path.resolve(params.requestedInput.requestedRepoRoot ?? sourceRepoRoot),
    workingDirectoryMode: "workflow_owned_worktree",
    workspaceOwnership: "workflow_owned",
    workflowOwnedWorktree: {
      kind: "linked_worktree",
      rootPath: worktreeRootPath,
      sourceRepoRoot,
    },
    agentId: params.requestedInput.agentId,
    maxRetries: params.requestedInput.maxRetries,
    successCriteria: params.requestedInput.successCriteria,
    constraints: params.requestedInput.constraints,
    codexAgentId: params.requestedInput.codexAgentId,
    controllerAgentId: params.requestedInput.controllerAgentId,
    controllerPromptPath: params.requestedInput.controllerPromptPath,
    workerModel: params.requestedInput.workerModel,
    workerReasoningEffort: params.requestedInput.workerReasoningEffort,
    workerCompactionMode: params.requestedInput.workerCompactionMode,
    workerCompactionAfterRound: params.requestedInput.workerCompactionAfterRound,
    closeoutContextSource: params.requestedInput.closeoutContextSource,
  };
}

function loadControllerPrompt(promptPath: string): string {
  if (!existsSync(promptPath)) {
    throw new Error(`Controller-Prompt nicht gefunden: ${promptPath}`);
  }
  const raw = readFileSync(promptPath, "utf8").trim();
  if (!raw) {
    throw new Error(`Controller-Prompt ist leer: ${promptPath}`);
  }
  return raw;
}

function buildWorkerDeveloperInstructions(input: NormalizedCodexControllerInput): string {
  return [
    "You are the Codex worker inside OpenClaw's codex_controller workflow.",
    "Treat this persisted run contract as the stable source of truth for the whole run, including retries, resumes, and compaction.",
    "Later user-turn prompts may narrow the next step, but they do not replace the original task, success criteria, constraints, or finish quality below.",
    "",
    "ORIGINAL_TASK:",
    input.task,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(input.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(input.constraints),
    "",
    "FINISH_QUALITY:",
    ...WORKER_FINISH_QUALITY_LINES.map((line) => `- ${line}`),
  ].join("\n");
}

function buildRunContract(params: {
  runId: string;
  createdAt: string;
  input: NormalizedCodexControllerInput;
  controllerPrompt: string;
  contextWorkspaceDir?: string;
}): CodexControllerRunContract {
  return {
    version: 1,
    moduleId: "codex_controller",
    runId: params.runId,
    createdAt: params.createdAt,
    input: params.input,
    controllerPrompt: params.controllerPrompt,
    workerDeveloperInstructions: buildWorkerDeveloperInstructions(params.input),
    ...(params.contextWorkspaceDir ? { contextWorkspaceDir: params.contextWorkspaceDir } : {}),
  };
}

function serializeRunContract(contract: CodexControllerRunContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function parseRunContract(raw: string, runId: string): CodexControllerRunContract {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Persisted codex_controller run contract is not an object for run ${runId}.`);
  }
  if (parsed.version !== 1 || parsed.moduleId !== "codex_controller" || parsed.runId !== runId) {
    throw new Error(
      `Persisted codex_controller run contract metadata is invalid for run ${runId}.`,
    );
  }
  const controllerPrompt =
    typeof parsed.controllerPrompt === "string" ? parsed.controllerPrompt.trim() : "";
  const workerDeveloperInstructions =
    typeof parsed.workerDeveloperInstructions === "string"
      ? parsed.workerDeveloperInstructions.trim()
      : "";
  const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt.trim() : "";
  if (!controllerPrompt || !workerDeveloperInstructions || !createdAt) {
    throw new Error(`Persisted codex_controller run contract is incomplete for run ${runId}.`);
  }
  return {
    version: 1,
    moduleId: "codex_controller",
    runId,
    createdAt,
    input: normalizePersistedInput((parsed.input ?? {}) as Record<string, unknown>),
    controllerPrompt,
    workerDeveloperInstructions,
    ...(typeof parsed.contextWorkspaceDir === "string" && parsed.contextWorkspaceDir.trim()
      ? {
          contextWorkspaceDir: path.resolve(parsed.contextWorkspaceDir.trim()),
        }
      : {}),
  };
}

function loadPersistedRunContract(runId: string): CodexControllerRunContract | null {
  const contractPath = workflowArtifactPath(runId, CODEX_CONTROLLER_RUN_CONTRACT_ARTIFACT);
  if (!existsSync(contractPath)) {
    return null;
  }
  return parseRunContract(readFileSync(contractPath, "utf8"), runId);
}

function toBulletLines(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
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

function normalizeSingleLineSection(raw: string, labels: string[]): string | null {
  for (const label of labels) {
    const match = raw.match(new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]+)`));
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function splitMessageIntoInstructions(messageLines: string[]): string[] {
  return messageLines
    .flatMap((line) => line.split(/\n+/))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s*/, "").trim())
    .filter(Boolean);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function uniqueLimited(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function summarizeLineCandidates(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s*/, "").trim());
}

function extractEvidence(text: string): string[] {
  const candidates = summarizeLineCandidates(text);
  const evidence = candidates.filter((line) =>
    /(\[tool\]|\b(test|tests|tested|verify|verified|verification|reproduce|reproduced|ran|run|running|diff|grep|rg|git|pnpm|npm|yarn|vitest|jest|pytest|cargo|go test|changed|updated|edited|patched|created|deleted|removed|file|files)\b|`[^`]+`|\b\w+[./-]\w+)/i.test(
      line,
    ),
  );
  return uniqueLimited(
    evidence.map((line) => truncateText(line, 140)),
    4,
  );
}

function extractClaims(text: string): string[] {
  const candidates = summarizeLineCandidates(text);
  const claims = candidates.filter((line) =>
    /\b(done|complete|completed|fixed|implemented|finished|resolved|working on|progress|verified|ready)\b/i.test(
      line,
    ),
  );
  return uniqueLimited(
    claims.map((line) => truncateText(line, 140)),
    4,
  );
}

function extractBlockers(text: string): string[] {
  const candidates = summarizeLineCandidates(text);
  const blockers = candidates.filter((line) =>
    /\b(blocked|blocker|cannot|can't|unable|missing|failed|error|permission|approval|credential|login|outage)\b/i.test(
      line,
    ),
  );
  return uniqueLimited(
    blockers.map((line) => truncateText(line, 140)),
    3,
  );
}

function extractQuestions(text: string): string[] {
  return uniqueLimited(
    summarizeLineCandidates(text)
      .filter((line) => line.includes("?"))
      .map((line) => truncateText(line, 140)),
    2,
  );
}

function summarizeWorkerRound(round: number, workerOutput: string): WorkerRoundSummary {
  const claims = extractClaims(workerOutput);
  const evidence = extractEvidence(workerOutput);
  const blockers = extractBlockers(workerOutput);
  const questions = extractQuestions(workerOutput);
  const lowered = workerOutput.toLowerCase();
  const doneClaim = /\b(done|complete|completed|ready|verified)\b/.test(lowered);
  const statusHint = blockers.length
    ? "blocked"
    : questions.length
      ? "needs_reply"
      : doneClaim
        ? "claims_done"
        : evidence.length
          ? "working_with_evidence"
          : claims.length
            ? "working_narrative"
            : "unclear";
  return {
    round,
    excerpt: truncateText(workerOutput, 240),
    claims,
    evidence,
    blockers,
    questions,
    statusHint,
    narrativeOnly: claims.length > 0 && evidence.length === 0,
  };
}

function summarizeControllerRound(
  round: number,
  decision: ControllerDecision,
): ControllerRoundSummary {
  return {
    round,
    decision: decision.decision,
    reason: uniqueLimited(
      decision.reason.map((line) => truncateText(line, 140)),
      3,
    ),
    nextInstruction: uniqueLimited(
      decision.nextInstruction.map((line) => truncateText(line, 140)),
      3,
    ),
    blocker: uniqueLimited(
      decision.blocker.map((line) => truncateText(line, 140)),
      2,
    ),
  };
}

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`'".,:;!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCodexWorkerTransportTransitionMessage(message: string): boolean {
  return (
    /\bcodex worker transport fallback interrupted the turn before concrete output was produced\b/i.test(
      message,
    ) || /\bfalling back from websockets to https transport\b/i.test(message)
  );
}

function claimsLookRepeated(currentClaims: string[], priorClaims: string[]): boolean {
  if (currentClaims.length === 0 || priorClaims.length === 0) {
    return false;
  }
  const prior = new Set(priorClaims.map(normalizeForComparison));
  return currentClaims.some((claim) => prior.has(normalizeForComparison(claim)));
}

function assessDrift(params: {
  current: WorkerRoundSummary;
  priorWorkers: WorkerRoundSummary[];
  priorControllers: ControllerRoundSummary[];
}): DriftAssessment {
  const previousWorker = params.priorWorkers.at(-1);
  const previousController = params.priorControllers.at(-1);
  const repeatedClaim = previousWorker
    ? claimsLookRepeated(params.current.claims, previousWorker.claims)
    : false;
  const repetitiveNarrative =
    params.current.narrativeOnly && (previousWorker?.narrativeOnly || repeatedClaim);
  const evidenceThin = params.current.evidence.length === 0;
  const signals: string[] = [];
  if (repeatedClaim) {
    signals.push("worker repeated prior progress/completion claims");
  }
  if (repetitiveNarrative) {
    signals.push("worker stayed narrative without fresh concrete evidence");
  }
  if (evidenceThin) {
    signals.push("visible output lacks concrete implementation or verification evidence");
  }
  if (params.current.questions.length && previousController?.decision === "CONTINUE") {
    signals.push("worker is asking again after a prior continue");
  }
  const recommendation =
    repetitiveNarrative || (repeatedClaim && evidenceThin)
      ? "escalate_or_correct"
      : evidenceThin || params.current.questions.length
        ? "corrective_continue_required"
        : "normal_continue";
  return {
    repetitiveNarrative,
    repeatedClaim,
    evidenceThin,
    signals: uniqueLimited(signals, 4),
    recommendation,
  };
}

function formatWorkerHistory(history: WorkerRoundSummary[]): string {
  if (history.length === 0) {
    return "- none";
  }
  return history
    .map((entry) =>
      [
        `- round ${entry.round}: status=${entry.statusHint}`,
        ...(entry.claims.length ? [`  claims: ${entry.claims.join(" | ")}`] : []),
        ...(entry.evidence.length ? [`  evidence: ${entry.evidence.join(" | ")}`] : []),
        ...(!entry.evidence.length ? ["  evidence: none visible"] : []),
        ...(entry.blockers.length ? [`  blockers: ${entry.blockers.join(" | ")}`] : []),
      ].join("\n"),
    )
    .join("\n");
}

function formatControllerHistory(history: ControllerRoundSummary[]): string {
  if (history.length === 0) {
    return "- none";
  }
  return history
    .map((entry) =>
      [
        `- round ${entry.round}: decision=${entry.decision}`,
        ...(entry.reason.length ? [`  reason: ${entry.reason.join(" | ")}`] : []),
        ...(entry.nextInstruction.length
          ? [`  next_instruction: ${entry.nextInstruction.join(" | ")}`]
          : []),
        ...(entry.blocker.length ? [`  blocker: ${entry.blocker.join(" | ")}`] : []),
      ].join("\n"),
    )
    .join("\n");
}

function buildProgressEvidence(worker: WorkerRoundSummary): string {
  if (worker.evidence.length === 0) {
    return "- none visible in worker output";
  }
  return worker.evidence.map((line) => `- ${line}`).join("\n");
}

function buildStatusHints(worker: WorkerRoundSummary, drift: DriftAssessment): string {
  const hints = [`worker_status=${worker.statusHint}`];
  if (worker.narrativeOnly) {
    hints.push("narrative_only_claims=true");
  }
  if (drift.repeatedClaim) {
    hints.push("repeated_claim=true");
  }
  if (drift.evidenceThin) {
    hints.push("evidence_thin=true");
  }
  return hints.map((line) => `- ${line}`).join("\n");
}

function buildDriftSignals(drift: DriftAssessment): string {
  if (drift.signals.length === 0) {
    return "- none";
  }
  return drift.signals.map((line) => `- ${line}`).join("\n");
}

function nextInstructionIsCorrective(nextInstruction: string[]): boolean {
  const joined = nextInstruction.join(" ").toLowerCase();
  return /(verify|test|inspect|check|diff|implement|edit|change|update|reproduce|confirm|prove|show|run|compare|report|summari)/.test(
    joined,
  );
}

function enforceContinueGuardrails(params: {
  round: number;
  decision: ControllerDecision;
  drift: DriftAssessment;
}): void {
  if (params.decision.decision !== "CONTINUE") {
    return;
  }
  if (params.decision.nextInstruction.length === 0) {
    throw new Error(
      `Controller returned CONTINUE without actionable NEXT_INSTRUCTION in round ${params.round}.`,
    );
  }
  if (
    params.drift.recommendation !== "normal_continue" &&
    !nextInstructionIsCorrective(params.decision.nextInstruction)
  ) {
    throw new Error(
      `Controller returned CONTINUE without corrective guidance despite drift/evidence warnings in round ${params.round}.`,
    );
  }
}

function looksLikeDoneSignal(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "task is complete",
    "task appears complete",
    "work is complete",
    "implementation is complete",
    "sufficiently complete",
    "ready to wrap",
    "ready to finalize",
    "ready for final handoff",
    "already complete",
    "no further coding turn",
    "stop the loop",
    "controller approved completion",
  ].some((needle) => normalized.includes(needle));
}

function mapLegacyDecision(raw: string): ControllerDecision | null {
  const legacy = normalizeSingleLineSection(raw, ["MODULE_DECISION", "DECISION"]);
  if (!legacy) {
    return null;
  }

  const normalizedLegacy = legacy.trim().toUpperCase();
  const rationale = parseSection(raw, "RATIONALE");
  const reason = parseSection(raw, "MODULE_REASON");
  const nextInstruction = parseSection(raw, "NEXT_INSTRUCTION");
  const blocker = parseSection(raw, "BLOCKER");
  const controllerMessage = splitMessageIntoInstructions(parseSection(raw, "CONTROLLER_MESSAGE"));

  if (!["CONTINUE", "GUIDE", "ASK_USER", "STOP_BLOCKED"].includes(normalizedLegacy)) {
    return null;
  }

  if (normalizedLegacy === "ASK_USER" || normalizedLegacy === "STOP_BLOCKED") {
    return {
      decision: "ESCALATE_BLOCKED",
      reason: reason.length ? reason : rationale,
      nextInstruction: [],
      blocker: blocker.length ? blocker : controllerMessage,
      raw,
    };
  }

  if (reason.length || nextInstruction.length || blocker.length) {
    return {
      decision: looksLikeDoneSignal(raw) ? "DONE" : "CONTINUE",
      reason: reason.length ? reason : rationale,
      nextInstruction: nextInstruction.length ? nextInstruction : controllerMessage,
      blocker,
      raw,
    };
  }

  return {
    decision: looksLikeDoneSignal(raw) ? "DONE" : "CONTINUE",
    reason: rationale,
    nextInstruction: controllerMessage,
    blocker: [],
    raw,
  };
}

function parseControllerDecision(raw: string): ControllerDecision {
  const explicitDecision = normalizeSingleLineSection(raw, ["MODULE_DECISION", "DECISION"]);
  const normalizedExplicit = explicitDecision?.trim().toUpperCase() ?? null;

  if (normalizedExplicit && ["CONTINUE", "ESCALATE_BLOCKED", "DONE"].includes(normalizedExplicit)) {
    const decision = normalizedExplicit as ControllerDecision["decision"];
    const reason = parseSection(raw, "MODULE_REASON");
    const nextInstruction = parseSection(raw, "NEXT_INSTRUCTION");
    const blocker = parseSection(raw, "BLOCKER");
    const controllerMessage = splitMessageIntoInstructions(parseSection(raw, "CONTROLLER_MESSAGE"));
    const rationale = parseSection(raw, "RATIONALE");

    return {
      decision,
      reason: reason.length ? reason : rationale,
      nextInstruction: nextInstruction.length ? nextInstruction : controllerMessage,
      blocker,
      raw,
    };
  }

  const legacy = mapLegacyDecision(raw);
  if (legacy) {
    return legacy;
  }

  throw new Error(
    "Controller-Entscheidung unparsbar. Erwartet wurde ein normalisierter MODULE_DECISION/DECISION-Block oder der Legacy-Contract des Controller-Prompts.\n\n" +
      raw,
  );
}

function buildCodexPrompt(params: {
  runContract: CodexControllerRunContract;
  round: number;
  maxRounds: number;
  nextInstruction: string[];
}): string {
  return [
    params.round === 1
      ? params.runContract.input.task
      : [
          "Continue the same coding task in the same workspace/session.",
          "Use the controller feedback below as the next focused instruction.",
          "Do not ask the user for routine continuation approval. Keep moving unless truly blocked.",
          "CONTROLLER_NEXT_INSTRUCTION:",
          toBulletLines(params.nextInstruction),
        ].join("\n"),
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.runContract.input.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.runContract.input.constraints),
    "",
    "FINISH_QUALITY:",
    ...WORKER_FINISH_QUALITY_LINES.map((line) => `- ${line}`),
  ].join("\n");
}

function buildControllerInitPrompt(params: { runContract: CodexControllerRunContract }): string {
  return [
    params.runContract.controllerPrompt,
    "",
    "You are operating inside the codex_controller PIBO workflow module.",
    "This controller session is persistent for the whole workflow run.",
    "Treat the persisted run contract in this message as the stable source of truth for this run.",
    "Later messages include the same run contract in compact form plus bounded per-round deltas.",
    `Round budget: ${params.runContract.input.maxRetries}.`,
    "Use the controller prompt above as policy for the whole run.",
    "For round messages, first decide using the prompt's native contract if helpful. Then return a final normalized block.",
    "",
    "NORMALIZED WORKFLOW CONTRACT:",
    "MODULE_DECISION: CONTINUE | ESCALATE_BLOCKED | DONE",
    "MODULE_REASON:",
    "- ...",
    "NEXT_INSTRUCTION:",
    "- ...",
    "BLOCKER:",
    "- ...",
    "",
    "Decision mapping rules:",
    "- CONTINUE or GUIDE from the base prompt map to MODULE_DECISION: CONTINUE.",
    "- ASK_USER or STOP_BLOCKED from the base prompt map to MODULE_DECISION: ESCALATE_BLOCKED.",
    "- Use MODULE_DECISION: DONE only when the worker output is already sufficiently complete against the original task and success criteria.",
    "- If CLOSEOUT_PREFLIGHT.status=fail, MODULE_DECISION must not be DONE.",
    "- If CLOSEOUT_PREFLIGHT.failure_class=worker_fixable, NEXT_INSTRUCTION should name the concrete closeout fix still required.",
    "- If CLOSEOUT_PREFLIGHT.failure_class=ambient_repo_state or operator_blocker, do not pretend another worker turn will magically fix it. Prefer ESCALATE_BLOCKED unless a narrow worker-fixable substep is explicit.",
    "- If CLOSEOUT_PREFLIGHT.status=unknown, be conservative about DONE and prefer more verification or escalation over optimism.",
    "- If MODULE_DECISION is CONTINUE, NEXT_INSTRUCTION must be concrete, actionable, and evidence-seeking when drift signals exist.",
    "- If worker progress claims repeat without fresh concrete evidence, do not issue a bare continue. Provide corrective guidance that forces concrete implementation or verification evidence, or escalate if no viable next move remains.",
    "- Judge only from visible worker output, compact visible-history summaries, your own prior controller history, and runtime hints. Do not assume access to hidden reasoning.",
    "- If MODULE_DECISION is DONE or ESCALATE_BLOCKED, NEXT_INSTRUCTION may be empty.",
    "- Do not silently omit the normalized block.",
    "",
    "RUN_CONTRACT:",
    `run_id=${params.runContract.runId}`,
    `working_directory=${params.runContract.input.workingDirectory}`,
    `requested_working_directory=${params.runContract.input.requestedWorkingDirectory}`,
    `working_directory_mode=${params.runContract.input.workingDirectoryMode}`,
    `workspace_ownership=${params.runContract.input.workspaceOwnership}`,
    `repo_root=${params.runContract.input.repoRoot}`,
    `closeout_context_source=${params.runContract.input.closeoutContextSource}`,
    ...(params.runContract.input.workflowOwnedWorktree
      ? [`workflow_owned_worktree_root=${params.runContract.input.workflowOwnedWorktree.rootPath}`]
      : []),
    ...(params.runContract.contextWorkspaceDir
      ? [`context_workspace_dir=${params.runContract.contextWorkspaceDir}`]
      : []),
    "",
    "ORIGINAL_TASK:",
    params.runContract.input.task,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.runContract.input.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.runContract.input.constraints),
    "",
    "Do not make a workflow decision in response to this initialization message.",
    "Reply exactly with: CONTROLLER_READY",
  ].join("\n");
}

function closeoutCheckValue(
  assessment: CloseoutAssessment,
  code: CloseoutCheckCode,
): CloseoutPreflightCheckValue {
  const check = assessment.checks.find((entry) => entry.code === code);
  return check ? check.ok : "unknown";
}

function pathIsInsideDirectory(targetPath: string, directory: string): boolean {
  const relative = path.relative(directory, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function classifyCloseoutPreflightFailure(
  assessment: CloseoutAssessment,
): CloseoutPreflightFailureClass {
  if (assessment.status === "pass") {
    return "unknown";
  }
  const failedCodes = new Set(
    assessment.checks.filter((check) => !check.ok).map((check) => check.code),
  );
  if (
    failedCodes.has("git_repo_missing") ||
    failedCodes.has("git_head_missing") ||
    failedCodes.has("integration_ref_missing") ||
    failedCodes.has("integration_merge_base_missing")
  ) {
    return "operator_blocker";
  }
  if (failedCodes.has("dirty_repo")) {
    const repoRoot = assessment.context.resolvedRepoRoot;
    const workingDirectory = path.resolve(assessment.context.workingDirectory);
    if (!repoRoot) {
      return "unknown";
    }
    const allDirtyPathsInsideWorkingDirectory = assessment.git.dirtyPaths.every((dirtyPath) =>
      pathIsInsideDirectory(path.resolve(repoRoot, dirtyPath), workingDirectory),
    );
    return allDirtyPathsInsideWorkingDirectory ? "worker_fixable" : "ambient_repo_state";
  }
  if (failedCodes.has("open_worktree")) {
    const repoRoot = assessment.context.resolvedRepoRoot;
    const workingDirectory = path.resolve(assessment.context.workingDirectory);
    const extraWorktreePaths = assessment.git.worktreePaths.filter(
      (worktreePath) => path.resolve(worktreePath) !== repoRoot,
    );
    if (
      extraWorktreePaths.some((worktreePath) => path.resolve(worktreePath) === workingDirectory)
    ) {
      return "operator_blocker";
    }
    return extraWorktreePaths.length > 0 ? "ambient_repo_state" : "unknown";
  }
  if (failedCodes.has("not_integrated")) {
    return "worker_fixable";
  }
  return "unknown";
}

function buildCloseoutPreflight(assessment: CloseoutAssessment): CloseoutPreflight {
  const repoClean = closeoutCheckValue(assessment, "dirty_repo");
  const noOpenLinkedWorktrees = closeoutCheckValue(assessment, "open_worktree");
  const headIntegratedIntoBase = closeoutCheckValue(assessment, "not_integrated");
  const failureClass = classifyCloseoutPreflightFailure(assessment);
  const failedCodes = new Set(
    assessment.checks.filter((check) => !check.ok).map((check) => check.code),
  );
  const status =
    assessment.status === "pass"
      ? "pass"
      : failedCodes.has("dirty_repo") ||
          failedCodes.has("open_worktree") ||
          failedCodes.has("not_integrated")
        ? "fail"
        : "unknown";
  const repoRoot = assessment.context.resolvedRepoRoot;
  const openWorktreePaths =
    assessment.context.closeoutMode === "linked_worktree_local" ||
    assessment.context.closeoutMode === "workflow_owned_worktree_local"
      ? []
      : assessment.git.worktreePaths.filter(
          (worktreePath) => path.resolve(worktreePath) !== repoRoot,
        );
  const failedCheckSummary =
    assessment.checks.find((check) => !check.ok)?.summary ?? assessment.reason;
  return {
    status,
    failureClass,
    summary: failedCheckSummary,
    reason: assessment.reason,
    mode: assessment.context.closeoutMode,
    repoRoot,
    workingDirectory: assessment.context.workingDirectory,
    requestedWorkingDirectory: assessment.context.requestedWorkingDirectory,
    baseRef: assessment.git.baseRef,
    head: assessment.git.head,
    checks: {
      repoClean,
      noOpenLinkedWorktrees,
      headIntegratedIntoBase,
    },
    dirtyPaths: assessment.git.dirtyPaths,
    openWorktreePaths,
    trace: assessment.trace,
  };
}

function buildWorkerFixableCloseoutInstruction(preflight: CloseoutPreflight): string[] {
  if (preflight.dirtyPaths.length > 0) {
    return [
      `Clean the repo/worktree before DONE. Resolve or revert these dirty paths and then report the exact remaining git status: ${preflight.dirtyPaths.join(", ")}.`,
    ];
  }
  if (preflight.checks.headIntegratedIntoBase === false) {
    const baseRef = preflight.baseRef ?? "the integration branch";
    return [
      `Integrate the current HEAD into ${baseRef} before DONE, then report the exact merge-base evidence showing HEAD is integrated.`,
    ];
  }
  return [
    `Resolve the closeout preflight failure before DONE and report concrete verification evidence: ${preflight.reason}`,
  ];
}

function buildCloseoutEscalationBlocker(preflight: CloseoutPreflight): string[] {
  if (preflight.openWorktreePaths.length > 0) {
    return [
      `Additional linked worktrees must be closed or handed off outside this worker run: ${preflight.openWorktreePaths.join(", ")}.`,
    ];
  }
  return [preflight.reason];
}

function remapInvalidDoneDecision(params: {
  decision: ControllerDecision;
  closeoutPreflight: CloseoutPreflight;
  closeoutAssessment: CloseoutAssessment;
}): {
  decision: ControllerDecision;
  enforcedCloseoutAssessment?: CloseoutAssessment;
} {
  const { decision, closeoutPreflight, closeoutAssessment } = params;
  if (decision.decision !== "DONE" || closeoutPreflight.status !== "fail") {
    return { decision };
  }

  const enforcedReason = `Controller DONE rejected because closeout preflight failed: ${closeoutPreflight.reason}`;
  if (closeoutPreflight.failureClass === "worker_fixable") {
    return {
      decision: {
        ...decision,
        decision: "CONTINUE",
        reason: uniqueLimited([enforcedReason, ...decision.reason], 3),
        nextInstruction: buildWorkerFixableCloseoutInstruction(closeoutPreflight),
        blocker: [],
      },
    };
  }

  return {
    decision: {
      ...decision,
      decision: "ESCALATE_BLOCKED",
      reason: uniqueLimited([enforcedReason, ...decision.reason], 3),
      nextInstruction: [],
      blocker: buildCloseoutEscalationBlocker(closeoutPreflight),
    },
    enforcedCloseoutAssessment: closeoutAssessment,
  };
}

function formatCloseoutPreflightCheckValue(value: CloseoutPreflightCheckValue): string {
  return value === "unknown" ? "unknown" : value ? "true" : "false";
}

function buildCloseoutPreflightPrompt(preflight: CloseoutPreflight): string {
  return [
    `mode=${preflight.mode}`,
    `status=${preflight.status}`,
    `failure_class=${preflight.failureClass}`,
    `summary=${preflight.summary}`,
    `repo_root=${preflight.repoRoot ?? "unresolved"}`,
    `working_directory=${preflight.workingDirectory}`,
    `requested_working_directory=${preflight.requestedWorkingDirectory}`,
    `base_ref=${preflight.baseRef ?? "unknown"}`,
    `head=${preflight.head ?? "unknown"}`,
    `repo_clean=${formatCloseoutPreflightCheckValue(preflight.checks.repoClean)}`,
    `no_open_linked_worktrees=${formatCloseoutPreflightCheckValue(preflight.checks.noOpenLinkedWorktrees)}`,
    `head_integrated_into_base=${formatCloseoutPreflightCheckValue(preflight.checks.headIntegratedIntoBase)}`,
    `dirty_paths=${preflight.dirtyPaths.length ? preflight.dirtyPaths.join(",") : "none"}`,
    `open_worktrees=${preflight.openWorktreePaths.length ? preflight.openWorktreePaths.join(",") : "none"}`,
    "trace:",
    ...uniqueLimited(preflight.trace, 6).map((line) => `- ${line}`),
  ].join("\n");
}

function buildControllerRunContractReminder(runContract: CodexControllerRunContract): string {
  return [
    `run_id=${runContract.runId}`,
    `working_directory=${runContract.input.workingDirectory}`,
    `requested_working_directory=${runContract.input.requestedWorkingDirectory}`,
    `working_directory_mode=${runContract.input.workingDirectoryMode}`,
    `workspace_ownership=${runContract.input.workspaceOwnership}`,
    `repo_root=${runContract.input.repoRoot}`,
    `closeout_context_source=${runContract.input.closeoutContextSource}`,
    ...(runContract.input.workflowOwnedWorktree
      ? [`workflow_owned_worktree_root=${runContract.input.workflowOwnedWorktree.rootPath}`]
      : []),
    `round_budget=${runContract.input.maxRetries}`,
    ...(runContract.contextWorkspaceDir
      ? [`context_workspace_dir=${runContract.contextWorkspaceDir}`]
      : []),
    `normalized_decision_block=MODULE_DECISION|MODULE_REASON|NEXT_INSTRUCTION|BLOCKER`,
    `original_task=${truncateText(runContract.input.task, 240)}`,
    `success_criteria=${runContract.input.successCriteria.length ? runContract.input.successCriteria.join(" | ") : "none"}`,
    `constraints=${runContract.input.constraints.length ? runContract.input.constraints.join(" | ") : "none"}`,
  ].join("\n");
}

function buildControllerDeltaPrompt(params: {
  runContract: CodexControllerRunContract;
  round: number;
  maxRounds: number;
  workerOutput: string;
  recentWorkerHistory: WorkerRoundSummary[];
  controllerHistory: ControllerRoundSummary[];
  currentWorkerSummary: WorkerRoundSummary;
  drift: DriftAssessment;
  closeoutPreflight: CloseoutPreflight;
}): string {
  return [
    `ROUND_CONTEXT: ${params.round}/${params.maxRounds}`,
    "Use the stable controller policy and the persisted run contract below as the source of truth for this run.",
    "Evaluate only the bounded dynamic context below.",
    "",
    "RUN_CONTRACT:",
    buildControllerRunContractReminder(params.runContract),
    "",
    "RECENT_VISIBLE_WORKER_HISTORY:",
    formatWorkerHistory(params.recentWorkerHistory),
    "",
    "CONTROLLER_HISTORY:",
    formatControllerHistory(params.controllerHistory),
    "",
    "CURRENT_WORKER_STATUS_HINTS:",
    buildStatusHints(params.currentWorkerSummary, params.drift),
    "",
    "CLOSEOUT_PREFLIGHT:",
    buildCloseoutPreflightPrompt(params.closeoutPreflight),
    "",
    "CURRENT_PROGRESS_EVIDENCE:",
    buildProgressEvidence(params.currentWorkerSummary),
    "",
    "CURRENT_DRIFT_SIGNALS:",
    buildDriftSignals(params.drift),
    "",
    "WORKER_OUTPUT:",
    params.workerOutput,
  ].join("\n");
}

function buildWorkflowStartedMessage(input: NormalizedCodexControllerInput): string {
  return [
    `Task: ${input.task}`,
    `Round budget: ${input.maxRetries}`,
    `Worker cwd: ${input.workingDirectory}`,
    `Requested working directory: ${input.requestedWorkingDirectory}`,
    `Working directory mode: ${input.workingDirectoryMode}`,
    `Workspace ownership: ${input.workspaceOwnership}`,
    `Closeout repo root: ${input.repoRoot} (${input.closeoutContextSource})`,
    ...(input.workflowOwnedWorktree
      ? [`Workflow-owned worktree root: ${input.workflowOwnedWorktree.rootPath}`]
      : []),
    ...(input.workerModel ? [`Worker model: ${input.workerModel}`] : []),
    ...(input.workerReasoningEffort
      ? [`Worker reasoning effort: ${input.workerReasoningEffort}`]
      : []),
    ...(input.agentId ? [`Context workspace agent: ${input.agentId}`] : []),
    ...(input.successCriteria.length
      ? [`Success criteria: ${input.successCriteria.join("; ")}`]
      : []),
    ...(input.constraints.length ? [`Constraints: ${input.constraints.join("; ")}`] : []),
  ].join("\n");
}

function runGitReadOnly(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function parseGitStatusPorcelain(raw: string | null): string[] {
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

function parseGitWorktreePaths(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

function parseRefList(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function chooseIntegrationBaseRef(refs: string[]): string | null {
  const available = new Set(refs);
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (available.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function detectCloseoutMode(
  context: CloseoutContext,
  resolvedRepoRoot: string,
): {
  mode: CloseoutMode;
  absoluteGitDir: string | null;
  commonGitDir: string | null;
} {
  const absoluteGitDir = runGitReadOnly(resolvedRepoRoot, ["rev-parse", "--absolute-git-dir"]);
  const commonGitDirRaw =
    runGitReadOnly(resolvedRepoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ??
    runGitReadOnly(resolvedRepoRoot, ["rev-parse", "--git-common-dir"]);
  const commonGitDir = commonGitDirRaw ? path.resolve(resolvedRepoRoot, commonGitDirRaw) : null;
  if (context.workspaceOwnership === "workflow_owned" && context.workflowOwnedWorktree) {
    return {
      mode: "workflow_owned_worktree_local",
      absoluteGitDir: absoluteGitDir ? path.resolve(absoluteGitDir) : null,
      commonGitDir,
    };
  }
  const mode =
    context.closeoutContextSource === "workingDirectory" &&
    absoluteGitDir &&
    commonGitDir &&
    path.resolve(absoluteGitDir) !== commonGitDir
      ? "linked_worktree_local"
      : "repo_integrated";
  return {
    mode,
    absoluteGitDir: absoluteGitDir ? path.resolve(absoluteGitDir) : null,
    commonGitDir,
  };
}

function buildAssessmentContext(params: {
  context: CloseoutContext;
  requestedRepoRoot: string;
  closeoutMode: CloseoutMode;
  resolvedRepoRoot: string | null;
}) {
  return {
    workingDirectory: params.context.workingDirectory,
    requestedWorkingDirectory: params.context.requestedWorkingDirectory,
    requestedRepoRoot: params.requestedRepoRoot,
    workingDirectoryMode: params.context.workingDirectoryMode,
    workspaceOwnership: params.context.workspaceOwnership,
    workflowOwnedWorktreeRoot: params.context.workflowOwnedWorktree?.rootPath ?? null,
    closeoutContextSource: params.context.closeoutContextSource,
    closeoutMode: params.closeoutMode,
    resolvedRepoRoot: params.resolvedRepoRoot,
  } satisfies CloseoutAssessment["context"];
}

function assessCloseout(context: CloseoutContext): CloseoutAssessment {
  const requestedRepoRoot = context.repoRoot;
  const preferWorkingDirectoryRoot = context.workspaceOwnership === "workflow_owned";
  const directRequestedRepoRoot = preferWorkingDirectoryRoot
    ? null
    : runGitReadOnly(requestedRepoRoot, ["rev-parse", "--show-toplevel"]);
  const directWorkingDirectoryRoot =
    directRequestedRepoRoot === null
      ? runGitReadOnly(context.workingDirectory, ["rev-parse", "--show-toplevel"])
      : null;
  const discoveredRepoRoot =
    directRequestedRepoRoot || directWorkingDirectoryRoot
      ? null
      : (findGitRoot(requestedRepoRoot) ?? findGitRoot(context.workingDirectory));
  const resolvedRepoRootCandidate =
    directRequestedRepoRoot ??
    directWorkingDirectoryRoot ??
    (discoveredRepoRoot
      ? (runGitReadOnly(discoveredRepoRoot, ["rev-parse", "--show-toplevel"]) ?? discoveredRepoRoot)
      : null);
  const resolvedRepoRoot = resolvedRepoRootCandidate
    ? path.resolve(resolvedRepoRootCandidate)
    : null;
  const trace: string[] = [
    `closeout_context=${context.closeoutContextSource}`,
    `working_directory_mode=${context.workingDirectoryMode}`,
    `workspace_ownership=${context.workspaceOwnership}`,
    `requested_repo_root=${requestedRepoRoot}`,
    `requested_working_directory=${context.requestedWorkingDirectory}`,
    `working_directory=${context.workingDirectory}`,
    ...(context.workflowOwnedWorktree
      ? [
          `workflow_owned_worktree_root=${context.workflowOwnedWorktree.rootPath}`,
          `workflow_owned_worktree_source_repo_root=${context.workflowOwnedWorktree.sourceRepoRoot}`,
        ]
      : []),
    `resolved_repo_root=${resolvedRepoRoot ?? "unresolved"}`,
  ];
  const checks: CloseoutCheck[] = [];

  if (!resolvedRepoRoot) {
    checks.push({
      code: "git_repo_missing",
      ok: false,
      summary: "Closeout could not resolve a readable git repo root.",
    });
    trace.push("git_repo=missing");
    return {
      status: "blocked",
      reason:
        "Closeout blocked: git repo root could not be resolved from repoRoot/workingDirectory.",
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode: "repo_integrated",
        resolvedRepoRoot: null,
      }),
      git: {
        head: null,
        baseRef: null,
        mergeBase: null,
        dirtyPaths: [],
        worktreePaths: [],
      },
      checks,
    };
  }

  const {
    mode: closeoutMode,
    absoluteGitDir,
    commonGitDir,
  } = detectCloseoutMode(context, resolvedRepoRoot);
  trace.push(`closeout_mode=${closeoutMode}`);
  if (absoluteGitDir) {
    trace.push(`git_dir=${absoluteGitDir}`);
  }
  if (commonGitDir) {
    trace.push(`git_common_dir=${commonGitDir}`);
  }

  const head = runGitReadOnly(resolvedRepoRoot, ["rev-parse", "HEAD"]);
  if (!head) {
    checks.push({
      code: "git_head_missing",
      ok: false,
      summary: "Closeout could not read HEAD.",
    });
    trace.push("git_head=missing");
    return {
      status: "blocked",
      reason: "Closeout blocked: git HEAD could not be resolved.",
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode,
        resolvedRepoRoot,
      }),
      git: {
        head: null,
        baseRef: null,
        mergeBase: null,
        dirtyPaths: [],
        worktreePaths: [],
      },
      checks,
    };
  }

  trace.push(`head=${head}`);
  const dirtyPaths = parseGitStatusPorcelain(
    runGitReadOnly(resolvedRepoRoot, ["status", "--porcelain=1"]),
  );
  if (dirtyPaths.length > 0) {
    checks.push({
      code: "dirty_repo",
      ok: false,
      summary: "Closeout requires a clean repo/worktree.",
      detail: dirtyPaths.join(", "),
    });
    trace.push(`dirty_paths=${dirtyPaths.join(",")}`);
    return {
      status: "blocked",
      reason: `Closeout blocked: repo/worktree is dirty (${dirtyPaths.join(", ")}).`,
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode,
        resolvedRepoRoot,
      }),
      git: {
        head,
        baseRef: null,
        mergeBase: null,
        dirtyPaths,
        worktreePaths: [],
      },
      checks,
    };
  }
  checks.push({
    code: "dirty_repo",
    ok: true,
    summary: "Repo/worktree is clean.",
  });

  const worktreePaths = parseGitWorktreePaths(
    runGitReadOnly(resolvedRepoRoot, ["worktree", "list", "--porcelain"]),
  );
  trace.push(`worktree_count=${worktreePaths.length}`);
  if (
    closeoutMode === "linked_worktree_local" ||
    closeoutMode === "workflow_owned_worktree_local"
  ) {
    checks.push({
      code: "open_worktree",
      ok: true,
      summary:
        closeoutMode === "workflow_owned_worktree_local"
          ? "Workflow-owned linked worktree closeout allows sibling worktrees."
          : "Linked worktree closeout allows sibling worktrees when repoRoot is omitted.",
    });
    checks.push({
      code: "not_integrated",
      ok: true,
      summary:
        closeoutMode === "workflow_owned_worktree_local"
          ? "Workflow-owned linked worktree closeout does not require shared-repo integration."
          : "Linked worktree closeout does not require self-integration into mainline.",
    });
    trace.push(
      closeoutMode === "workflow_owned_worktree_local"
        ? `workflow_owned_worktree_closeout=current_worktree_only${worktreePaths.length ? `:${worktreePaths.join(",")}` : ""}`
        : `linked_worktree_closeout=current_worktree_only${worktreePaths.length ? `:${worktreePaths.join(",")}` : ""}`,
    );
    trace.push("closeout=pass");
    return {
      status: "pass",
      reason:
        closeoutMode === "workflow_owned_worktree_local"
          ? "Closeout passed: workflow-owned linked worktree is clean; shared-repo integration and sibling worktrees are outside this run."
          : "Closeout passed: linked worktree is clean; sibling worktrees and mainline integration are deferred until an explicit repoRoot closeout.",
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode,
        resolvedRepoRoot,
      }),
      git: {
        head,
        baseRef: null,
        mergeBase: null,
        dirtyPaths,
        worktreePaths,
      },
      checks,
    };
  }

  if (worktreePaths.length > 1) {
    checks.push({
      code: "open_worktree",
      ok: false,
      summary: "Closeout requires no additional linked worktrees.",
      detail: worktreePaths.join(", "),
    });
    trace.push(`open_worktrees=${worktreePaths.join(",")}`);
    return {
      status: "blocked",
      reason: `Closeout blocked: open linked worktrees detected (${worktreePaths.join(", ")}).`,
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode,
        resolvedRepoRoot,
      }),
      git: {
        head,
        baseRef: null,
        mergeBase: null,
        dirtyPaths,
        worktreePaths,
      },
      checks,
    };
  }
  checks.push({
    code: "open_worktree",
    ok: true,
    summary: "No additional linked worktrees detected.",
  });

  const baseRef = chooseIntegrationBaseRef(
    parseRefList(
      runGitReadOnly(resolvedRepoRoot, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ]),
    ),
  );
  if (!baseRef) {
    checks.push({
      code: "integration_ref_missing",
      ok: false,
      summary: "Closeout could not find a known integration ref.",
    });
    trace.push("integration_ref=missing");
    return {
      status: "blocked",
      reason:
        "Closeout blocked: integration ref (origin/main|origin/master|main|master) is missing.",
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode,
        resolvedRepoRoot,
      }),
      git: {
        head,
        baseRef: null,
        mergeBase: null,
        dirtyPaths,
        worktreePaths,
      },
      checks,
    };
  }

  const mergeBase = runGitReadOnly(resolvedRepoRoot, ["merge-base", "HEAD", baseRef]);
  if (!mergeBase) {
    checks.push({
      code: "integration_merge_base_missing",
      ok: false,
      summary: `Closeout could not compute merge-base against ${baseRef}.`,
    });
    trace.push(`integration_ref=${baseRef}`);
    trace.push("merge_base=missing");
    return {
      status: "blocked",
      reason: `Closeout blocked: merge-base against ${baseRef} could not be resolved.`,
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode,
        resolvedRepoRoot,
      }),
      git: {
        head,
        baseRef,
        mergeBase: null,
        dirtyPaths,
        worktreePaths,
      },
      checks,
    };
  }

  trace.push(`integration_ref=${baseRef}`);
  trace.push(`merge_base=${mergeBase}`);
  if (mergeBase !== head) {
    checks.push({
      code: "not_integrated",
      ok: false,
      summary: `HEAD is not integrated into ${baseRef}.`,
      detail: `head=${head} mergeBase=${mergeBase}`,
    });
    return {
      status: "blocked",
      reason: `Closeout blocked: HEAD ${head} is not integrated into ${baseRef} (merge-base ${mergeBase}).`,
      trace,
      context: buildAssessmentContext({
        context,
        requestedRepoRoot,
        closeoutMode,
        resolvedRepoRoot,
      }),
      git: {
        head,
        baseRef,
        mergeBase,
        dirtyPaths,
        worktreePaths,
      },
      checks,
    };
  }

  checks.push({
    code: "not_integrated",
    ok: true,
    summary: `HEAD is integrated into ${baseRef}.`,
  });
  trace.push("closeout=pass");
  return {
    status: "pass",
    reason: `Closeout passed: repo clean, no extra worktrees, HEAD integrated into ${baseRef}.`,
    trace,
    context: buildAssessmentContext({
      context,
      requestedRepoRoot,
      closeoutMode,
      resolvedRepoRoot,
    }),
    git: {
      head,
      baseRef,
      mergeBase,
      dirtyPaths,
      worktreePaths,
    },
    checks,
  };
}

function buildCloseoutArtifact(assessment: CloseoutAssessment): string {
  return `${JSON.stringify(assessment, null, 2)}\n`;
}

function cleanupWorkflowOwnedWorkspace(input: NormalizedCodexControllerInput): WorkspaceCleanupResult {
  if (input.workspaceOwnership !== "workflow_owned" || !input.workflowOwnedWorktree) {
    return {
      status: "not_applicable",
      reason: "No workflow-owned workspace cleanup was required.",
      trace: [],
    };
  }
  const managedRoot = path.resolve(workflowOwnedWorktreesDir());
  const worktreeRoot = path.resolve(input.workflowOwnedWorktree.rootPath);
  const sourceRepoRoot = path.resolve(input.workflowOwnedWorktree.sourceRepoRoot);
  if (!pathIsInsideDirectory(worktreeRoot, managedRoot)) {
    return {
      status: "blocked",
      reason: `Refusing to remove non-managed worktree path: ${worktreeRoot}.`,
      trace: [`managed_root=${managedRoot}`, `worktree_root=${worktreeRoot}`],
    };
  }
  const removeResult = runGitCommand(sourceRepoRoot, ["worktree", "remove", "--force", worktreeRoot]);
  const trace = [
    `managed_root=${managedRoot}`,
    `worktree_root=${worktreeRoot}`,
    `source_repo_root=${sourceRepoRoot}`,
  ];
  if (!removeResult.ok) {
    const remainingPaths = parseGitWorktreePaths(
      runGitReadOnly(sourceRepoRoot, ["worktree", "list", "--porcelain"]),
    ).map((entry) => path.resolve(entry));
    if (!remainingPaths.includes(worktreeRoot)) {
      runGitCommand(sourceRepoRoot, ["worktree", "prune"]);
      return {
        status: "passed",
        reason: `Workflow-owned worktree was already absent from git metadata: ${worktreeRoot}.`,
        trace: [...trace, "cleanup=already_absent"],
      };
    }
    return {
      status: "blocked",
      reason: `Failed to remove workflow-owned worktree ${worktreeRoot}: ${removeResult.message}`,
      trace: [...trace, `cleanup_error=${removeResult.message}`],
    };
  }
  const pruneResult = runGitCommand(sourceRepoRoot, ["worktree", "prune"]);
  return {
    status: "passed",
    reason:
      pruneResult.ok
        ? `Workflow-owned worktree removed: ${worktreeRoot}.`
        : `Workflow-owned worktree removed but prune reported: ${pruneResult.message}`,
    trace: [
      ...trace,
      "cleanup=removed",
      ...(pruneResult.ok ? ["prune=ok"] : [`prune_error=${pruneResult.message}`]),
    ],
  };
}

function buildRunSummary(params: {
  status: WorkflowRunRecord["status"];
  round: number;
  reason: string;
  workerSession: string;
  controllerSession: string | undefined;
  closeout?: CloseoutAssessment;
  workspaceCleanup?: WorkspaceCleanupResult;
}): string {
  return (
    [
      `status: ${params.status}`,
      `round: ${params.round}`,
      `reason: ${params.reason}`,
      `worker-session: ${params.workerSession}`,
      `controller-session: ${params.controllerSession ?? "n/a"}`,
      `closeout-mode: ${params.closeout?.context.closeoutMode ?? "not_run"}`,
      `closeout-status: ${params.closeout?.status ?? "not_run"}`,
      `closeout-reason: ${params.closeout?.reason ?? "not_run"}`,
      `closeout-repo-root: ${params.closeout?.context.resolvedRepoRoot ?? "n/a"}`,
      `closeout-working-directory: ${params.closeout?.context.workingDirectory ?? "n/a"}`,
      `closeout-requested-working-directory: ${params.closeout?.context.requestedWorkingDirectory ?? "n/a"}`,
      `closeout-working-directory-mode: ${params.closeout?.context.workingDirectoryMode ?? "n/a"}`,
      `closeout-workspace-ownership: ${params.closeout?.context.workspaceOwnership ?? "n/a"}`,
      `closeout-head: ${params.closeout?.git.head ?? "n/a"}`,
      `closeout-base-ref: ${params.closeout?.git.baseRef ?? "n/a"}`,
      `closeout-trace: ${(params.closeout?.trace ?? ["not_run"]).join(" | ")}`,
      `workspace-cleanup-status: ${params.workspaceCleanup?.status ?? "not_run"}`,
      `workspace-cleanup-reason: ${params.workspaceCleanup?.reason ?? "not_run"}`,
      `workspace-cleanup-trace: ${(params.workspaceCleanup?.trace ?? ["not_run"]).join(" | ")}`,
    ].join("\n") + "\n"
  );
}

function buildControllerTerminalMessage(params: {
  decision: ControllerDecision;
  round: number;
  maxRounds: number;
  blocked?: boolean;
}): string {
  const lines = [
    params.blocked ? "Controller reported a blocker." : "Controller approved completion.",
    `Round: ${params.round}/${params.maxRounds}`,
    ...(params.decision.reason.length
      ? ["", "Reason:", ...params.decision.reason.map((line) => `- ${line}`)]
      : []),
    ...(params.blocked && params.decision.blocker.length
      ? ["", "Blocker:", ...params.decision.blocker.map((line) => `- ${line}`)]
      : []),
  ];
  return lines.join("\n");
}

function buildControllerCompletionMessage(params: {
  finalResult: string;
  decision: ControllerDecision;
  round: number;
  maxRounds: number;
}): string {
  return [
    "Final result:",
    params.finalResult,
    "",
    "Controller approved completion.",
    `Round: ${params.round}/${params.maxRounds}`,
    ...(params.decision.reason.length
      ? ["", "Reason:", ...params.decision.reason.map((line) => `- ${line}`)]
      : []),
  ].join("\n");
}

function buildRecord(params: {
  runId: string;
  input: NormalizedCodexControllerInput;
  sessions: WorkflowRunRecord["sessions"];
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  currentRound: number;
  maxRounds: number;
  artifacts: string[];
  latestWorkerOutput: string | null;
  latestCriticVerdict: string | null;
  createdAt: string;
  updatedAt: string;
  currentTask: string | null;
  origin?: WorkflowRunRecord["origin"];
  reporting?: WorkflowRunRecord["reporting"];
}): WorkflowRunRecord {
  return {
    runId: params.runId,
    moduleId: "codex_controller",
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
    originalTask: params.input.task,
    currentTask: params.currentTask,
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.reporting ? { reporting: params.reporting } : {}),
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

function stepIdForRound(round: number): string {
  return `round-${round}`;
}

function resolveContextWorkspaceDir(
  input: NormalizedCodexControllerInput,
  cfg: ReturnType<typeof loadConfig>,
): string | undefined {
  if (!input.agentId) {
    return undefined;
  }
  return resolveAgentWorkspaceDir(cfg, input.agentId);
}

function buildPendingCodexWorkerSessionLabel(runId: string): string {
  return `codex-thread:pending:${runId}`;
}

function buildCodexWorkerSessionLabel(threadId: string): string {
  return `codex-thread:${threadId}`;
}

function classifyCodexWorkerRetry(error: unknown): CodexWorkerRetryClassification {
  const message = error instanceof Error ? error.message.trim() : String(error);
  const errorCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const transportTransition = isCodexWorkerTransportTransitionMessage(message);
  const timeoutLike = !transportTransition && /\btimed out after \d+ms\b/i.test(message);
  const transientPromptFailure =
    !timeoutLike &&
    !transportTransition &&
    !NON_RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE.some((pattern) => pattern.test(message)) &&
    RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE.some((pattern) => pattern.test(message));
  return {
    retryable: timeoutLike || transportTransition || transientPromptFailure,
    reason: timeoutLike
      ? "timeout"
      : transportTransition
        ? "transport_transition"
        : transientPromptFailure
          ? "transient_prompt_failure"
          : "non_retryable",
    errorCode,
    message,
  };
}

function buildCodexWorkerRetryMessage(params: {
  phase:
    | "worker_retry_scheduled"
    | "worker_retry_started"
    | "worker_retry_succeeded"
    | "worker_retry_exhausted";
  round: number;
  maxRounds: number;
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  errorMessage?: string;
  errorCode?: string;
  retryReason?: CodexWorkerRetryClassification["reason"];
  cleanupNotice?: string;
}): string {
  const headline =
    params.phase === "worker_retry_scheduled"
      ? "Worker retry scheduled."
      : params.phase === "worker_retry_started"
        ? "Worker retry started."
        : params.phase === "worker_retry_succeeded"
          ? "Worker retry succeeded."
          : "Worker retry exhausted.";
  const reasonLabel =
    params.retryReason === "timeout"
      ? "retryable Codex worker turn timeout"
      : params.retryReason === "transport_transition"
        ? "worker transport transition to HTTPS fallback"
        : params.retryReason === "transient_prompt_failure"
          ? "retryable transient Codex worker turn failure"
          : undefined;
  const lines = [
    headline,
    `Round: ${params.round}/${params.maxRounds}`,
    `Attempt: ${params.attempt}/${params.maxAttempts}`,
    `Worker hard timeout: ${CODEX_WORKER_HARD_TURN_TIMEOUT_SECONDS}s`,
    `Worker idle timeout: ${CODEX_WORKER_IDLE_TIMEOUT_SECONDS}s`,
    ...(typeof params.delayMs === "number" ? [`Retry delay: ${params.delayMs}ms`] : []),
    ...(reasonLabel ? [`Reason: ${reasonLabel}`] : []),
    ...(params.errorCode ? [`Worker error code: ${params.errorCode}`] : []),
    ...(params.errorMessage ? [`Error: ${params.errorMessage}`] : []),
    ...(params.cleanupNotice ? [`Cleanup: ${params.cleanupNotice}`] : []),
  ];
  return lines.join("\n");
}

async function emitCodexWorkerRetryEvent(params: {
  trace: WorkflowModuleContext["trace"];
  stepId: string;
  moduleId: string;
  runId: string;
  round: number;
  maxRounds: number;
  sessionKey: string;
  agentId: string;
  phase:
    | "worker_retry_scheduled"
    | "worker_retry_started"
    | "worker_retry_succeeded"
    | "worker_retry_exhausted";
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  errorMessage?: string;
  errorCode?: string;
  retryReason?: CodexWorkerRetryClassification["reason"];
  cleanupNotice?: string;
  origin?: WorkflowStartRequest["origin"];
  reporting?: WorkflowStartRequest["reporting"];
}): Promise<void> {
  const messageText = buildCodexWorkerRetryMessage(params);
  params.trace.emit({
    kind: params.phase === "worker_retry_exhausted" ? "warning" : "custom",
    stepId: params.stepId,
    round: params.round,
    role: "worker",
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    status: params.phase === "worker_retry_exhausted" ? "failed" : "running",
    summary: messageText.split("\n", 1)[0],
    payload: {
      phase: params.phase,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
      delayMs: params.delayMs,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      retryReason: params.retryReason,
      workerPromptTimeoutSeconds: CODEX_WORKER_HARD_TURN_TIMEOUT_SECONDS,
      workerIdleTimeoutSeconds: CODEX_WORKER_IDLE_TIMEOUT_SECONDS,
      cleanupNotice: params.cleanupNotice,
    },
  });
  await emitTracedWorkflowReportEvent({
    trace: params.trace,
    stepId: params.stepId,
    moduleId: params.moduleId,
    runId: params.runId,
    phase: params.phase,
    eventType: "milestone",
    messageText,
    emittingAgentId: params.agentId,
    origin: params.origin,
    reporting: params.reporting,
    status: params.phase === "worker_retry_exhausted" ? "failed" : "running",
    role: "worker",
    round: params.round,
    targetSessionKey: params.sessionKey,
    traceSummary: messageText.split("\n", 1)[0],
  });
}

async function runCodexTurnWithRetry(params: {
  workerRuntime: CodexWorkerRuntime;
  workerSessionLabel: string;
  agentId: string;
  text: string;
  abortSignal?: AbortSignal;
  trace: WorkflowModuleContext["trace"];
  runId: string;
  stepId: string;
  round: number;
  maxRounds: number;
  origin?: WorkflowStartRequest["origin"];
  reporting?: WorkflowStartRequest["reporting"];
}): Promise<CodexWorkerTurnResult> {
  const maxAttempts = CODEX_WORKER_RETRY_DELAYS_MS.length + 1;
  let lastRetryReason: CodexWorkerRetryClassification["reason"] | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfWorkflowAbortRequested(params.abortSignal);
    try {
      const result = await params.workerRuntime.runTurn({
        text: params.text,
        hardTimeoutSeconds: CODEX_WORKER_HARD_TURN_TIMEOUT_SECONDS,
        idleTimeoutSeconds: CODEX_WORKER_IDLE_TIMEOUT_SECONDS,
        abortSignal: params.abortSignal,
      });
      if (attempt > 1) {
        await emitCodexWorkerRetryEvent({
          trace: params.trace,
          stepId: params.stepId,
          moduleId: "codex_controller",
          runId: params.runId,
          round: params.round,
          maxRounds: params.maxRounds,
          sessionKey: buildCodexWorkerSessionLabel(result.threadId),
          agentId: params.agentId,
          phase: "worker_retry_succeeded",
          attempt,
          maxAttempts,
          retryReason: lastRetryReason,
          origin: params.origin,
          reporting: params.reporting,
        });
      }
      return result;
    } catch (error) {
      if (isWorkflowAbortError(error) || params.abortSignal?.aborted) {
        throw createWorkflowAbortError(params.abortSignal?.reason ?? error);
      }
      const classification = classifyCodexWorkerRetry(error);
      lastRetryReason = classification.reason;
      const delayMs =
        classification.reason === "transport_transition"
          ? CODEX_WORKER_TRANSPORT_TRANSITION_RETRY_DELAY_MS
          : CODEX_WORKER_RETRY_DELAYS_MS[attempt - 1];
      if (!classification.retryable || delayMs === undefined) {
        if (classification.retryable) {
          await emitCodexWorkerRetryEvent({
            trace: params.trace,
            stepId: params.stepId,
            moduleId: "codex_controller",
            runId: params.runId,
            round: params.round,
            maxRounds: params.maxRounds,
            sessionKey: params.workerRuntime.getThreadId()
              ? buildCodexWorkerSessionLabel(params.workerRuntime.getThreadId()!)
              : params.workerSessionLabel,
            agentId: params.agentId,
            phase: "worker_retry_exhausted",
            attempt,
            maxAttempts,
            errorMessage: classification.message,
            errorCode: classification.errorCode,
            retryReason: classification.reason,
            origin: params.origin,
            reporting: params.reporting,
          });
          throw new Error(
            `${classification.message} (worker retry exhausted after ${attempt} attempts).`,
            { cause: error },
          );
        }
        throw error;
      }
      await emitCodexWorkerRetryEvent({
        trace: params.trace,
        stepId: params.stepId,
        moduleId: "codex_controller",
        runId: params.runId,
        round: params.round,
        maxRounds: params.maxRounds,
        sessionKey: params.workerRuntime.getThreadId()
          ? buildCodexWorkerSessionLabel(params.workerRuntime.getThreadId()!)
          : params.workerSessionLabel,
        agentId: params.agentId,
        phase: "worker_retry_scheduled",
        attempt,
        maxAttempts,
        delayMs,
        errorMessage: classification.message,
        errorCode: classification.errorCode,
        retryReason: classification.reason,
        origin: params.origin,
        reporting: params.reporting,
      });
      const cleanupNotice = params.workerRuntime.prepareForRetry();
      await Promise.race([
        sleep(delayMs),
        new Promise<never>((_, reject) => {
          const onAbort = () => {
            params.abortSignal?.removeEventListener("abort", onAbort);
            reject(createWorkflowAbortError(params.abortSignal?.reason ?? error));
          };
          params.abortSignal?.addEventListener("abort", onAbort, { once: true });
          if (params.abortSignal?.aborted) {
            onAbort();
          }
        }),
      ]);
      await emitCodexWorkerRetryEvent({
        trace: params.trace,
        stepId: params.stepId,
        moduleId: "codex_controller",
        runId: params.runId,
        round: params.round,
        maxRounds: params.maxRounds,
        sessionKey: params.workerRuntime.getThreadId()
          ? buildCodexWorkerSessionLabel(params.workerRuntime.getThreadId()!)
          : params.workerSessionLabel,
        agentId: params.agentId,
        phase: "worker_retry_started",
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        retryReason: classification.reason,
        cleanupNotice,
        origin: params.origin,
        reporting: params.reporting,
      });
    }
  }
  throw new Error("Codex worker retry loop terminated unexpectedly.");
}

async function maybeCompactCodexSession(params: {
  workerRuntime: CodexWorkerRuntime;
  workerCompactionMode: WorkerCompactionMode;
  workerCompactionAfterRound: number;
  round: number;
  abortSignal?: AbortSignal;
}): Promise<CodexWorkerCompactionResult | null> {
  if (params.workerCompactionMode === "off") {
    return null;
  }
  if (params.round < params.workerCompactionAfterRound) {
    return null;
  }
  return params.workerRuntime.compactThread({
    abortSignal: params.abortSignal,
  });
}

export const codexControllerWorkflowModule: WorkflowModule = {
  manifest: codexControllerWorkflowModuleManifest,
  async start(request, ctx: WorkflowModuleContext) {
    ctx.throwIfAbortRequested?.();
    const createdAt = ctx.nowIso();
    const requestedInput = normalizeRequestedInput(request);
    const persistedRunContract = loadPersistedRunContract(ctx.runId);
    const resolvedInput =
      persistedRunContract?.input ??
      resolveExecutionWorkspace({
        runId: ctx.runId,
        requestedInput,
      });
    const runContract =
      persistedRunContract ??
      buildRunContract({
        runId: ctx.runId,
        createdAt,
        input: resolvedInput,
        controllerPrompt: loadControllerPrompt(requestedInput.controllerPromptPath),
        contextWorkspaceDir: resolveContextWorkspaceDir(resolvedInput, loadConfig()),
      });
    const input = runContract.input;
    const contextWorkspaceDir = runContract.contextWorkspaceDir;
    const runContractArtifact =
      persistedRunContract === null
        ? writeWorkflowArtifact(
            ctx.runId,
            CODEX_CONTROLLER_RUN_CONTRACT_ARTIFACT,
            serializeRunContract(runContract),
          )
        : workflowArtifactPath(ctx.runId, CODEX_CONTROLLER_RUN_CONTRACT_ARTIFACT);
    const sessions = await ensureWorkflowSessions({
      runId: ctx.runId,
      specs: [
        {
          role: "orchestrator",
          agentId: input.controllerAgentId,
          label: `Workflow ${ctx.runId} Controller`,
        },
      ],
    });
    ctx.throwIfAbortRequested?.();
    const workerRuntime = createCodexSdkWorkerRuntime({
      workingDirectory: input.workingDirectory,
      contextWorkspaceDir,
      model: input.workerModel,
      reasoningEffort: input.workerReasoningEffort,
      developerInstructions: runContract.workerDeveloperInstructions,
    });
    sessions.worker = buildPendingCodexWorkerSessionLabel(ctx.runId);
    sessions.extras = {
      ...sessions.extras,
      codexWorkerRuntime: "codex_sdk",
      codexWorkerSessionKind: "codex_sdk_thread",
      workingDirectory: input.workingDirectory,
      requestedWorkingDirectory: input.requestedWorkingDirectory,
      workingDirectoryMode: input.workingDirectoryMode,
      workspaceOwnership: input.workspaceOwnership,
      repoRoot: input.repoRoot,
      closeoutContextSource: input.closeoutContextSource,
      ...(input.workflowOwnedWorktree
        ? {
            workflowOwnedWorktreeRoot: input.workflowOwnedWorktree.rootPath,
            workflowOwnedWorktreeSourceRepoRoot: input.workflowOwnedWorktree.sourceRepoRoot,
          }
        : {}),
      ...(input.agentId ? { contextAgentId: input.agentId } : {}),
      ...(contextWorkspaceDir ? { contextWorkspaceDir } : {}),
      controllerPromptPath: input.controllerPromptPath,
      runContractArtifact,
      runContractVersion: String(runContract.version),
      workerInstructionMode: "developer_instructions",
      ...(input.workerModel ? { workerModel: input.workerModel } : {}),
      ...(input.workerReasoningEffort
        ? { workerReasoningEffort: input.workerReasoningEffort }
        : {}),
      workerCompactionMode: input.workerCompactionMode,
      workerCompactionAfterRound: String(input.workerCompactionAfterRound),
      workerPromptTimeoutSeconds: String(CODEX_WORKER_HARD_TURN_TIMEOUT_SECONDS),
      workerIdleTimeoutSeconds: String(CODEX_WORKER_IDLE_TIMEOUT_SECONDS),
      workerPromptRetryAttempts: String(CODEX_WORKER_RETRY_DELAYS_MS.length + 1),
    };

    let record = buildRecord({
      runId: ctx.runId,
      input,
      sessions,
      status: "running",
      terminalReason: null,
      currentRound: 0,
      maxRounds: input.maxRetries,
      artifacts: [runContractArtifact],
      latestWorkerOutput: null,
      latestCriticVerdict: null,
      createdAt,
      updatedAt: createdAt,
      currentTask: input.task,
      origin: request.origin,
      reporting: request.reporting,
    });
    ctx.persist(record);
    ctx.trace.emit({
      kind: "run_started",
      stepId: "run",
      status: "running",
      summary: "Codex/controller workflow started.",
      payload: {
        maxRounds: input.maxRetries,
        workingDirectory: input.workingDirectory,
        requestedWorkingDirectory: input.requestedWorkingDirectory,
        workingDirectoryMode: input.workingDirectoryMode,
        workspaceOwnership: input.workspaceOwnership,
        repoRoot: input.repoRoot,
        closeoutContextSource: input.closeoutContextSource,
        runContractArtifact,
        runContractSource: persistedRunContract ? "persisted" : "new",
        ...(input.workflowOwnedWorktree
          ? {
              workflowOwnedWorktreeRoot: input.workflowOwnedWorktree.rootPath,
              workflowOwnedWorktreeSourceRepoRoot: input.workflowOwnedWorktree.sourceRepoRoot,
            }
          : {}),
        ...(input.agentId ? { contextAgentId: input.agentId } : {}),
        ...(contextWorkspaceDir ? { contextWorkspaceDir } : {}),
        codexAgentId: input.codexAgentId,
        controllerAgentId: input.controllerAgentId,
        ...(input.workerModel ? { workerModel: input.workerModel } : {}),
        ...(input.workerReasoningEffort
          ? { workerReasoningEffort: input.workerReasoningEffort }
          : {}),
      },
    });
    ctx.trace.emit(
      persistedRunContract
        ? {
            kind: "custom",
            stepId: "run",
            summary: "Persisted codex_controller run contract rehydrated.",
            payload: {
              artifactPath: runContractArtifact,
            },
          }
        : {
            kind: "artifact_written",
            stepId: "run",
            artifactPath: runContractArtifact,
            summary: "codex_controller run contract written",
          },
    );
    await emitTracedWorkflowReportEvent({
      trace: ctx.trace,
      stepId: "run",
      moduleId: "codex_controller",
      runId: ctx.runId,
      phase: "run_started",
      eventType: "started",
      messageText: buildWorkflowStartedMessage(input),
      emittingAgentId: input.controllerAgentId,
      origin: request.origin,
      reporting: request.reporting,
      status: "running",
      role: "orchestrator",
      targetSessionKey: sessions.orchestrator,
    });
    ctx.throwIfAbortRequested?.();
    await runWorkflowAgentOnSession({
      sessionKey: sessions.orchestrator!,
      message: buildControllerInitPrompt({
        runContract,
      }),
      idempotencyKey: `${ctx.runId}:controller:init`,
      timeoutMs: 60 * 60 * 1000,
      ...(contextWorkspaceDir ? { workspaceDir: contextWorkspaceDir } : {}),
      abortSignal: ctx.abortSignal,
    });
    ctx.throwIfAbortRequested?.();

    let nextInstruction: string[] = [];
    const workerHistory: WorkerRoundSummary[] = [];
    const controllerHistory: ControllerRoundSummary[] = [];
    const emitArtifactWritten = (params: {
      artifactPath: string;
      summary: string;
      round?: number;
      role?: string;
    }) => {
      ctx.trace.emit({
        kind: "artifact_written",
        stepId: typeof params.round === "number" ? stepIdForRound(params.round) : "run",
        ...(typeof params.round === "number" ? { round: params.round } : {}),
        ...(params.role ? { role: params.role } : {}),
        artifactPath: params.artifactPath,
        summary: params.summary,
      });
    };

    for (let round = 1; round <= input.maxRetries; round += 1) {
      ctx.throwIfAbortRequested?.();
      const stepId = stepIdForRound(round);
      const currentWorkerSessionLabel =
        sessions.worker ?? buildPendingCodexWorkerSessionLabel(ctx.runId);
      ctx.trace.emit({
        kind: "round_started",
        stepId,
        round,
        status: "running",
        summary: `Round ${round} started.`,
      });
      if (round > 1) {
        const compacted = await maybeCompactCodexSession({
          workerRuntime,
          workerCompactionMode: input.workerCompactionMode,
          workerCompactionAfterRound: input.workerCompactionAfterRound,
          round,
          abortSignal: ctx.abortSignal,
        });
        if (compacted) {
          sessions.worker = buildCodexWorkerSessionLabel(compacted.threadId);
          sessions.extras = {
            ...sessions.extras,
            codexThreadId: compacted.threadId,
            ...(compacted.tracePath ? { codexTracePath: compacted.tracePath } : {}),
            lastCompactedBeforeRound: String(round),
          };
          ctx.trace.emit({
            kind: "custom",
            stepId,
            round,
            role: "worker",
            sessionKey: sessions.worker,
            agentId: input.codexAgentId,
            summary: "Codex thread compaction completed.",
            payload: {
              threadId: compacted.threadId,
              compactionTurnId: compacted.compactionTurnId,
              notificationSummaries: compacted.notificationSummaries,
              tracePath: compacted.tracePath,
            },
          });
        }
      }

      const codexPrompt = buildCodexPrompt({
        runContract,
        round,
        maxRounds: input.maxRetries,
        nextInstruction,
      });
      ctx.trace.emit({
        kind: "role_turn_started",
        stepId,
        round,
        role: "worker",
        sessionKey: currentWorkerSessionLabel,
        agentId: input.codexAgentId,
        summary: "codex worker turn started",
      });
      let codexResult: CodexWorkerTurnResult;
      try {
        codexResult = await runCodexTurnWithRetry({
          workerRuntime,
          workerSessionLabel: currentWorkerSessionLabel,
          agentId: input.codexAgentId,
          text: codexPrompt,
          abortSignal: ctx.abortSignal,
          trace: ctx.trace,
          runId: ctx.runId,
          stepId,
          round,
          maxRounds: input.maxRetries,
          origin: request.origin,
          reporting: request.reporting,
        });
      } catch (error) {
        if (isWorkflowAbortError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const failedWorkerSessionLabel = workerRuntime.getThreadId()
          ? buildCodexWorkerSessionLabel(workerRuntime.getThreadId()!)
          : currentWorkerSessionLabel;
        throw new Error(
          `Codex worker turn failed in round ${round}/${input.maxRetries} on session ${failedWorkerSessionLabel}: ${message}`,
          { cause: error },
        );
      }
      sessions.worker = buildCodexWorkerSessionLabel(codexResult.threadId);
      sessions.extras = {
        ...sessions.extras,
        codexThreadId: codexResult.threadId,
        ...(codexResult.tracePath ? { codexTracePath: codexResult.tracePath } : {}),
      };
      const workerArtifact = writeWorkflowArtifact(
        ctx.runId,
        `round-${round}-codex.txt`,
        `${codexResult.text}\n`,
      );
      emitArtifactWritten({
        artifactPath: workerArtifact,
        summary: "codex worker output written",
        round,
        role: "worker",
      });
      ctx.trace.emit({
        kind: "role_turn_completed",
        stepId,
        round,
        role: "worker",
        sessionKey: sessions.worker,
        agentId: input.codexAgentId,
        summary: "codex worker output captured",
        payload: {
          outputLength: codexResult.text.length,
          threadId: codexResult.threadId,
          usage: codexResult.usage,
          eventSummaries: codexResult.eventSummaries.slice(-12),
          tracePath: codexResult.tracePath,
        },
      });

      record = buildRecord({
        runId: record.runId,
        input,
        sessions,
        status: "running",
        terminalReason: null,
        currentRound: round,
        maxRounds: input.maxRetries,
        artifacts: [...record.artifacts, workerArtifact],
        latestWorkerOutput: codexResult.text,
        latestCriticVerdict: record.latestCriticVerdict,
        createdAt: record.createdAt,
        updatedAt: ctx.nowIso(),
        currentTask: round === 1 ? input.task : nextInstruction.join(" ").trim() || input.task,
        origin: request.origin,
        reporting: request.reporting,
      });
      ctx.persist(record);
      ctx.throwIfAbortRequested?.();

      const currentWorkerSummary = summarizeWorkerRound(round, codexResult.text);
      const recentWorkerHistory = [...workerHistory.slice(-2), currentWorkerSummary];
      const recentControllerHistory = controllerHistory.slice(-3);
      const drift = assessDrift({
        current: currentWorkerSummary,
        priorWorkers: workerHistory,
        priorControllers: controllerHistory,
      });
      const closeoutAssessment = assessCloseout({
        workingDirectory: input.workingDirectory,
        requestedWorkingDirectory: input.requestedWorkingDirectory,
        repoRoot: input.repoRoot,
        workingDirectoryMode: input.workingDirectoryMode,
        workspaceOwnership: input.workspaceOwnership,
        workflowOwnedWorktree: input.workflowOwnedWorktree,
        closeoutContextSource: input.closeoutContextSource,
      });
      const closeoutPreflight = buildCloseoutPreflight(closeoutAssessment);
      const controllerMessage = buildControllerDeltaPrompt({
        runContract,
        round,
        maxRounds: input.maxRetries,
        workerOutput: codexResult.text,
        recentWorkerHistory,
        controllerHistory: recentControllerHistory,
        currentWorkerSummary,
        drift,
        closeoutPreflight,
      });
      ctx.trace.emit({
        kind: "role_turn_started",
        stepId,
        round,
        role: "controller",
        sessionKey: sessions.orchestrator,
        agentId: input.controllerAgentId,
        summary: "controller turn started",
      });
      const controllerRun = await runWorkflowAgentOnSession({
        sessionKey: sessions.orchestrator!,
        message: controllerMessage,
        idempotencyKey: `${ctx.runId}:controller:${round}`,
        timeoutMs: 60 * 60 * 1000,
        ...(contextWorkspaceDir ? { workspaceDir: contextWorkspaceDir } : {}),
        abortSignal: ctx.abortSignal,
      });
      const controllerArtifact = writeWorkflowArtifact(
        ctx.runId,
        `round-${round}-controller.txt`,
        `${controllerRun.text}\n`,
      );
      emitArtifactWritten({
        artifactPath: controllerArtifact,
        summary: "controller output written",
        round,
        role: "controller",
      });
      ctx.trace.emit({
        kind: "role_turn_completed",
        stepId,
        round,
        role: "controller",
        sessionKey: sessions.orchestrator,
        agentId: input.controllerAgentId,
        summary: "controller decision captured",
        payload: {
          outputLength: controllerRun.text.length,
        },
      });
      const parsedDecision = parseControllerDecision(controllerRun.text);
      const { decision, enforcedCloseoutAssessment } = remapInvalidDoneDecision({
        decision: parsedDecision,
        closeoutPreflight,
        closeoutAssessment,
      });
      enforceContinueGuardrails({ round, decision, drift });
      workerHistory.push(currentWorkerSummary);
      controllerHistory.push(summarizeControllerRound(round, decision));

      record = buildRecord({
        runId: record.runId,
        input,
        sessions,
        status: "running",
        terminalReason: null,
        currentRound: round,
        maxRounds: input.maxRetries,
        artifacts: [...record.artifacts, controllerArtifact],
        latestWorkerOutput: codexResult.text,
        latestCriticVerdict: controllerRun.text,
        createdAt: record.createdAt,
        updatedAt: ctx.nowIso(),
        currentTask: decision.nextInstruction.join(" ").trim() || input.task,
        origin: request.origin,
        reporting: request.reporting,
      });
      ctx.persist(record);
      ctx.throwIfAbortRequested?.();

      if (decision.decision === "DONE") {
        const closeout = assessCloseout({
          workingDirectory: input.workingDirectory,
          requestedWorkingDirectory: input.requestedWorkingDirectory,
          repoRoot: input.repoRoot,
          workingDirectoryMode: input.workingDirectoryMode,
          workspaceOwnership: input.workspaceOwnership,
          workflowOwnedWorktree: input.workflowOwnedWorktree,
          closeoutContextSource: input.closeoutContextSource,
        });
        const closeoutArtifact = writeWorkflowArtifact(
          ctx.runId,
          "closeout-assessment.json",
          buildCloseoutArtifact(closeout),
        );
        emitArtifactWritten({
          artifactPath: closeoutArtifact,
          summary: "closeout assessment written",
          round,
          role: "controller",
        });
        const workspaceCleanup =
          closeout.status === "pass"
            ? cleanupWorkflowOwnedWorkspace(input)
            : {
                status: "skipped",
                reason: "Workspace cleanup skipped because closeout did not pass.",
                trace: [],
              } satisfies WorkspaceCleanupResult;
        const closeoutBlocked = closeout.status !== "pass";
        const cleanupBlocked = workspaceCleanup.status === "blocked";
        const finalBlocked = closeoutBlocked || cleanupBlocked;
        const finalReason = closeoutBlocked
          ? `Closeout mismatch after controller DONE: ${closeout.reason}`
          : cleanupBlocked
            ? `Workflow-owned workspace cleanup failed after closeout passed: ${workspaceCleanup.reason}`
            : decision.reason.join(" ").trim() || "Controller approved completion.";
        const summaryArtifact = writeWorkflowArtifact(
          ctx.runId,
          "run-summary.txt",
          buildRunSummary({
            status: finalBlocked ? "blocked" : "done",
            round,
            reason: finalReason,
            workerSession: sessions.worker ?? buildPendingCodexWorkerSessionLabel(ctx.runId),
            controllerSession: sessions.orchestrator,
            closeout,
            workspaceCleanup,
          }),
        );
        emitArtifactWritten({
          artifactPath: summaryArtifact,
          summary: "run summary written",
          round,
          role: "controller",
        });
        if (workspaceCleanup.status !== "not_applicable" && workspaceCleanup.status !== "skipped") {
          ctx.trace.emit({
            kind: workspaceCleanup.status === "blocked" ? "warning" : "custom",
            stepId,
            round,
            role: "controller",
            status: workspaceCleanup.status === "blocked" ? "blocked" : "done",
            summary: workspaceCleanup.reason,
            payload: {
              workspaceCleanupStatus: workspaceCleanup.status,
              workspaceCleanupTrace: workspaceCleanup.trace,
            },
          });
        }
        ctx.trace.emit({
          kind: finalBlocked ? "run_blocked" : "run_completed",
          stepId,
          round,
          role: "controller",
          status: finalBlocked ? "blocked" : "done",
          summary: finalReason,
          payload: {
            closeoutStatus: closeout.status,
            closeoutReason: closeout.reason,
            closeoutTrace: closeout.trace,
            closeoutArtifact,
            workspaceCleanupStatus: workspaceCleanup.status,
            workspaceCleanupReason: workspaceCleanup.reason,
            workspaceCleanupTrace: workspaceCleanup.trace,
          },
        });
        await emitTracedWorkflowReportEvent({
          trace: ctx.trace,
          stepId,
          moduleId: "codex_controller",
          runId: ctx.runId,
          phase: finalBlocked ? "workflow_blocked" : "workflow_done",
          eventType: finalBlocked ? "blocked" : "completed",
          messageText: closeoutBlocked
            ? [
                "Closeout mismatch after controller DONE.",
                `Round: ${round}/${input.maxRetries}`,
                "",
                "Reason:",
                `- ${closeout.reason}`,
                "",
                "Trace:",
                ...closeout.trace.map((line) => `- ${line}`),
              ].join("\n")
            : cleanupBlocked
              ? [
                  "Workflow-owned workspace cleanup failed after closeout passed.",
                  `Round: ${round}/${input.maxRetries}`,
                  "",
                  "Reason:",
                  `- ${workspaceCleanup.reason}`,
                  "",
                  "Trace:",
                  ...workspaceCleanup.trace.map((line) => `- ${line}`),
                ].join("\n")
            : buildControllerCompletionMessage({
                finalResult: codexResult.text,
                decision,
                round,
                maxRounds: input.maxRetries,
              }),
          emittingAgentId: input.controllerAgentId,
          origin: request.origin,
          reporting: request.reporting,
          status: finalBlocked ? "blocked" : "done",
          role: "orchestrator",
          round,
          targetSessionKey: sessions.orchestrator,
        });
        return buildRecord({
          runId: record.runId,
          input,
          sessions,
          status: finalBlocked ? "blocked" : "done",
          terminalReason: finalReason,
          currentRound: round,
          maxRounds: input.maxRetries,
          artifacts: [...record.artifacts, closeoutArtifact, summaryArtifact],
          latestWorkerOutput: codexResult.text,
          latestCriticVerdict: controllerRun.text,
          createdAt: record.createdAt,
          updatedAt: ctx.nowIso(),
          currentTask: decision.nextInstruction.join(" ").trim() || input.task,
          origin: request.origin,
          reporting: request.reporting,
        });
      }

      if (decision.decision === "ESCALATE_BLOCKED") {
        const blockedReason =
          [...decision.reason, ...decision.blocker].join(" ").trim() ||
          "Controller identified a real blocker.";
        const closeoutArtifact = enforcedCloseoutAssessment
          ? writeWorkflowArtifact(
              ctx.runId,
              "closeout-assessment.json",
              buildCloseoutArtifact(enforcedCloseoutAssessment),
            )
          : null;
        if (closeoutArtifact) {
          emitArtifactWritten({
            artifactPath: closeoutArtifact,
            summary: "closeout assessment written",
            round,
            role: "controller",
          });
        }
        const summaryArtifact = writeWorkflowArtifact(
          ctx.runId,
          "run-summary.txt",
          buildRunSummary({
            status: "blocked",
            round,
            reason: blockedReason,
            workerSession: sessions.worker ?? buildPendingCodexWorkerSessionLabel(ctx.runId),
            controllerSession: sessions.orchestrator,
            closeout: enforcedCloseoutAssessment,
          }),
        );
        emitArtifactWritten({
          artifactPath: summaryArtifact,
          summary: "run summary written",
          round,
          role: "controller",
        });
        ctx.trace.emit({
          kind: "run_blocked",
          stepId,
          round,
          role: "controller",
          status: "blocked",
          summary: blockedReason,
          ...(enforcedCloseoutAssessment
            ? {
                payload: {
                  closeoutStatus: enforcedCloseoutAssessment.status,
                  closeoutReason: enforcedCloseoutAssessment.reason,
                  closeoutTrace: enforcedCloseoutAssessment.trace,
                  closeoutArtifact,
                },
              }
            : {}),
        });
        await emitTracedWorkflowReportEvent({
          trace: ctx.trace,
          stepId,
          moduleId: "codex_controller",
          runId: ctx.runId,
          phase: "workflow_blocked",
          eventType: "blocked",
          messageText: buildControllerTerminalMessage({
            decision,
            round,
            maxRounds: input.maxRetries,
            blocked: true,
          }),
          emittingAgentId: input.controllerAgentId,
          origin: request.origin,
          reporting: request.reporting,
          status: "blocked",
          role: "orchestrator",
          round,
          targetSessionKey: sessions.orchestrator,
        });
        return buildRecord({
          runId: record.runId,
          input,
          sessions,
          status: "blocked",
          terminalReason: blockedReason,
          currentRound: round,
          maxRounds: input.maxRetries,
          artifacts: [
            ...record.artifacts,
            ...(closeoutArtifact ? [closeoutArtifact] : []),
            summaryArtifact,
          ],
          latestWorkerOutput: codexResult.text,
          latestCriticVerdict: controllerRun.text,
          createdAt: record.createdAt,
          updatedAt: ctx.nowIso(),
          currentTask: decision.blocker.join(" ").trim() || input.task,
          origin: request.origin,
          reporting: request.reporting,
        });
      }

      nextInstruction = decision.nextInstruction;
    }

    const summaryArtifact = writeWorkflowArtifact(
      ctx.runId,
      "run-summary.txt",
      buildRunSummary({
        status: "max_rounds_reached",
        round: input.maxRetries,
        reason: "Controller retry budget exhausted.",
        workerSession: sessions.worker ?? buildPendingCodexWorkerSessionLabel(ctx.runId),
        controllerSession: sessions.orchestrator,
      }),
    );
    emitArtifactWritten({
      artifactPath: summaryArtifact,
      summary: "run summary written",
      round: input.maxRetries,
      role: "controller",
    });
    ctx.trace.emit({
      kind: "run_blocked",
      stepId: stepIdForRound(input.maxRetries),
      round: input.maxRetries,
      role: "controller",
      status: "max_rounds_reached",
      summary: "Controller retry budget exhausted.",
    });
    await emitTracedWorkflowReportEvent({
      trace: ctx.trace,
      stepId: stepIdForRound(input.maxRetries),
      moduleId: "codex_controller",
      runId: ctx.runId,
      phase: "workflow_blocked",
      eventType: "blocked",
      messageText: [
        "Controller retry budget exhausted.",
        `Round: ${input.maxRetries}/${input.maxRetries}`,
      ].join("\n"),
      emittingAgentId: input.controllerAgentId,
      origin: request.origin,
      reporting: request.reporting,
      status: "max_rounds_reached",
      role: "orchestrator",
      round: input.maxRetries,
      targetSessionKey: sessions.orchestrator,
    });
    return buildRecord({
      runId: record.runId,
      input,
      sessions,
      status: "max_rounds_reached",
      terminalReason: "Controller retry budget exhausted.",
      currentRound: input.maxRetries,
      maxRounds: input.maxRetries,
      artifacts: [...record.artifacts, summaryArtifact],
      latestWorkerOutput: record.latestWorkerOutput,
      latestCriticVerdict: record.latestCriticVerdict,
      createdAt: record.createdAt,
      updatedAt: ctx.nowIso(),
      currentTask: record.currentTask,
      origin: request.origin,
      reporting: request.reporting,
    });
  },
};

export const __testing = {
  buildControllerInitPrompt,
  buildCloseoutPreflight,
  buildControllerDeltaPrompt,
  summarizeWorkerRound,
  assessDrift,
  enforceContinueGuardrails,
  remapInvalidDoneDecision,
  classifyCodexWorkerRetry,
};
