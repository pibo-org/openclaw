import { existsSync, readFileSync } from "node:fs";
import { getAcpSessionManager } from "../../../../acp/control-plane/manager.js";
import type { AcpRuntimeEvent } from "../../../../acp/runtime/types.js";
import { loadConfig } from "../../../../config/config.js";
import { runWorkflowAgentOnSession } from "../agent-runtime.js";
import { ensureWorkflowSessions } from "../managed-session-adapter.js";
import { writeWorkflowArtifact } from "../store.js";
import type { WorkflowModule, WorkflowRunRecord, WorkflowStartRequest } from "../types.js";

type CodexControllerInput = {
  task: string;
  workingDirectory: string;
  maxRetries?: number;
  successCriteria: string[];
  constraints: string[];
  codexAgentId: string;
  controllerAgentId: string;
  controllerPromptPath: string;
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
const ACP_COMPACT_AFTER_ROUND = 3;

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
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
    typeof record.maxRetries === "number" && Number.isFinite(record.maxRetries)
      ? Math.max(1, Math.floor(record.maxRetries))
      : typeof request.maxRounds === "number" && Number.isFinite(request.maxRounds)
        ? Math.max(1, Math.floor(request.maxRounds))
        : DEFAULT_MAX_ROUNDS;
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
  const pattern = new RegExp(`${section}:\\n([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`);
  const match = normalized.match(pattern);
  if (!match) {
    return [];
  }
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter((line) => line && line.toLowerCase() !== "none");
}

function parseControllerDecision(raw: string): ControllerDecision {
  const decisionMatch = raw.match(/DECISION:\s*(CONTINUE|ESCALATE_BLOCKED|DONE)/);
  if (!decisionMatch) {
    throw new Error(
      `Controller-Entscheidung unparsbar. Erwartet wurde 'DECISION: CONTINUE|ESCALATE_BLOCKED|DONE'.\n\n${raw}`,
    );
  }
  return {
    decision: decisionMatch[1] as ControllerDecision["decision"],
    reason: parseSection(raw, "REASON"),
    nextInstruction: parseSection(raw, "NEXT_INSTRUCTION"),
    blocker: parseSection(raw, "BLOCKER"),
    raw,
  };
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
    "Your job is to replace routine user nudges and only escalate if there is a real blocker or the loop is exhausted.",
    "Return exactly this format:",
    "DECISION: CONTINUE | ESCALATE_BLOCKED | DONE",
    "REASON:",
    "- ...",
    "NEXT_INSTRUCTION:",
    "- ...",
    "BLOCKER:",
    "- ...",
    "",
    "Rules:",
    "- CONTINUE: Codex should keep going immediately; provide a concrete next instruction.",
    "- DONE: task is sufficiently complete against the original request and success criteria.",
    "- ESCALATE_BLOCKED: only if there is a real blocker that needs the user/operator.",
    "- If DECISION is DONE or ESCALATE_BLOCKED, NEXT_INSTRUCTION may be empty.",
    "- If DECISION is CONTINUE, NEXT_INSTRUCTION must be concrete and actionable.",
    "- Never ask for routine confirmation.",
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
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

async function runCodexTurn(params: {
  sessionKey: string;
  workingDirectory: string;
  agentId: string;
  text: string;
  requestId: string;
}): Promise<{ text: string; outputEvents: string[]; rawEvents: AcpRuntimeEvent[] }> {
  const cfg = loadConfig();
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
  sessionKey: string;
  workingDirectory: string;
  agentId: string;
  round: number;
  task: string;
}) {
  if (params.round < ACP_COMPACT_AFTER_ROUND) {
    return false;
  }
  const cfg = loadConfig();
  const manager = getAcpSessionManager();
  await manager.initializeSession({
    cfg,
    sessionKey: params.sessionKey,
    agent: params.agentId,
    mode: "persistent",
    cwd: params.workingDirectory,
  });
  await manager.runTurn({
    cfg,
    sessionKey: params.sessionKey,
    text: `/compact Focus on the original task, current code changes, remaining gaps, and blocker state for: ${params.task}`,
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
      "Runs a Codex ACP worker under a controller loop that only escalates real blockers or exhausted retries.",
    kind: "agent_workflow",
    version: "0.1.0",
    requiredAgents: ["codex", "langgraph"],
    terminalStates: ["done", "blocked", "aborted", "max_rounds_reached", "failed"],
    supportsAbort: false,
    inputSchemaSummary: [
      "task (string, required): original coding task passed directly to Codex.",
      "workingDirectory (string, required): absolute workspace path for the Codex ACP session.",
      "maxRetries|maxRounds (number, optional): controller loop budget; defaults to 6.",
      "successCriteria (string[], optional): additional completion criteria.",
      "constraints (string[], optional): extra constraints to keep in every turn.",
      `controllerPromptPath (string, optional): defaults to ${DEFAULT_CONTROLLER_PROMPT_PATH}.`,
    ],
    artifactContract: [
      "round-<n>-codex.txt: raw Codex worker output per round.",
      "round-<n>-controller.txt: parsed controller decision source per round.",
      "run-summary.txt: terminal summary with final status and reason.",
    ],
  },
  async start(request, ctx) {
    const input = normalizeInput(request);
    const createdAt = ctx.nowIso();
    const controllerPrompt = loadControllerPrompt(input.controllerPromptPath);
    const sessions = await ensureWorkflowSessions({
      runId: ctx.runId,
      specs: [
        {
          role: "orchestrator",
          agentId: input.controllerAgentId,
          label: "codex-controller-controller",
        },
      ],
    });
    const codexSessionKey = `agent:${input.codexAgentId}:acp:pibo:workflow:${ctx.runId}:worker:codex`;
    sessions.worker = codexSessionKey;
    sessions.extras = {
      ...sessions.extras,
      codexWorkerRuntime: "acp",
      workingDirectory: input.workingDirectory,
      controllerPromptPath: input.controllerPromptPath,
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
    });
    ctx.persist(record);

    let nextInstruction: string[] = [];

    for (let round = 1; round <= input.maxRetries; round += 1) {
      if (round > 1) {
        const compacted = await maybeCompactCodexSession({
          sessionKey: codexSessionKey,
          workingDirectory: input.workingDirectory,
          agentId: input.codexAgentId,
          round,
          task: input.task,
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
      });
      ctx.persist(record);

      const controllerMessage = buildControllerPrompt({
        controllerPrompt,
        input,
        round,
        maxRounds: input.maxRetries,
        workerOutput: codexResult.text,
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
        });
      }

      nextInstruction = decision.nextInstruction;
      if (nextInstruction.length === 0) {
        throw new Error(`Controller returned CONTINUE without NEXT_INSTRUCTION in round ${round}.`);
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
    });
  },
};
