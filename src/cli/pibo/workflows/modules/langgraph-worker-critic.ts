import { runWorkflowAgentOnSession } from "../agent-runtime.js";
import { ensureWorkflowSessions } from "../managed-session-adapter.js";
import { writeWorkflowArtifact } from "../store.js";
import type {
  WorkflowModule,
  WorkflowModuleContext,
  WorkflowRunRecord,
  WorkflowStartRequest,
} from "../types.js";

interface WorkerCriticInput {
  task: string;
  successCriteria: string[];
  contextNotes: string[];
  deliverables: string[];
  workerAgentId: string;
  criticAgentId: string;
  workerModel?: string;
  criticModel?: string;
  criticPromptAddendum?: string;
}

interface CriticVerdict {
  verdict: "APPROVE" | "REVISE" | "BLOCK";
  reason: string[];
  gaps: string[];
  revisionRequest: string[];
  raw: string;
}

function toBulletLines(values: string[]) {
  if (values.length === 0) {
    return "- none";
  }
  return values.map((value) => `- ${value}`).join("\n");
}

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

function normalizeInput(input: unknown): WorkerCriticInput {
  if (!input || typeof input !== "object") {
    throw new Error("langgraph_worker_critic erwartet ein JSON-Objekt als Input.");
  }

  const record = input as Record<string, unknown>;
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) {
    throw new Error("langgraph_worker_critic benötigt ein nicht-leeres Feld `task`.");
  }

  const successCriteria = normalizeStringArray(record.successCriteria);
  if (successCriteria.length === 0) {
    throw new Error(
      "langgraph_worker_critic benötigt mindestens ein Erfolgskriterium in `successCriteria`.",
    );
  }

  return {
    task,
    successCriteria,
    contextNotes: normalizeStringArray(record.contextNotes),
    deliverables: normalizeStringArray(record.deliverables),
    workerAgentId: normalizeOptionalString(record.workerAgentId) ?? "langgraph",
    criticAgentId: normalizeOptionalString(record.criticAgentId) ?? "critic",
    workerModel: normalizeOptionalString(record.workerModel),
    criticModel: normalizeOptionalString(record.criticModel),
    criticPromptAddendum: normalizeOptionalString(record.criticPromptAddendum),
  };
}

function parseSection(raw: string, section: string) {
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
    .filter(Boolean);
}

function parseCriticVerdict(raw: string): CriticVerdict {
  const verdictMatch = raw.match(/VERDICT:\s*(APPROVE|REVISE|BLOCK)/);
  if (!verdictMatch) {
    throw new Error(
      `Critic verdict unparsbar. Erwartet wurde 'VERDICT: APPROVE|REVISE|BLOCK'.\n\n${raw}`,
    );
  }

  return {
    verdict: verdictMatch[1] as CriticVerdict["verdict"],
    reason: parseSection(raw, "REASON"),
    gaps: parseSection(raw, "GAPS"),
    revisionRequest: parseSection(raw, "REVISION_REQUEST"),
    raw,
  };
}

function buildWorkerPrompt(params: {
  input: WorkerCriticInput;
  round: number;
  maxRounds: number;
  originalTask: string;
  currentTask: string;
  revisionRequest: string[];
}) {
  return [
    "You are the worker agent in a controlled worker/critic workflow.",
    `Current round: ${params.round}/${params.maxRounds}.`,
    "",
    "ORIGINAL_TASK:",
    params.originalTask,
    "",
    "CURRENT_TASK:",
    params.currentTask,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.input.successCriteria),
    "",
    "DELIVERABLES:",
    toBulletLines(params.input.deliverables),
    "",
    "CONTEXT_NOTES:",
    toBulletLines(params.input.contextNotes),
    "",
    "REVISION_REQUEST_FROM_CRITIC:",
    toBulletLines(params.revisionRequest),
    "",
    "Produce a reviewable result that directly addresses the current task and success criteria.",
    "Be concrete. Do not explain your role. Do not add social padding.",
  ].join("\n");
}

