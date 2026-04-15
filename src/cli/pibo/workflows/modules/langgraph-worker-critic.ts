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
import { langgraphWorkerCriticModuleManifest } from "./manifests.js";

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

function buildApprovedCompletionMessage(params: {
  workerOutput: string;
  verdict: CriticVerdict;
  round: number;
  maxRounds: number;
}): string {
  return [
    "Final result:",
    params.workerOutput,
    "",
    `Critic verdict: ${params.verdict.verdict}`,
    `Round: ${params.round}/${params.maxRounds}`,
    ...(params.verdict.reason.length
      ? ["", "Approval reason:", ...params.verdict.reason.map((line) => `- ${line}`)]
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
  origin?: WorkflowRunRecord["origin"];
  reporting?: WorkflowRunRecord["reporting"];
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
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.reporting ? { reporting: params.reporting } : {}),
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  };
}

function stepIdForRound(round: number): string {
  return `round-${round}`;
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
        origin: request.origin,
        reporting: request.reporting,
        createdAt,
        updatedAt: next.updatedAt ?? ctx.nowIso(),
      }),
    );
  };

  persist({ currentRound: 0, updatedAt: createdAt });
  ctx.trace.emit({
    kind: "run_started",
    stepId: "run",
    status: "running",
    summary: "Worker/critic workflow started.",
    payload: {
      maxRounds,
      workerAgentId: input.workerAgentId,
      criticAgentId: input.criticAgentId,
      successCriteriaCount: input.successCriteria.length,
    },
  });

  const inputArtifact = writeWorkflowArtifact(
    ctx.runId,
    "input.json",
    `${JSON.stringify(input, null, 2)}\n`,
  );
  artifacts.push(inputArtifact);
  emitArtifactWritten({
    artifactPath: inputArtifact,
    summary: "workflow input written",
  });
  persist({ currentRound: 0 });
  await emitTracedWorkflowReportEvent({
    trace: ctx.trace,
    stepId: "run",
    moduleId: "langgraph_worker_critic",
    runId: ctx.runId,
    phase: "run_started",
    eventType: "started",
    messageText: [
      `Task: ${input.task}`,
      `Success criteria: ${input.successCriteria.length}`,
      ...(input.deliverables.length ? [`Deliverables: ${input.deliverables.join("; ")}`] : []),
    ].join("\n"),
    emittingAgentId: input.workerAgentId,
    origin: request.origin,
    reporting: request.reporting,
    status: "running",
    role: "worker",
    targetSessionKey: sessions.worker,
  });

  for (let round = 1; round <= maxRounds; round += 1) {
    const stepId = stepIdForRound(round);
    ctx.trace.emit({
      kind: "round_started",
      stepId,
      round,
      status: "running",
      summary: `Round ${round} started.`,
    });
    const workerPrompt = buildWorkerPrompt({
      input,
      round,
      maxRounds,
      originalTask: input.task,
      currentTask,
      revisionRequest,
    });
    const workerPromptArtifact = writeWorkflowArtifact(
      ctx.runId,
      `worker-round-${round}-prompt.md`,
      `${workerPrompt}\n`,
    );
    artifacts.push(workerPromptArtifact);
    emitArtifactWritten({
      artifactPath: workerPromptArtifact,
      summary: "worker prompt written",
      round,
      role: "worker",
    });
    persist({ currentRound: round });

    ctx.trace.emit({
      kind: "role_turn_started",
      stepId,
      round,
      role: "worker",
      sessionKey: sessions.worker,
      agentId: input.workerAgentId,
      summary: "worker turn started",
    });
    const workerResult = await runWorkflowAgentOnSession({
      sessionKey: sessions.worker ?? "",
      message: workerPrompt,
      idempotencyKey: `${ctx.runId}:worker:${round}`,
    });
    latestWorkerOutput = workerResult.text;
    const workerOutputArtifact = writeWorkflowArtifact(
      ctx.runId,
      `worker-round-${round}-output.md`,
      `${workerResult.text}\n`,
    );
    artifacts.push(workerOutputArtifact);
    emitArtifactWritten({
      artifactPath: workerOutputArtifact,
      summary: "worker output written",
      round,
      role: "worker",
    });
    ctx.trace.emit({
      kind: "role_turn_completed",
      stepId,
      round,
      role: "worker",
      sessionKey: sessions.worker,
      agentId: input.workerAgentId,
      summary: "worker output captured",
      payload: {
        outputLength: workerResult.text.length,
      },
    });
    persist({ currentRound: round });

    const criticPrompt = buildCriticPrompt({
      input,
      round,
      maxRounds,
      originalTask: input.task,
      currentTask,
      workerOutput: workerResult.text,
    });
    const criticPromptArtifact = writeWorkflowArtifact(
      ctx.runId,
      `critic-round-${round}-prompt.md`,
      `${criticPrompt}\n`,
    );
    artifacts.push(criticPromptArtifact);
    emitArtifactWritten({
      artifactPath: criticPromptArtifact,
      summary: "critic prompt written",
      round,
      role: "critic",
    });
    persist({ currentRound: round });

    ctx.trace.emit({
      kind: "role_turn_started",
      stepId,
      round,
      role: "critic",
      sessionKey: sessions.critic,
      agentId: input.criticAgentId,
      summary: "critic turn started",
    });
    const criticResult = await runWorkflowAgentOnSession({
      sessionKey: sessions.critic ?? "",
      message: criticPrompt,
      idempotencyKey: `${ctx.runId}:critic:${round}`,
    });
    latestCriticVerdict = criticResult.text;
    const criticOutputArtifact = writeWorkflowArtifact(
      ctx.runId,
      `critic-round-${round}-output.md`,
      `${criticResult.text}\n`,
    );
    artifacts.push(criticOutputArtifact);
    emitArtifactWritten({
      artifactPath: criticOutputArtifact,
      summary: "critic output written",
      round,
      role: "critic",
    });
    ctx.trace.emit({
      kind: "role_turn_completed",
      stepId,
      round,
      role: "critic",
      sessionKey: sessions.critic,
      agentId: input.criticAgentId,
      summary: "critic verdict captured",
      payload: {
        outputLength: criticResult.text.length,
      },
    });

    const verdict = parseCriticVerdict(criticResult.text);
    revisionRequest = verdict.revisionRequest.filter((entry) => entry.toLowerCase() !== "none");

    if (verdict.verdict === "APPROVE") {
      status = "done";
      terminalReason = verdict.reason[0] || "Critic approved the worker result.";
      persist({ status, terminalReason, currentRound: round });
      ctx.trace.emit({
        kind: "run_completed",
        stepId,
        round,
        role: "critic",
        status: "done",
        summary: terminalReason,
        payload: {
          verdict: verdict.verdict,
        },
      });
      await emitTracedWorkflowReportEvent({
        trace: ctx.trace,
        stepId,
        moduleId: "langgraph_worker_critic",
        runId: ctx.runId,
        phase: "workflow_done",
        eventType: "completed",
        messageText: buildApprovedCompletionMessage({
          workerOutput: workerResult.text,
          verdict,
          round,
          maxRounds,
        }),
        emittingAgentId: input.criticAgentId,
        origin: request.origin,
        reporting: request.reporting,
        status: "done",
        role: "critic",
        round,
        targetSessionKey: sessions.critic,
      });
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
        origin: request.origin,
        reporting: request.reporting,
        createdAt,
        updatedAt: ctx.nowIso(),
      });
    }

    if (verdict.verdict === "BLOCK") {
      status = "blocked";
      terminalReason = verdict.reason[0] || verdict.gaps[0] || "Critic blocked the run.";
      persist({ status, terminalReason, currentRound: round });
      ctx.trace.emit({
        kind: "run_blocked",
        stepId,
        round,
        role: "critic",
        status: "blocked",
        summary: terminalReason,
        payload: {
          verdict: verdict.verdict,
        },
      });
      await emitTracedWorkflowReportEvent({
        trace: ctx.trace,
        stepId,
        moduleId: "langgraph_worker_critic",
        runId: ctx.runId,
        phase: "workflow_blocked",
        eventType: "blocked",
        messageText: criticResult.text,
        emittingAgentId: input.criticAgentId,
        origin: request.origin,
        reporting: request.reporting,
        status: "blocked",
        role: "critic",
        round,
        targetSessionKey: sessions.critic,
      });
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
        origin: request.origin,
        reporting: request.reporting,
        createdAt,
        updatedAt: ctx.nowIso(),
      });
    }

    if (revisionRequest.length === 0) {
      status = "failed";
      terminalReason = "Critic returned REVISE without a usable REVISION_REQUEST payload.";
      persist({ status, terminalReason, currentRound: round });
      ctx.trace.emit({
        kind: "run_failed",
        stepId,
        round,
        role: "critic",
        status: "failed",
        summary: terminalReason,
        payload: {
          verdict: verdict.verdict,
        },
      });
      await emitTracedWorkflowReportEvent({
        trace: ctx.trace,
        stepId,
        moduleId: "langgraph_worker_critic",
        runId: ctx.runId,
        phase: "workflow_blocked",
        eventType: "blocked",
        messageText: criticResult.text,
        emittingAgentId: input.criticAgentId,
        origin: request.origin,
        reporting: request.reporting,
        status: "failed",
        role: "critic",
        round,
        targetSessionKey: sessions.critic,
      });
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
        origin: request.origin,
        reporting: request.reporting,
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
  ctx.trace.emit({
    kind: "run_blocked",
    stepId: stepIdForRound(maxRounds),
    round: maxRounds,
    role: "critic",
    status: "max_rounds_reached",
    summary: terminalReason,
  });
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
    origin: request.origin,
    reporting: request.reporting,
    createdAt,
    updatedAt: ctx.nowIso(),
  });
}

export const langgraphWorkerCriticModule: WorkflowModule = {
  manifest: langgraphWorkerCriticModuleManifest,
  start,
};
