import { existsSync, readFileSync } from "node:fs";
import { getAcpSessionManager } from "../../../../acp/control-plane/manager.js";
import {
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../../../../acp/runtime/registry.js";
import type { AcpRuntimeEvent } from "../../../../acp/runtime/types.js";
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
  maxRetries?: number;
  successCriteria: string[];
  constraints: string[];
  codexAgentId: string;
  controllerAgentId: string;
  controllerPromptPath: string;
  workerCompactionMode?: WorkerCompactionMode;
  workerCompactionAfterRound?: number;
};

type ControllerDecision = {
  decision: "CONTINUE" | "ESCALATE_BLOCKED" | "DONE";
  reason: string[];
  nextInstruction: string[];
  blocker: string[];
  raw: string;
};

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_CONTROLLER_PROMPT_PATH =
  "/home/pibo/.openclaw/workspace/prompts/coding-controller-prompt.md";
const DEFAULT_WORKER_COMPACTION_MODE: WorkerCompactionMode = "acp_control_command";
const DEFAULT_WORKER_COMPACTION_AFTER_ROUND = 3;
let cliPluginServicesHandlePromise: Promise<PluginServicesHandle> | null = null;
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
  return value === "off" ? "off" : DEFAULT_WORKER_COMPACTION_MODE;
}

function normalizeInput(request: WorkflowStartRequest): Required<CodexControllerInput> {
  const record = request.input as Record<string, unknown>;
  if (!record || typeof record !== "object") {
    throw new Error("codex_controller erwartet ein JSON-Objekt als Input.");
  }
  const task = typeof record.task === "string" ? record.task.trim() : "";
  const workingDirectory =
    typeof record.workingDirectory === "string" ? record.workingDirectory.trim() : "";
  if (!task) {
    throw new Error("codex_controller benötigt ein nicht-leeres Feld `task`.");
  }
  if (!workingDirectory) {
    throw new Error("codex_controller benötigt ein nicht-leeres Feld `workingDirectory`.");
  }
  const maxRetries =
    normalizePositiveInteger(record.maxRetries) ??
    normalizePositiveInteger(request.maxRounds) ??
    DEFAULT_MAX_ROUNDS;
  return {
    task,
    workingDirectory,
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
        : "langgraph",
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

function buildControllerPrompt(params: {
  controllerPrompt: string;
  input: Required<CodexControllerInput>;
  round: number;
  maxRounds: number;
  workerOutput: string;
}): string {
  return [
    params.controllerPrompt,
    "",
    "You are operating inside the codex_controller PIBO workflow module.",
    `Current round: ${params.round}/${params.maxRounds}.`,
    "Use the controller prompt above as policy, but normalize your final answer for the workflow runtime.",
    "First decide using the prompt's native contract if helpful. Then return a final normalized block.",
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
    "- If MODULE_DECISION is CONTINUE, NEXT_INSTRUCTION must be concrete and actionable.",
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
    "WORKER_OUTPUT:",
    params.workerOutput,
  ].join("\n");
}

function buildWorkflowStartedMessage(input: Required<CodexControllerInput>): string {
  return [
    `Task: ${input.task}`,
    `Round budget: ${input.maxRetries}`,
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

async function ensureCliAcpRuntimeReady(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  await ensureCliPluginRegistryLoaded({ scope: "all" });
  if (!cliPluginServicesHandlePromise) {
    const registry = getActivePluginRegistry();
    if (!registry) {
      throw new Error("CLI plugin registry did not load for codex_controller ACP runtime.");
    }
    const startPromise = startPluginServices({
      registry,
      config: cfg,
      workspaceDir: cfg.agents?.defaults?.workspace,
    });
    cliPluginServicesHandlePromise = startPromise.catch((error) => {
      if (cliPluginServicesHandlePromise === startPromise) {
        cliPluginServicesHandlePromise = null;
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

async function runCodexTurn(params: {
  sessionKey: string;
  workingDirectory: string;
  agentId: string;
  text: string;
  requestId: string;
}): Promise<{ text: string; outputEvents: string[]; rawEvents: AcpRuntimeEvent[] }> {
  const cfg = loadConfig();
  await ensureCliAcpRuntimeReady(cfg);
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
      if (event.type === "tool_call" && event.text) {
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
  input: Required<CodexControllerInput>;
  sessionKey: string;
  round: number;
}): Promise<boolean> {
  if (params.input.workerCompactionMode === "off") {
    return false;
  }
  if (params.round < params.input.workerCompactionAfterRound) {
    return false;
  }

  const cfg = loadConfig();
  await ensureCliAcpRuntimeReady(cfg);
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
    version: "0.2.0",
    requiredAgents: ["codex", "langgraph"],
    terminalStates: ["done", "blocked", "aborted", "max_rounds_reached", "failed"],
    supportsAbort: false,
    inputSchemaSummary: [
      "task (string, required): original coding task passed directly to Codex.",
      "workingDirectory (string, required): absolute workspace path for the persistent Codex ACP session.",
      "maxRetries|maxRounds (number, optional): controller loop budget; defaults to 6.",
      "successCriteria (string[], optional): additional completion criteria.",
      "constraints (string[], optional): extra constraints to keep in every turn.",
      `controllerPromptPath (string, optional): defaults to ${DEFAULT_CONTROLLER_PROMPT_PATH}.`,
      'workerCompactionMode ("off"|"acp_control_command", optional): semantic ACP-thread compaction strategy; defaults to acp_control_command.',
      `workerCompactionAfterRound (number, optional): first round that may trigger ACP-thread compaction; defaults to ${DEFAULT_WORKER_COMPACTION_AFTER_ROUND}.`,
    ],
    artifactContract: [
      "round-<n>-codex.txt: raw Codex worker output per round.",
      "round-<n>-controller.txt: raw controller output per round, including normalized decision block.",
      "run-summary.txt: terminal summary with final status, reason, and session keys.",
    ],
  },
  async start(request, ctx: WorkflowModuleContext) {
    const input = normalizeInput(request);
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

    let nextInstruction: string[] = [];
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
        });
        if (compacted) {
          sessions.extras = { ...sessions.extras, lastCompactedBeforeRound: String(round) };
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

      const controllerMessage = buildControllerPrompt({
        controllerPrompt,
        input,
        round,
        maxRounds: input.maxRetries,
        workerOutput: codexResult.text,
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
      if (nextInstruction.length === 0) {
        throw new Error(
          `Controller returned CONTINUE without actionable NEXT_INSTRUCTION in round ${round}.`,
        );
      }
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
  },
};