function buildCriticPrompt(params: {
  input: WorkerCriticInput;
  round: number;
  maxRounds: number;
  originalTask: string;
  currentTask: string;
  workerOutput: string;
}) {
  return [
    "You are the critic in a controlled worker/critic workflow.",
    "Review the worker result strictly against the original task, current task, and success criteria.",
    `Current round: ${params.round}/${params.maxRounds}.`,
    "",
    "ORIGINAL_TASK:",
    params.originalTask,
    "",
    "CURRENT_TASK:",
    params.currentTask,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.input.successCriteria),
    "",
    "DELIVERABLES:",
    toBulletLines(params.input.deliverables),
    "",
    "WORKER_RESULT:",
    params.workerOutput,
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
    "Rules:",
    "- Choose exactly one verdict.",
    "- If APPROVE, keep REVISION_REQUEST empty or write 'none'.",
    "- If REVISE, provide a concrete revision request for the next worker turn.",
    "- If BLOCK, name a real blocker.",
    ...(params.input.criticPromptAddendum
      ? ["", "ADDITIONAL_CRITIC_INSTRUCTIONS:", params.input.criticPromptAddendum]
      : []),
  ].join("\n");
}

function buildRecord(params: {
  runId: string;
  input: WorkerCriticInput;
  sessions: WorkflowRunRecord["sessions"];
  status: WorkflowRunRecord["status"];
  terminalReason: string | null;
  currentRound: number;
  maxRounds: number;
  artifacts: string[];
  latestWorkerOutput: string | null;
  latestCriticVerdict: string | null;
  originalTask: string;
  currentTask: string;
  createdAt: string;
  updatedAt: string;
}): WorkflowRunRecord {
  return {
    runId: params.runId,
    moduleId: "langgraph_worker_critic",
    status: params.status,
    terminalReason: params.terminalReason,
    currentRound: params.currentRound,
    maxRounds: params.maxRounds,
    input: params.input,
    artifacts: [...params.artifacts],
    sessions: params.sessions,
    latestWorkerOutput: params.latestWorkerOutput,
    latestCriticVerdict: params.latestCriticVerdict,
    originalTask: params.originalTask,
    currentTask: params.currentTask,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

async function start(
  request: WorkflowStartRequest,
  ctx: WorkflowModuleContext,
): Promise<WorkflowRunRecord> {
  const input = normalizeInput(request.input);
  const createdAt = ctx.nowIso();
  const maxRounds = request.maxRounds && request.maxRounds > 0 ? request.maxRounds : 2;
  const artifacts: string[] = [];
  let latestWorkerOutput: string | null = null;
  let latestCriticVerdict: string | null = null;
  let terminalReason: string | null = null;
  let status: WorkflowRunRecord["status"] = "running";
  let currentTask = input.task;
  let revisionRequest: string[] = [];

  const sessions = await ensureWorkflowSessions({
    runId: ctx.runId,
    specs: [
      {
        role: "worker",
        agentId: input.workerAgentId,
        label: `Workflow ${ctx.runId} Worker`,
        name: "main",
        model: input.workerModel,
        policy: "reset-on-reuse",
      },
      {
        role: "critic",
        agentId: input.criticAgentId,
        label: `Workflow ${ctx.runId} Critic`,
        name: "main",
        model: input.criticModel,
        policy: "reset-on-reuse",
      },
    ],
  });

  const persist = (next: {
    status?: WorkflowRunRecord["status"];
    terminalReason?: string | null;
    currentRound: number;
    updatedAt?: string;
  }) => {
    ctx.persist(
      buildRecord({
        runId: ctx.runId,
        input,
        sessions,
        status: next.status ?? status,
        terminalReason: next.terminalReason === undefined ? terminalReason : next.terminalReason,
        currentRound: next.currentRound,
        maxRounds,
        artifacts,
        latestWorkerOutput,
        latestCriticVerdict,
        originalTask: input.task,
        currentTask,
        createdAt,
        updatedAt: next.updatedAt ?? ctx.nowIso(),
      }),
    );
  };

  persist({ currentRound: 0, updatedAt: createdAt });

  artifacts.push(
    writeWorkflowArtifact(ctx.runId, "input.json", `${JSON.stringify(input, null, 2)}\n`),
  );
  persist({ currentRound: 0 });

  for (let round = 1; round <= maxRounds; round += 1) {
    const workerPrompt = buildWorkerPrompt({
      input,
      round,
      maxRounds,
      originalTask: input.task,
      currentTask,
      revisionRequest,
    });
    artifacts.push(
      writeWorkflowArtifact(ctx.runId, `worker-round-${round}-prompt.md`, `${workerPrompt}\n`),
    );
    persist({ currentRound: round });

    const workerResult = await runWorkflowAgentOnSession({
      sessionKey: sessions.worker ?? "",
      message: workerPrompt,
      idempotencyKey: `${ctx.runId}:worker:${round}`,
    });
    latestWorkerOutput = workerResult.text;
    artifacts.push(
      writeWorkflowArtifact(ctx.runId, `worker-round-${round}-output.md`, `${workerResult.text}\n`),
    );
    persist({ currentRound: round });

    const criticPrompt = buildCriticPrompt({
      input,
      round,
      maxRounds,
      originalTask: input.task,
      currentTask,
      workerOutput: workerResult.text,
    });
    artifacts.push(
      writeWorkflowArtifact(ctx.runId, `critic-round-${round}-prompt.md`, `${criticPrompt}\n`),
    );
    persist({ currentRound: round });

    const criticResult = await runWorkflowAgentOnSession({
      sessionKey: sessions.critic ?? "",
      message: criticPrompt,
      idempotencyKey: `${ctx.runId}:critic:${round}`,
    });
    latestCriticVerdict = criticResult.text;
    artifacts.push(
      writeWorkflowArtifact(ctx.runId, `critic-round-${round}-output.md`, `${criticResult.text}\n`),
    );

    const verdict = parseCriticVerdict(criticResult.text);
    revisionRequest = verdict.revisionRequest.filter((entry) => entry.toLowerCase() !== "none");

    if (verdict.verdict === "APPROVE") {
      status = "done";
      terminalReason = verdict.reason[0] || "Critic approved the worker result.";
      persist({ status, terminalReason, currentRound: round });
      return buildRecord({
        runId: ctx.runId,
        input,
        sessions,
        status,
        terminalReason,
        currentRound: round,
        maxRounds,
        artifacts,
        latestWorkerOutput,
        latestCriticVerdict,
        originalTask: input.task,
        currentTask,
        createdAt,
        updatedAt: ctx.nowIso(),
      });
    }

    if (verdict.verdict === "BLOCK") {
      status = "blocked";
      terminalReason = verdict.reason[0] || verdict.gaps[0] || "Critic blocked the run.";
      persist({ status, terminalReason, currentRound: round });
      return buildRecord({
        runId: ctx.runId,
        input,
        sessions,
        status,
        terminalReason,
        currentRound: round,
        maxRounds,
        artifacts,
        latestWorkerOutput,
        latestCriticVerdict,
        originalTask: input.task,
        currentTask,
        createdAt,
        updatedAt: ctx.nowIso(),
      });
    }

    if (revisionRequest.length === 0) {
      status = "failed";
      terminalReason = "Critic returned REVISE without a usable REVISION_REQUEST payload.";
      persist({ status, terminalReason, currentRound: round });
      return buildRecord({
        runId: ctx.runId,
        input,
        sessions,
        status,
        terminalReason,
        currentRound: round,
        maxRounds,
        artifacts,
        latestWorkerOutput,
        latestCriticVerdict,
        originalTask: input.task,
        currentTask,
        createdAt,
        updatedAt: ctx.nowIso(),
      });
    }

    currentTask = revisionRequest.join("\n");
    persist({ currentRound: round });
  }

  status = "max_rounds_reached";
  terminalReason = "Critic kept requesting revisions until the round limit was reached.";
  persist({ status, terminalReason, currentRound: maxRounds });
  return buildRecord({
    runId: ctx.runId,
    input,
    sessions,
    status,
    terminalReason,
    currentRound: maxRounds,
    maxRounds,
    artifacts,
    latestWorkerOutput,
    latestCriticVerdict,
    originalTask: input.task,
    currentTask,
    createdAt,
    updatedAt: ctx.nowIso(),
  });
}

export const langgraphWorkerCriticModule: WorkflowModule = {
  manifest: {
    moduleId: "langgraph_worker_critic",
    displayName: "LangGraph Worker/Critic",
    description:
      "Führt einen expliziten Worker/Critic-Loop mit `langgraph` als Worker und `critic` als Review-Agent aus.",
    kind: "agent_workflow",
    version: "2.0.0",
    requiredAgents: ["langgraph", "critic"],
    terminalStates: ["done", "blocked", "failed", "aborted", "max_rounds_reached"],
    supportsAbort: false,
    inputSchemaSummary: [
      "task: string (pflichtig)",
      "successCriteria: string[] (mindestens ein Eintrag)",
      "optional: contextNotes, deliverables, workerAgentId, criticAgentId",
      "optional: workerModel, criticModel (als provider/model)",
      "optional: criticPromptAddendum (wird additiv an den Critic-Prompt angehängt)",
    ],
    artifactContract: [
      "input.json",
      "worker/critic prompt- und output-Dateien pro Runde unter ~/.local/state/pibo-workflows/artifacts/<runId>/",
      "Workflow-Run speichert zusätzlich die Worker-/Critic-Session-Keys im Run-Record",
    ],
  },
  start,
};
