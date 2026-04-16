import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAcpSessionManager } from "../../../../acp/control-plane/manager.js";
import {
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../../acp/runtime/registry.js";
import type { AcpRuntimeEvent } from "../../../../acp/runtime/types.js";
import { resolveAgentWorkspaceDir } from "../../../../agents/agent-scope.js";
import { describeFailoverError } from "../../../../agents/failover-error.js";
import { ensureCliPluginRegistryLoaded } from "../../../../cli/plugin-registry-loader.js";
import { loadConfig } from "../../../../config/config.js";
import { findGitRoot } from "../../../../infra/git-root.js";
import { getActivePluginRegistry } from "../../../../plugins/runtime.js";
import { startPluginServices, type PluginServicesHandle } from "../../../../plugins/services.js";
import {
  createWorkflowAbortError,
  isWorkflowAbortError,
  throwIfWorkflowAbortRequested,
} from "../abort.js";
import { runWorkflowAgentOnSession } from "../agent-runtime.js";
import { writeWorkflowArtifact } from "../store.js";
import type {
  WorkflowModule,
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../types.js";
import { emitTracedWorkflowReportEvent } from "../workflow-reporting.js";
import { buildAcpWorkflowSessionKey, ensureWorkflowSessions } from "../workflow-session-helper.js";
import { codexControllerWorkflowModuleManifest } from "./manifests.js";

type WorkerCompactionMode = "off" | "acp_control_command";

type CodexControllerInput = {
  task: string;
  workingDirectory: string;
  repoRoot?: string;
  agentId?: string;
  maxRetries?: number;
  successCriteria: string[];
  constraints: string[];
  codexAgentId: string;
  controllerAgentId: string;
  controllerPromptPath: string;
  workerCompactionMode?: WorkerCompactionMode;
  workerCompactionAfterRound?: number;
};

type NormalizedCodexControllerInput = Omit<Required<CodexControllerInput>, "agentId"> & {
  agentId?: string;
  closeoutContextSource: "repoRoot" | "workingDirectory";
};

type CloseoutContext = Pick<
  NormalizedCodexControllerInput,
  "workingDirectory" | "repoRoot" | "closeoutContextSource"
>;

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
    requestedRepoRoot: string;
    closeoutContextSource: CloseoutContext["closeoutContextSource"];
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
  repoRoot: string | null;
  workingDirectory: string;
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

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_CONTROLLER_PROMPT_PATH =
  "/home/pibo/.openclaw/workspace/prompts/coding-controller-prompt.md";
const DEFAULT_WORKER_COMPACTION_MODE: WorkerCompactionMode = "off";
const DEFAULT_WORKER_COMPACTION_AFTER_ROUND = 3;
const CODEX_WORKER_PROMPT_TIMEOUT_SECONDS = 300;
const CODEX_WORKER_RETRY_DELAYS_MS = [1_000] as const;
const RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE = [
  /\btimed out after \d+ms\b/i,
  /\brpc timeout\b/i,
  /\bprompt(?:\s+\w+){0,6}\s+(?:timed out|timeout)\b/i,
  /\bprompt completion failed\b.*\b(timeout|temporar|transient|overload|unavailable|connection|closed|reset|network|fetch failed)\b/i,
  /\b(connection (?:closed|reset|error)|transport closed|fetch failed|econnreset|ehostdown|epipe|gateway timeout|service unavailable|temporarily unavailable|overloaded)\b/i,
] as const;
const NON_RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE = [
  /\b(permission denied|unauthori(?:s|z)ed|forbidden|not accept config key|unsupported|invalid|not found|prompt exceeds maximum allowed size|tool approval|approval denied|schema|validation)\b/i,
] as const;
let cliPluginServicesHandlePromise: Promise<PluginServicesHandle> | null = null;
let cliPluginServicesWorkspaceDir: string | undefined;
type ProbeableAcpRuntime = {
  probeAvailability?: () => Promise<void>;
};
type CodexWorkerRetryClassification = {
  retryable: boolean;
  reason: "timeout" | "transient_prompt_failure" | "non_retryable";
  errorCode?: string;
  failoverReason?: string;
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
  if (value === "acp_control_command") {
    return "acp_control_command";
  }
  return DEFAULT_WORKER_COMPACTION_MODE;
}

function normalizeInput(request: WorkflowStartRequest): NormalizedCodexControllerInput {
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
  const workingDirectory = path.resolve(rawWorkingDirectory);
  const repoRoot = path.resolve(rawRepoRoot || workingDirectory);
  const maxRetries =
    normalizePositiveInteger(record.maxRetries) ??
    normalizePositiveInteger(request.maxRounds) ??
    DEFAULT_MAX_ROUNDS;
  return {
    task,
    workingDirectory,
    repoRoot,
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
    workerCompactionMode: normalizeCompactionMode(record.workerCompactionMode),
    workerCompactionAfterRound:
      normalizePositiveInteger(record.workerCompactionAfterRound) ??
      DEFAULT_WORKER_COMPACTION_AFTER_ROUND,
    closeoutContextSource: rawRepoRoot ? "repoRoot" : "workingDirectory",
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

function isLowSignalToolCallText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^tool call(?:\s+\((?:in_progress|completed|failed)\))?$/.test(normalized);
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
  input: NormalizedCodexControllerInput;
  round: number;
  maxRounds: number;
  nextInstruction: string[];
}): string {
  return [
    params.round === 1
      ? params.input.task
      : [
          "Continue the same coding task in the same workspace/session.",
          "Use the controller feedback below as the next focused instruction.",
          "Do not ask the user for routine continuation approval. Keep moving unless truly blocked.",
          "CONTROLLER_NEXT_INSTRUCTION:",
          toBulletLines(params.nextInstruction),
        ].join("\n"),
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.input.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.input.constraints),
    "",
    "FINISH_QUALITY:",
    "- Before claiming done, remove avoidable transient artifacts created only during verification, such as __pycache__/ and .pytest_cache/, unless the task explicitly wants them kept.",
    "- Keep README usage aligned with the commands that actually work in this repository.",
    "- If you run tests or smoke checks, make sure the repository is left in a tidy post-verification state.",
  ].join("\n");
}

function buildControllerInitPrompt(params: {
  controllerPrompt: string;
  input: NormalizedCodexControllerInput;
  maxRounds: number;
}): string {
  return [
    params.controllerPrompt,
    "",
    "You are operating inside the codex_controller PIBO workflow module.",
    "This controller session is persistent for the whole workflow run.",
    "Treat this message as one-time stable run context. Later messages send only bounded per-round deltas.",
    `Round budget: ${params.maxRounds}.`,
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
    "ORIGINAL_TASK:",
    params.input.task,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.input.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.input.constraints),
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
  const openWorktreePaths = assessment.git.worktreePaths.filter(
    (worktreePath) => path.resolve(worktreePath) !== repoRoot,
  );
  const failedCheckSummary =
    assessment.checks.find((check) => !check.ok)?.summary ?? assessment.reason;
  return {
    status,
    failureClass,
    summary: failedCheckSummary,
    reason: assessment.reason,
    repoRoot,
    workingDirectory: assessment.context.workingDirectory,
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

function formatCloseoutPreflightCheckValue(value: CloseoutPreflightCheckValue): string {
  return value === "unknown" ? "unknown" : value ? "true" : "false";
}

function buildCloseoutPreflightPrompt(preflight: CloseoutPreflight): string {
  return [
    `status=${preflight.status}`,
    `failure_class=${preflight.failureClass}`,
    `summary=${preflight.summary}`,
    `repo_root=${preflight.repoRoot ?? "unresolved"}`,
    `working_directory=${preflight.workingDirectory}`,
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

function buildControllerDeltaPrompt(params: {
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
    "Use the stable controller policy and normalized workflow contract already provided in this session.",
    "Evaluate only the bounded dynamic context below.",
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
    `Closeout repo root: ${input.repoRoot} (${input.closeoutContextSource})`,
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

function assessCloseout(context: CloseoutContext): CloseoutAssessment {
  const requestedRepoRoot = context.repoRoot;
  const directRequestedRepoRoot = runGitReadOnly(requestedRepoRoot, [
    "rev-parse",
    "--show-toplevel",
  ]);
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
    `requested_repo_root=${requestedRepoRoot}`,
    `working_directory=${context.workingDirectory}`,
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
      context: {
        workingDirectory: context.workingDirectory,
        requestedRepoRoot,
        closeoutContextSource: context.closeoutContextSource,
        resolvedRepoRoot: null,
      },
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
      context: {
        workingDirectory: context.workingDirectory,
        requestedRepoRoot,
        closeoutContextSource: context.closeoutContextSource,
        resolvedRepoRoot,
      },
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
      context: {
        workingDirectory: context.workingDirectory,
        requestedRepoRoot,
        closeoutContextSource: context.closeoutContextSource,
        resolvedRepoRoot,
      },
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
      context: {
        workingDirectory: context.workingDirectory,
        requestedRepoRoot,
        closeoutContextSource: context.closeoutContextSource,
        resolvedRepoRoot,
      },
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
      context: {
        workingDirectory: context.workingDirectory,
        requestedRepoRoot,
        closeoutContextSource: context.closeoutContextSource,
        resolvedRepoRoot,
      },
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
      context: {
        workingDirectory: context.workingDirectory,
        requestedRepoRoot,
        closeoutContextSource: context.closeoutContextSource,
        resolvedRepoRoot,
      },
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
      context: {
        workingDirectory: context.workingDirectory,
        requestedRepoRoot,
        closeoutContextSource: context.closeoutContextSource,
        resolvedRepoRoot,
      },
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
    context: {
      workingDirectory: context.workingDirectory,
      requestedRepoRoot,
      closeoutContextSource: context.closeoutContextSource,
      resolvedRepoRoot,
    },
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

function buildRunSummary(params: {
  status: WorkflowRunRecord["status"];
  round: number;
  reason: string;
  workerSession: string;
  controllerSession: string | undefined;
  closeout?: CloseoutAssessment;
}): string {
  return (
    [
      `status: ${params.status}`,
      `round: ${params.round}`,
      `reason: ${params.reason}`,
      `worker-session: ${params.workerSession}`,
      `controller-session: ${params.controllerSession ?? "n/a"}`,
      `closeout-status: ${params.closeout?.status ?? "not_run"}`,
      `closeout-reason: ${params.closeout?.reason ?? "not_run"}`,
      `closeout-repo-root: ${params.closeout?.context.resolvedRepoRoot ?? "n/a"}`,
      `closeout-working-directory: ${params.closeout?.context.workingDirectory ?? "n/a"}`,
      `closeout-head: ${params.closeout?.git.head ?? "n/a"}`,
      `closeout-base-ref: ${params.closeout?.git.baseRef ?? "n/a"}`,
      `closeout-trace: ${(params.closeout?.trace ?? ["not_run"]).join(" | ")}`,
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

function normalizeWorkspaceOverride(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function ensureCliAcpRuntimeReady(
  cfg: ReturnType<typeof loadConfig>,
  contextWorkspaceDir?: string,
): Promise<void> {
  const desiredWorkspaceDir =
    normalizeWorkspaceOverride(contextWorkspaceDir) ??
    normalizeWorkspaceOverride(cfg.agents?.defaults?.workspace);
  await ensureCliPluginRegistryLoaded({ scope: "all" });
  if (cliPluginServicesHandlePromise && cliPluginServicesWorkspaceDir !== desiredWorkspaceDir) {
    const activeHandle = await cliPluginServicesHandlePromise.catch(() => null);
    cliPluginServicesHandlePromise = null;
    cliPluginServicesWorkspaceDir = undefined;
    await activeHandle?.stop();
  }
  if (!cliPluginServicesHandlePromise) {
    const registry = getActivePluginRegistry();
    if (!registry) {
      throw new Error("CLI plugin registry did not load for codex_controller ACP runtime.");
    }
    const startPromise = startPluginServices({
      registry,
      config: cfg,
      workspaceDir: desiredWorkspaceDir,
    });
    cliPluginServicesWorkspaceDir = desiredWorkspaceDir;
    cliPluginServicesHandlePromise = startPromise.catch((error) => {
      if (cliPluginServicesHandlePromise === startPromise) {
        cliPluginServicesHandlePromise = null;
        cliPluginServicesWorkspaceDir = undefined;
      }
      throw error;
    });
  }
  await cliPluginServicesHandlePromise;

  const backendId =
    cfg.acp && typeof cfg.acp.backend === "string" && cfg.acp.backend.trim()
      ? cfg.acp.backend.trim()
      : undefined;
  const backend = getAcpRuntimeBackend(backendId);
  const runtime = backend?.runtime as ProbeableAcpRuntime | undefined;
  if (backend?.healthy?.() === false && typeof runtime?.probeAvailability === "function") {
    await runtime.probeAvailability();
  }
  requireAcpRuntimeBackend(backendId);
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

async function runCodexTurn(params: {
  sessionKey: string;
  workingDirectory: string;
  agentId: string;
  text: string;
  requestId: string;
  contextWorkspaceDir?: string;
  abortSignal?: AbortSignal;
}): Promise<{
  text: string;
  outputEvents: string[];
  rawEvents: AcpRuntimeEvent[];
}> {
  const cfg = loadConfig();
  await ensureCliAcpRuntimeReady(cfg, params.contextWorkspaceDir);
  const manager = getAcpSessionManager();
  await manager.initializeSession({
    cfg,
    sessionKey: params.sessionKey,
    agent: params.agentId,
    mode: "persistent",
    cwd: params.workingDirectory,
  });
  await manager.updateSessionRuntimeOptions({
    cfg,
    sessionKey: params.sessionKey,
    patch: {
      timeoutSeconds: CODEX_WORKER_PROMPT_TIMEOUT_SECONDS,
    },
  });

  const outputEvents: string[] = [];
  const rawEvents: AcpRuntimeEvent[] = [];
  const onAbort = () => {
    void manager.cancelSession({
      cfg,
      sessionKey: params.sessionKey,
      reason: "workflow abort requested",
    });
  };
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    await manager.runTurn({
      cfg,
      sessionKey: params.sessionKey,
      text: params.text,
      mode: "prompt",
      requestId: params.requestId,
      signal: params.abortSignal,
      onEvent: (event) => {
        rawEvents.push(event);
        if (event.type === "text_delta" && event.stream !== "thought" && event.text) {
          outputEvents.push(event.text);
        }
        if (event.type === "tool_call" && event.text && !isLowSignalToolCallText(event.text)) {
          outputEvents.push(`[tool] ${event.text}`);
        }
      },
    });
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
  }

  const text = outputEvents.join("").trim();
  if (!text) {
    throw new Error(`Codex worker produced no output on session ${params.sessionKey}.`);
  }
  return { text, outputEvents, rawEvents };
}

function classifyCodexWorkerRetry(error: unknown): CodexWorkerRetryClassification {
  const details = describeFailoverError(error);
  const message = details.message.trim() || String(error);
  const timeoutLike = details.reason === "timeout";
  const transientPromptFailure =
    !timeoutLike &&
    !NON_RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE.some((pattern) => pattern.test(message)) &&
    RETRYABLE_CODEX_WORKER_PROMPT_FAILURE_RE.some((pattern) => pattern.test(message));
  return {
    retryable: timeoutLike || transientPromptFailure,
    reason: timeoutLike
      ? "timeout"
      : transientPromptFailure
        ? "transient_prompt_failure"
        : "non_retryable",
    errorCode: details.code,
    failoverReason: details.reason ?? undefined,
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
      ? "retryable timeout-style ACPX worker prompt failure"
      : params.retryReason === "transient_prompt_failure"
        ? "retryable transient ACPX worker prompt failure"
        : undefined;
  const lines = [
    headline,
    `Round: ${params.round}/${params.maxRounds}`,
    `Attempt: ${params.attempt}/${params.maxAttempts}`,
    `Worker prompt timeout: ${CODEX_WORKER_PROMPT_TIMEOUT_SECONDS}s`,
    ...(typeof params.delayMs === "number" ? [`Retry delay: ${params.delayMs}ms`] : []),
    ...(reasonLabel ? [`Reason: ${reasonLabel}`] : []),
    ...(params.errorCode ? [`ACP error code: ${params.errorCode}`] : []),
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
      workerPromptTimeoutSeconds: CODEX_WORKER_PROMPT_TIMEOUT_SECONDS,
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

async function resetCodexWorkerSessionForRetry(params: {
  sessionKey: string;
  contextWorkspaceDir?: string;
}): Promise<string> {
  const cfg = loadConfig();
  await ensureCliAcpRuntimeReady(cfg, params.contextWorkspaceDir);
  const result = await getAcpSessionManager().closeSession({
    cfg,
    sessionKey: params.sessionKey,
    reason: "codex-controller-worker-retry",
    allowBackendUnavailable: true,
    discardPersistentState: false,
    clearMeta: false,
    requireAcpSession: false,
  });
  if (result.runtimeNotice) {
    return `runtime close degraded but cached handle was cleared: ${result.runtimeNotice}`;
  }
  if (result.runtimeClosed) {
    return "runtime handle closed and will be reinitialized on retry";
  }
  return "no active runtime handle remained; retry will reinitialize the worker session";
}

async function runCodexTurnWithRetry(params: {
  sessionKey: string;
  workingDirectory: string;
  agentId: string;
  text: string;
  requestId: string;
  contextWorkspaceDir?: string;
  abortSignal?: AbortSignal;
  trace: WorkflowModuleContext["trace"];
  runId: string;
  stepId: string;
  round: number;
  maxRounds: number;
  origin?: WorkflowStartRequest["origin"];
  reporting?: WorkflowStartRequest["reporting"];
}): Promise<{
  text: string;
  outputEvents: string[];
  rawEvents: AcpRuntimeEvent[];
}> {
  const maxAttempts = CODEX_WORKER_RETRY_DELAYS_MS.length + 1;
  let lastRetryReason: CodexWorkerRetryClassification["reason"] | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfWorkflowAbortRequested(params.abortSignal);
    try {
      const result = await runCodexTurn({
        sessionKey: params.sessionKey,
        workingDirectory: params.workingDirectory,
        agentId: params.agentId,
        text: params.text,
        requestId: `${params.requestId}:attempt:${attempt}`,
        contextWorkspaceDir: params.contextWorkspaceDir,
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
          sessionKey: params.sessionKey,
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
      if (isWorkflowAbortError(error)) {
        throw error;
      }
      const classification = classifyCodexWorkerRetry(error);
      lastRetryReason = classification.reason;
      const delayMs = CODEX_WORKER_RETRY_DELAYS_MS[attempt - 1];
      if (!classification.retryable || delayMs === undefined) {
        if (classification.retryable) {
          await emitCodexWorkerRetryEvent({
            trace: params.trace,
            stepId: params.stepId,
            moduleId: "codex_controller",
            runId: params.runId,
            round: params.round,
            maxRounds: params.maxRounds,
            sessionKey: params.sessionKey,
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
        sessionKey: params.sessionKey,
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
      let cleanupNotice: string;
      try {
        cleanupNotice = await resetCodexWorkerSessionForRetry({
          sessionKey: params.sessionKey,
          contextWorkspaceDir: params.contextWorkspaceDir,
        });
      } catch (cleanupError) {
        const cleanupMessage =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        await emitCodexWorkerRetryEvent({
          trace: params.trace,
          stepId: params.stepId,
          moduleId: "codex_controller",
          runId: params.runId,
          round: params.round,
          maxRounds: params.maxRounds,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          phase: "worker_retry_exhausted",
          attempt,
          maxAttempts,
          errorMessage: classification.message,
          errorCode: classification.errorCode,
          retryReason: classification.reason,
          cleanupNotice: cleanupMessage,
          origin: params.origin,
          reporting: params.reporting,
        });
        throw new Error(
          `Codex worker retry cleanup failed before attempt ${attempt + 1}: ${cleanupMessage}`,
          { cause: cleanupError },
        );
      }
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
        sessionKey: params.sessionKey,
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
  input: NormalizedCodexControllerInput;
  sessionKey: string;
  round: number;
  contextWorkspaceDir?: string;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  if (params.input.workerCompactionMode === "off") {
    return false;
  }
  if (params.round < params.input.workerCompactionAfterRound) {
    return false;
  }

  const cfg = loadConfig();
  await ensureCliAcpRuntimeReady(cfg, params.contextWorkspaceDir);
  const manager = getAcpSessionManager();
  await manager.initializeSession({
    cfg,
    sessionKey: params.sessionKey,
    agent: params.input.codexAgentId,
    mode: "persistent",
    cwd: params.input.workingDirectory,
  });
  const onAbort = () => {
    void manager.cancelSession({
      cfg,
      sessionKey: params.sessionKey,
      reason: "workflow abort requested",
    });
  };
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    await manager.runTurn({
      cfg,
      sessionKey: params.sessionKey,
      text: `/compact Focus on the original task, current code changes, remaining gaps, and blocker state for: ${params.input.task}`,
      mode: "steer",
      requestId: `${params.sessionKey}:compact:${params.round}`,
      signal: params.abortSignal,
    });
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
  }
  return true;
}

export const codexControllerWorkflowModule: WorkflowModule = {
  manifest: codexControllerWorkflowModuleManifest,
  async start(request, ctx: WorkflowModuleContext) {
    ctx.throwIfAbortRequested?.();
    const input = normalizeInput(request);
    const cfg = loadConfig();
    const contextWorkspaceDir = resolveContextWorkspaceDir(input, cfg);
    const createdAt = ctx.nowIso();
    const controllerPrompt = loadControllerPrompt(input.controllerPromptPath);
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
    const codexSessionKey = buildAcpWorkflowSessionKey({
      agentId: input.codexAgentId,
      runId: ctx.runId,
      role: "worker",
      name: "codex",
    });
    sessions.worker = codexSessionKey;
    sessions.extras = {
      ...sessions.extras,
      codexWorkerRuntime: "acp",
      codexWorkerSessionKind: "persistent_acp_thread",
      workingDirectory: input.workingDirectory,
      repoRoot: input.repoRoot,
      closeoutContextSource: input.closeoutContextSource,
      ...(input.agentId ? { contextAgentId: input.agentId } : {}),
      ...(contextWorkspaceDir ? { contextWorkspaceDir } : {}),
      controllerPromptPath: input.controllerPromptPath,
      workerCompactionMode: input.workerCompactionMode,
      workerCompactionAfterRound: String(input.workerCompactionAfterRound),
      workerPromptTimeoutSeconds: String(CODEX_WORKER_PROMPT_TIMEOUT_SECONDS),
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
      artifacts: [],
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
        repoRoot: input.repoRoot,
        closeoutContextSource: input.closeoutContextSource,
        ...(input.agentId ? { contextAgentId: input.agentId } : {}),
        ...(contextWorkspaceDir ? { contextWorkspaceDir } : {}),
        codexAgentId: input.codexAgentId,
        controllerAgentId: input.controllerAgentId,
      },
    });
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
        controllerPrompt,
        input,
        maxRounds: input.maxRetries,
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
      ctx.trace.emit({
        kind: "round_started",
        stepId,
        round,
        status: "running",
        summary: `Round ${round} started.`,
      });
      if (round > 1) {
        const compacted = await maybeCompactCodexSession({
          input,
          sessionKey: codexSessionKey,
          round,
          contextWorkspaceDir,
          abortSignal: ctx.abortSignal,
        });
        if (compacted) {
          sessions.extras = {
            ...sessions.extras,
            lastCompactedBeforeRound: String(round),
          };
        }
      }

      const codexPrompt = buildCodexPrompt({
        input,
        round,
        maxRounds: input.maxRetries,
        nextInstruction,
      });
      ctx.trace.emit({
        kind: "role_turn_started",
        stepId,
        round,
        role: "worker",
        sessionKey: codexSessionKey,
        agentId: input.codexAgentId,
        summary: "codex worker turn started",
      });
      let codexResult: Awaited<ReturnType<typeof runCodexTurn>>;
      try {
        codexResult = await runCodexTurnWithRetry({
          sessionKey: codexSessionKey,
          workingDirectory: input.workingDirectory,
          agentId: input.codexAgentId,
          text: codexPrompt,
          requestId: `${ctx.runId}:codex:${round}`,
          contextWorkspaceDir,
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
        throw new Error(
          `Codex worker turn failed in round ${round}/${input.maxRetries} on session ${codexSessionKey}: ${message}`,
          { cause: error },
        );
      }
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
        sessionKey: codexSessionKey,
        agentId: input.codexAgentId,
        summary: "codex worker output captured",
        payload: {
          outputLength: codexResult.text.length,
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
      const closeoutPreflight = buildCloseoutPreflight(
        assessCloseout({
          workingDirectory: input.workingDirectory,
          repoRoot: input.repoRoot,
          closeoutContextSource: input.closeoutContextSource,
        }),
      );
      const controllerMessage = buildControllerDeltaPrompt({
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
      const decision = parseControllerDecision(controllerRun.text);
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
          repoRoot: input.repoRoot,
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
        const closeoutBlocked = closeout.status !== "pass";
        const finalReason = closeoutBlocked
          ? `Closeout mismatch after controller DONE: ${closeout.reason}`
          : decision.reason.join(" ").trim() || "Controller approved completion.";
        const summaryArtifact = writeWorkflowArtifact(
          ctx.runId,
          "run-summary.txt",
          buildRunSummary({
            status: closeoutBlocked ? "blocked" : "done",
            round,
            reason: finalReason,
            workerSession: codexSessionKey,
            controllerSession: sessions.orchestrator,
            closeout,
          }),
        );
        emitArtifactWritten({
          artifactPath: summaryArtifact,
          summary: "run summary written",
          round,
          role: "controller",
        });
        ctx.trace.emit({
          kind: closeoutBlocked ? "run_blocked" : "run_completed",
          stepId,
          round,
          role: "controller",
          status: closeoutBlocked ? "blocked" : "done",
          summary: finalReason,
          payload: {
            closeoutStatus: closeout.status,
            closeoutReason: closeout.reason,
            closeoutTrace: closeout.trace,
            closeoutArtifact,
          },
        });
        await emitTracedWorkflowReportEvent({
          trace: ctx.trace,
          stepId,
          moduleId: "codex_controller",
          runId: ctx.runId,
          phase: closeoutBlocked ? "workflow_blocked" : "workflow_done",
          eventType: closeoutBlocked ? "blocked" : "completed",
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
            : buildControllerCompletionMessage({
                finalResult: codexResult.text,
                decision,
                round,
                maxRounds: input.maxRetries,
              }),
          emittingAgentId: input.controllerAgentId,
          origin: request.origin,
          reporting: request.reporting,
          status: closeoutBlocked ? "blocked" : "done",
          role: "orchestrator",
          round,
          targetSessionKey: sessions.orchestrator,
        });
        return buildRecord({
          runId: record.runId,
          input,
          sessions,
          status: closeoutBlocked ? "blocked" : "done",
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
        const summaryArtifact = writeWorkflowArtifact(
          ctx.runId,
          "run-summary.txt",
          buildRunSummary({
            status: "blocked",
            round,
            reason: blockedReason,
            workerSession: codexSessionKey,
            controllerSession: sessions.orchestrator,
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
          artifacts: [...record.artifacts, summaryArtifact],
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
        workerSession: codexSessionKey,
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
  resetCliPluginServicesHandleForTests() {
    cliPluginServicesHandlePromise = null;
    cliPluginServicesWorkspaceDir = undefined;
  },
  buildControllerInitPrompt,
  buildCloseoutPreflight,
  buildControllerDeltaPrompt,
  summarizeWorkerRound,
  assessDrift,
  enforceContinueGuardrails,
};
