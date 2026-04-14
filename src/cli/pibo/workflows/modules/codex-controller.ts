import { existsSync, readFileSync } from "node:fs";
import { getAcpSessionManager } from "../../../../acp/control-plane/manager.js";
import {
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../../acp/runtime/registry.js";
import type { AcpRuntimeEvent } from "../../../../acp/runtime/types.js";
import { resolveAgentWorkspaceDir } from "../../../../agents/agent-scope.js";
import { ensureCliPluginRegistryLoaded } from "../../../../cli/plugin-registry-loader.js";
import { loadConfig } from "../../../../config/config.js";
import { getActivePluginRegistry } from "../../../../plugins/runtime.js";
import { startPluginServices, type PluginServicesHandle } from "../../../../plugins/services.js";
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

type WorkerCompactionMode = "off" | "acp_control_command";

type CodexControllerInput = {
  task: string;
  workingDirectory: string;
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
let cliPluginServicesHandlePromise: Promise<PluginServicesHandle> | null = null;
let cliPluginServicesWorkspaceDir: string | undefined;
type ProbeableAcpRuntime = {
  probeAvailability?: () => Promise<void>;
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
  const workingDirectory =
    typeof record.workingDirectory === "string" ? record.workingDirectory.trim() : "";
  const agentId =
    typeof record.agentId === "string" && record.agentId.trim() ? record.agentId.trim() : undefined;
  if (!task) {
    throw new Error("codex_controller benötigt ein nicht-leeres Feld `task`.");
  }
  if (!workingDirectory) {
    throw new Error(
      "codex_controller benötigt `input.workingDirectory`. Falls `repoPath` übergeben wurde, bitte in `workingDirectory` umbenennen.",
    );
  }
  const maxRetries =
    normalizePositiveInteger(record.maxRetries) ??
    normalizePositiveInteger(request.maxRounds) ??
    DEFAULT_MAX_ROUNDS;
  return {
    task,
    workingDirectory,
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
  input: Required<CodexControllerInput>;
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
  input: Required<CodexControllerInput>;
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

function buildControllerDeltaPrompt(params: {
  round: number;
  maxRounds: number;
  workerOutput: string;
  recentWorkerHistory: WorkerRoundSummary[];
  controllerHistory: ControllerRoundSummary[];
  currentWorkerSummary: WorkerRoundSummary;
  drift: DriftAssessment;
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
    ...(input.agentId ? [`Context workspace agent: ${input.agentId}`] : []),
    ...(input.successCriteria.length
      ? [`Success criteria: ${input.successCriteria.join("; ")}`]
      : []),
    ...(input.constraints.length ? [`Constraints: ${input.constraints.join("; ")}`] : []),
  ].join("\n");
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
  input: Required<CodexControllerInput>;
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

  const outputEvents: string[] = [];
  const rawEvents: AcpRuntimeEvent[] = [];
  await manager.runTurn({
    cfg,
    sessionKey: params.sessionKey,
    text: params.text,
    mode: "prompt",
    requestId: params.requestId,
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

  const text = outputEvents.join("").trim();
  if (!text) {
    throw new Error(`Codex worker produced no output on session ${params.sessionKey}.`);
  }
  return { text, outputEvents, rawEvents };
}

async function maybeCompactCodexSession(params: {
  input: NormalizedCodexControllerInput;
  sessionKey: string;
  round: number;
  contextWorkspaceDir?: string;
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
  await manager.runTurn({
    cfg,
    sessionKey: params.sessionKey,
    text: `/compact Focus on the original task, current code changes, remaining gaps, and blocker state for: ${params.input.task}`,
    mode: "steer",
    requestId: `${params.sessionKey}:compact:${params.round}`,
  });
  return true;
}

export const codexControllerWorkflowModule: WorkflowModule = {
  manifest: {
    moduleId: "codex_controller",
    displayName: "Codex Controller",
    description:
      "Runs a persistent Codex ACP worker under a controller loop that keeps going, finishes cleanly, or escalates real blockers.",
    kind: "agent_workflow",
    version: "0.2.1",
    requiredAgents: ["codex", "codex-controller"],
    terminalStates: ["done", "blocked", "aborted", "max_rounds_reached", "failed"],
    supportsAbort: false,
    inputSchemaSummary: [
      "task (string, required): original coding task passed directly to Codex.",
      "workingDirectory (string, required): absolute project/worktree path used as the persistent Codex ACP worker cwd.",
      "agentId (string, optional): agent workspace used for bootstrap/context/system-prompt resolution; does not change workingDirectory or worker cwd.",
      "maxRetries|maxRounds (number, optional): controller loop budget; defaults to 10.",
      "successCriteria (string[], optional): additional completion criteria.",
      "constraints (string[], optional): extra constraints to keep in every turn.",
      `controllerPromptPath (string, optional): defaults to ${DEFAULT_CONTROLLER_PROMPT_PATH}.`,
      'workerCompactionMode ("off"|"acp_control_command", optional): semantic ACP-thread compaction strategy; defaults to off. Use acp_control_command only as an explicit debugging or specialized exception path.',
      `workerCompactionAfterRound (number, optional): first round that may trigger manual ACP-thread compaction when workerCompactionMode is set to acp_control_command; defaults to ${DEFAULT_WORKER_COMPACTION_AFTER_ROUND}.`,
    ],
    artifactContract: [
      "round-<n>-codex.txt: raw Codex worker output per round.",
      "round-<n>-controller.txt: raw controller output per round, including normalized decision block.",
      "run-summary.txt: terminal summary with final status, reason, and session keys.",
    ],
  },
  async start(request, ctx: WorkflowModuleContext) {
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
      ...(input.agentId ? { contextAgentId: input.agentId } : {}),
      ...(contextWorkspaceDir ? { contextWorkspaceDir } : {}),
      controllerPromptPath: input.controllerPromptPath,
      workerCompactionMode: input.workerCompactionMode,
      workerCompactionAfterRound: String(input.workerCompactionAfterRound),
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
    });

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
      const codexResult = await runCodexTurn({
        sessionKey: codexSessionKey,
        workingDirectory: input.workingDirectory,
        agentId: input.codexAgentId,
        text: codexPrompt,
        requestId: `${ctx.runId}:codex:${round}`,
        contextWorkspaceDir,
      });
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

      const currentWorkerSummary = summarizeWorkerRound(round, codexResult.text);
      const recentWorkerHistory = [...workerHistory.slice(-2), currentWorkerSummary];
      const recentControllerHistory = controllerHistory.slice(-3);
      const drift = assessDrift({
        current: currentWorkerSummary,
        priorWorkers: workerHistory,
        priorControllers: controllerHistory,
      });
      const controllerMessage = buildControllerDeltaPrompt({
        round,
        maxRounds: input.maxRetries,
        workerOutput: codexResult.text,
        recentWorkerHistory,
        controllerHistory: recentControllerHistory,
        currentWorkerSummary,
        drift,
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

      if (decision.decision === "DONE") {
        const finalReason = decision.reason.join(" ").trim() || "Controller approved completion.";
        const summaryArtifact = writeWorkflowArtifact(
          ctx.runId,
          "run-summary.txt",
          [
            `status: done`,
            `round: ${round}`,
            `reason: ${finalReason}`,
            `worker-session: ${codexSessionKey}`,
            `controller-session: ${sessions.orchestrator}`,
          ].join("\n") + "\n",
        );
        emitArtifactWritten({
          artifactPath: summaryArtifact,
          summary: "run summary written",
          round,
          role: "controller",
        });
        ctx.trace.emit({
          kind: "run_completed",
          stepId,
          round,
          role: "controller",
          status: "done",
          summary: finalReason,
        });
        await emitTracedWorkflowReportEvent({
          trace: ctx.trace,
          stepId,
          moduleId: "codex_controller",
          runId: ctx.runId,
          phase: "workflow_done",
          eventType: "completed",
          messageText: buildControllerCompletionMessage({
            finalResult: codexResult.text,
            decision,
            round,
            maxRounds: input.maxRetries,
          }),
          emittingAgentId: input.controllerAgentId,
          origin: request.origin,
          reporting: request.reporting,
          status: "done",
          role: "orchestrator",
          round,
          targetSessionKey: sessions.orchestrator,
        });
        return buildRecord({
          runId: record.runId,
          input,
          sessions,
          status: "done",
          terminalReason: finalReason,
          currentRound: round,
          maxRounds: input.maxRetries,
          artifacts: [...record.artifacts, summaryArtifact],
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
          [
            `status: blocked`,
            `round: ${round}`,
            `reason: ${blockedReason}`,
            `worker-session: ${codexSessionKey}`,
            `controller-session: ${sessions.orchestrator}`,
          ].join("\n") + "\n",
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
      [
        `status: max_rounds_reached`,
        `round: ${input.maxRetries}`,
        `reason: Controller retry budget exhausted.`,
        `worker-session: ${codexSessionKey}`,
        `controller-session: ${sessions.orchestrator}`,
      ].join("\n") + "\n",
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
  buildControllerDeltaPrompt,
  summarizeWorkerRound,
  assessDrift,
  enforceContinueGuardrails,
};
