import crypto from "node:crypto";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import {
  createWorkflowAbortError,
  isWorkflowAbortError,
  throwIfWorkflowAbortRequested,
  workflowAbortReasonFromError,
} from "./abort.js";
import { getWorkflowModule, listWorkflowModules } from "./modules/index.js";
import {
  listRunRecords,
  readRunRecord,
  workflowArtifactPath,
  workflowArtifactsDir,
  writeRunRecord,
} from "./store.js";
import {
  buildWorkflowTraceRef,
  createWorkflowTraceRuntime,
  deriveWorkflowTraceSummaryFromRun,
  readWorkflowTraceEvents,
  readWorkflowTraceSummary,
} from "./tracing/runtime.js";
import type {
  WorkflowTraceEvent,
  WorkflowTraceEventQuery,
  WorkflowTraceSummary,
} from "./tracing/types.js";
import { buildTrustedWorkflowContext } from "./trusted-context.js";
import type {
  WorkflowArtifactContent,
  WorkflowArtifactInfo,
  WorkflowModuleManifest,
  WorkflowModuleContext,
  WorkflowProgressSnapshot,
  WorkflowReportingConfig,
  WorkflowRunRecord,
  WorkflowStartRequest,
  WorkflowTerminalState,
  WorkflowWaitResult,
} from "./types.js";
import { emitTracedWorkflowReportEvent } from "./workflow-reporting.js";

type ActiveWorkflowRunHandle = {
  promise: Promise<WorkflowRunRecord>;
  abortController: AbortController;
};

const activeWorkflowRuns = new Map<string, ActiveWorkflowRunHandle>();
const WORKFLOW_WAIT_POLL_MS = 250;
const DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS = 120_000;

function nowIso() {
  return new Date().toISOString();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJsonArg(raw?: string): unknown {
  if (!raw) {
    return {};
  }
  if (raw.startsWith("@")) {
    return JSON.parse(readFileSync(raw.slice(1), "utf8"));
  }
  return JSON.parse(raw);
}

async function readMaybeStdin(enabled?: boolean): Promise<unknown> {
  if (!enabled) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function printJson(payload: unknown) {
  console.log(JSON.stringify(payload, null, 2));
}

function printModuleSummary(modules: WorkflowModuleManifest[]) {
  for (const module of modules) {
    console.log(`- ${module.moduleId}: ${module.description}`);
  }
}

function terminalStatesText(states: WorkflowTerminalState[]) {
  return states.join(", ");
}

function readPositiveNumberOption(raw?: string) {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

type TrustedWorkflowMutationCliOptions = {
  ownerSessionKey?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

function requireNonEmptyCliOption(value: string | undefined, flag: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${flag} is required`);
  }
  return normalized;
}

function buildWorkflowStartRequestFromCli(
  params: {
    input: unknown;
    maxRounds?: string;
  } & TrustedWorkflowMutationCliOptions,
): WorkflowStartRequest {
  const trustedContext = buildTrustedWorkflowContext({
    ownerSessionKey: requireNonEmptyCliOption(params.ownerSessionKey, "--owner-session-key"),
    channel: requireNonEmptyCliOption(params.channel, "--channel"),
    to: requireNonEmptyCliOption(params.to, "--to"),
    ...(typeof params.accountId === "string" && params.accountId.trim()
      ? { accountId: params.accountId.trim() }
      : {}),
    ...(typeof params.threadId === "string" && params.threadId.trim()
      ? { threadId: params.threadId.trim() }
      : {}),
  });
  return {
    input: params.input,
    maxRounds: readPositiveNumberOption(params.maxRounds),
    origin: trustedContext.origin,
    reporting: trustedContext.reporting,
  };
}

function artifactNameFromPath(artifactPath?: string | null) {
  return artifactPath ? path.basename(artifactPath) : null;
}

function isTerminalStatus(status: WorkflowRunRecord["status"]) {
  return (
    status === "done" ||
    status === "planning_done" ||
    status === "blocked" ||
    status === "aborted" ||
    status === "failed" ||
    status === "max_rounds_reached"
  );
}

function markAbortRequested(record: WorkflowRunRecord, requestedAt = nowIso()): WorkflowRunRecord {
  if (record.abortRequested && record.abortRequestedAt) {
    return record;
  }
  return {
    ...record,
    abortRequested: true,
    abortRequestedAt: requestedAt,
    updatedAt: requestedAt,
  };
}

function startedReportWasAttempted(runId: string): boolean {
  return readWorkflowTraceEvents(runId, { kind: "report_delivery_attempted" }).some((event) => {
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as { eventType?: unknown; phase?: unknown })
        : null;
    return payload?.eventType === "started" || payload?.phase === "run_started";
  });
}

function ensureFailureReporting(
  reporting?: WorkflowReportingConfig,
): WorkflowReportingConfig | undefined {
  if (!reporting) {
    return undefined;
  }
  const events = new Set(reporting.events ?? []);
  events.add("blocked");
  return {
    ...reporting,
    events: [...events],
  };
}

function buildEarlyStartFailureMessage(params: {
  moduleId: string;
  runId: string;
  terminalReason: string;
}): string {
  return [
    "Workflow start failed before the regular workflow start/reporting path began.",
    `Module: ${params.moduleId}`,
    `Run: ${params.runId}`,
    `Reason: ${params.terminalReason}`,
  ].join("\n");
}

function buildPostStartFailureMessage(params: {
  moduleId: string;
  runId: string;
  terminalReason: string;
}): string {
  return [
    "Workflow failed after the regular start/reporting path and has reached terminal failure state.",
    `Module: ${params.moduleId}`,
    `Run: ${params.runId}`,
    `Reason: ${params.terminalReason}`,
  ].join("\n");
}

function buildFailedWorkflowRunRecord(params: {
  terminalReason: string;
  tracer: ReturnType<typeof createWorkflowTraceRuntime>;
  persistedRecord: WorkflowRunRecord;
}): WorkflowRunRecord {
  const updatedAt = nowIso();
  const persisted = params.persistedRecord;
  return {
    runId: persisted.runId,
    moduleId: persisted.moduleId,
    status: "failed",
    terminalReason: params.terminalReason,
    abortRequested: persisted.abortRequested,
    abortRequestedAt: persisted.abortRequestedAt,
    currentRound: persisted.currentRound,
    maxRounds: persisted.maxRounds,
    input: persisted.input,
    artifacts: persisted.artifacts,
    sessions: persisted.sessions,
    latestWorkerOutput: persisted.latestWorkerOutput,
    latestCriticVerdict: persisted.latestCriticVerdict,
    originalTask: persisted.originalTask,
    currentTask: persisted.currentTask,
    ...(persisted.origin ? { origin: persisted.origin } : {}),
    ...(persisted.reporting ? { reporting: persisted.reporting } : {}),
    trace: params.tracer.getRef(updatedAt),
    createdAt: persisted.createdAt,
    updatedAt,
  };
}

function buildAbortedWorkflowRunRecord(params: {
  terminalReason: string;
  tracer: ReturnType<typeof createWorkflowTraceRuntime>;
  persistedRecord: WorkflowRunRecord;
}): WorkflowRunRecord {
  const updatedAt = nowIso();
  const persisted = markAbortRequested(params.persistedRecord, persistedAbortRequestedAt(params));
  return {
    runId: persisted.runId,
    moduleId: persisted.moduleId,
    status: "aborted",
    terminalReason: params.terminalReason,
    abortRequested: true,
    abortRequestedAt: persisted.abortRequestedAt,
    currentRound: persisted.currentRound,
    maxRounds: persisted.maxRounds,
    input: persisted.input,
    artifacts: persisted.artifacts,
    sessions: persisted.sessions,
    latestWorkerOutput: persisted.latestWorkerOutput,
    latestCriticVerdict: persisted.latestCriticVerdict,
    originalTask: persisted.originalTask,
    currentTask: persisted.currentTask,
    ...(persisted.origin ? { origin: persisted.origin } : {}),
    ...(persisted.reporting ? { reporting: persisted.reporting } : {}),
    trace: params.tracer.getRef(updatedAt),
    createdAt: persisted.createdAt,
    updatedAt,
  };
}

function persistedAbortRequestedAt(params: { persistedRecord: WorkflowRunRecord }) {
  return params.persistedRecord.abortRequestedAt ?? nowIso();
}

async function emitVisibleFailureAnnouncement(params: {
  runId: string;
  moduleId: string;
  tracer: ReturnType<typeof createWorkflowTraceRuntime>;
  terminalReason: string;
  persistedRecord: WorkflowRunRecord;
}) {
  const startedReportAttempted = startedReportWasAttempted(params.runId);
  const targetSessionKey =
    params.persistedRecord.sessions.orchestrator ?? params.persistedRecord.origin?.ownerSessionKey;
  const emittingAgentId = resolveAgentIdFromSessionKey(targetSessionKey);
  await emitTracedWorkflowReportEvent({
    trace: params.tracer,
    stepId: "run",
    moduleId: params.moduleId,
    runId: params.runId,
    phase: startedReportAttempted ? "workflow_failed" : "run_start_failed",
    eventType: "blocked",
    messageText: startedReportAttempted
      ? buildPostStartFailureMessage({
          moduleId: params.moduleId,
          runId: params.runId,
          terminalReason: params.terminalReason,
        })
      : buildEarlyStartFailureMessage({
          moduleId: params.moduleId,
          runId: params.runId,
          terminalReason: params.terminalReason,
        }),
    emittingAgentId,
    origin: params.persistedRecord.origin,
    reporting: ensureFailureReporting(params.persistedRecord.reporting),
    status: "failed",
    role: "orchestrator",
    targetSessionKey,
    traceSummary: startedReportAttempted
      ? "terminal failure announcement attempted"
      : "early start failure announcement attempted",
  });
}

function printStatusText(record: WorkflowRunRecord) {
  console.log(`Run: ${record.runId}`);
  console.log(`Module: ${record.moduleId}`);
  console.log(`Status: ${record.status}`);
  console.log(`Created: ${record.createdAt}`);
  console.log(`Updated: ${record.updatedAt}`);
  console.log(`Abort requested: ${record.abortRequested ? "yes" : "no"}`);
  console.log(`Abort requested at: ${record.abortRequestedAt ?? "n/a"}`);
  console.log(`Current round: ${record.currentRound}`);
  console.log(`Max rounds: ${record.maxRounds ?? "n/a"}`);
  console.log(`Terminal reason: ${record.terminalReason ?? "n/a"}`);
  console.log(`Artifacts: ${record.artifacts.length}`);
  if (record.originalTask) {
    console.log(`Original task: ${record.originalTask}`);
  }
  if (record.currentTask) {
    console.log(`Current task: ${record.currentTask}`);
  }
  const sessionEntries: Array<[string, string]> = [];
  if (record.sessions.orchestrator) {
    sessionEntries.push(["orchestrator", record.sessions.orchestrator]);
  }
  if (record.sessions.worker) {
    sessionEntries.push(["worker", record.sessions.worker]);
  }
  if (record.sessions.critic) {
    sessionEntries.push(["critic", record.sessions.critic]);
  }
  sessionEntries.push(...Object.entries(record.sessions.extras ?? {}));
  if (sessionEntries.length === 0) {
    console.log("Sessions: none");
    return;
  }
  console.log("Sessions:");
  for (const [key, value] of sessionEntries) {
    console.log(`- ${key}: ${value}`);
  }
}

function printProgressText(progress: WorkflowProgressSnapshot) {
  console.log(`Run: ${progress.runId}`);
  console.log(`Module: ${progress.moduleId}`);
  console.log(`Status: ${progress.status}`);
  console.log(`Terminal: ${progress.isTerminal ? "yes" : "no"}`);
  console.log(`Abort requested: ${progress.abortRequested ? "yes" : "no"}`);
  console.log(`Abort requested at: ${progress.abortRequestedAt ?? "n/a"}`);
  console.log(`Current round: ${progress.currentRound}`);
  console.log(`Max rounds: ${progress.maxRounds ?? "n/a"}`);
  console.log(`Trace level: ${progress.traceLevel}`);
  console.log(`Events: ${progress.eventCount}`);
  console.log(`Artifacts: ${progress.artifactCount}`);
  console.log(`Active role: ${progress.activeRole ?? "none"}`);
  console.log(`Last completed role: ${progress.lastCompletedRole ?? "n/a"}`);
  console.log(`Last artifact: ${progress.lastArtifactName ?? "n/a"}`);
  console.log(`Last event: ${progress.lastEventKind ?? "n/a"}`);
  console.log(`Last event at: ${progress.lastEventAt ?? "n/a"}`);
  if (progress.lastEventSummary) {
    console.log(`Last event summary: ${progress.lastEventSummary}`);
  }
  if (progress.terminalReason) {
    console.log(`Terminal reason: ${progress.terminalReason}`);
  }
  console.log(`Summary: ${progress.humanSummary}`);
}

function printArtifactListText(artifacts: WorkflowArtifactInfo[]) {
  if (artifacts.length === 0) {
    console.log("Keine Artefakte fuer diesen Run vorhanden.");
    return;
  }
  for (const artifact of artifacts) {
    console.log(
      `- ${artifact.name}  ${artifact.sizeBytes} bytes  ${artifact.updatedAt}  ${artifact.path}`,
    );
  }
}

function printArtifactContentText(artifact: WorkflowArtifactContent) {
  console.log(`Artifact: ${artifact.name}`);
  console.log(`Path: ${artifact.path}`);
  console.log(`Size: ${artifact.sizeBytes} bytes`);
  console.log(`Updated: ${artifact.updatedAt}`);
  console.log(`Mode: ${artifact.mode}`);
  console.log(`Lines: ${artifact.totalLines}`);
  console.log(`Truncated: ${artifact.truncated ? "yes" : "no"}`);
  if (artifact.content.trim()) {
    console.log("");
    console.log(artifact.content);
  }
}

function buildProgressHumanSummary(progress: Omit<WorkflowProgressSnapshot, "humanSummary">) {
  if (progress.status === "pending") {
    if (progress.abortRequested) {
      return "Abort wurde angefordert, bevor der Run gestartet hat.";
    }
    return "Run ist angelegt und wartet auf die eigentliche Ausfuehrung.";
  }
  if (progress.status === "running") {
    if (progress.abortRequested) {
      if (progress.activeRole) {
        return `Abort wurde angefordert; aktive Rolle ${progress.activeRole} wird beendet und es starten keine weiteren Runden.`;
      }
      return "Abort wurde angefordert; der laufende Schritt wird beendet und es starten keine weiteren Runden.";
    }
    if (progress.activeRole) {
      const roundText = progress.currentRound > 0 ? ` Runde ${progress.currentRound}` : "";
      return `Run laeuft${roundText}; aktive Rolle: ${progress.activeRole}.`;
    }
    return "Run laeuft; aktuell keine aktive Rolle aus dem Trace ableitbar.";
  }
  if (progress.status === "done") {
    return `Run erfolgreich abgeschlossen${progress.currentRound > 0 ? ` nach Runde ${progress.currentRound}` : ""}.`;
  }
  if (progress.status === "blocked") {
    return `Run ist blockiert: ${progress.terminalReason ?? "kein Grund im Run-Record"}.`;
  }
  if (progress.status === "failed") {
    return `Run ist fehlgeschlagen: ${progress.terminalReason ?? "kein Fehlertext im Run-Record"}.`;
  }
  if (progress.status === "aborted") {
    return `Run wurde abgebrochen: ${progress.terminalReason ?? "kein Abbruchgrund im Run-Record"}.`;
  }
  return `Run hat die Rundengrenze erreicht${progress.maxRounds ? ` (${progress.maxRounds})` : ""}.`;
}

function isNoisyProgressEvent(event: WorkflowTraceEvent) {
  if (event.kind === "report_delivery_attempted" || event.kind === "report_delivered") {
    return true;
  }
  return event.kind === "report_failed" && event.summary === "event-disabled";
}

export function listWorkflowModuleManifests(): WorkflowModuleManifest[] {
  return listWorkflowModules().map((entry) => entry.manifest);
}

export function describeWorkflowModule(moduleId: string): WorkflowModuleManifest {
  const module = getWorkflowModule(moduleId);
  if (!module) {
    throw new Error(`Workflow-Modul nicht gefunden: ${moduleId}`);
  }
  return module.manifest;
}

export async function startWorkflowRun(
  moduleId: string,
  request: WorkflowStartRequest,
): Promise<WorkflowRunRecord> {
  const runId = crypto.randomUUID();
  return await startWorkflowRunWithRunId(moduleId, request, runId);
}

function buildInitialRunRecord(params: {
  runId: string;
  moduleId: string;
  request: WorkflowStartRequest;
  status: WorkflowRunRecord["status"];
}): WorkflowRunRecord {
  const timestamp = nowIso();
  return {
    runId: params.runId,
    moduleId: params.moduleId,
    status: params.status,
    terminalReason: null,
    abortRequested: false,
    abortRequestedAt: null,
    currentRound: 0,
    maxRounds:
      typeof params.request.maxRounds === "number" && Number.isFinite(params.request.maxRounds)
        ? params.request.maxRounds
        : null,
    input: params.request.input,
    artifacts: [],
    sessions: {},
    latestWorkerOutput: null,
    latestCriticVerdict: null,
    originalTask: null,
    currentTask: null,
    ...(params.request.origin ? { origin: params.request.origin } : {}),
    ...(params.request.reporting ? { reporting: params.request.reporting } : {}),
    trace: buildWorkflowTraceRef({
      runId: params.runId,
      level: 0,
      eventCount: 0,
      updatedAt: timestamp,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function startWorkflowRunWithRunId(
  moduleId: string,
  request: WorkflowStartRequest,
  runId: string,
  opts?: {
    initialPersistedRecord?: WorkflowRunRecord | null;
    abortSignal?: AbortSignal;
  },
): Promise<WorkflowRunRecord> {
  const module = getWorkflowModule(moduleId);
  if (!module) {
    throw new Error(`Workflow-Modul nicht gefunden: ${moduleId}`);
  }

  const tracer = createWorkflowTraceRuntime({
    runId,
    moduleId,
    level: 1,
    nowIso,
  });
  let persistedRecord: WorkflowRunRecord | null = opts?.initialPersistedRecord ?? null;
  const persist = (record: WorkflowRunRecord) => {
    const effectiveRecord =
      persistedRecord?.abortRequestedAt &&
      (persistedRecord.abortRequested || record.abortRequested) &&
      (!record.abortRequested || record.abortRequestedAt !== persistedRecord.abortRequestedAt)
        ? {
            ...record,
            abortRequested: true,
            abortRequestedAt: persistedRecord.abortRequestedAt,
          }
        : record;
    if (persistedRecord?.status !== effectiveRecord.status) {
      tracer.emit({
        kind: "run_status_changed",
        status: effectiveRecord.status,
        summary: `status changed to ${effectiveRecord.status}`,
      });
    }
    const tracedRecord = tracer.attachToRunRecord(effectiveRecord);
    persistedRecord = tracedRecord;
    writeRunRecord(tracedRecord);
  };
  const ctx: WorkflowModuleContext = {
    runId,
    nowIso,
    persist,
    abortSignal: opts?.abortSignal ?? new AbortController().signal,
    throwIfAbortRequested() {
      throwIfWorkflowAbortRequested(this.abortSignal);
    },
    trace: tracer,
  };

  try {
    ctx.throwIfAbortRequested();
    const record = await module.start(request, ctx);
    const tracedRecord = tracer.attachToRunRecord(record);
    writeRunRecord(tracedRecord);
    return tracedRecord;
  } catch (error) {
    const persisted = persistedRecord;
    if (persisted === null) {
      throw error;
    }
    const latestPersisted = readRunRecord(runId) ?? persisted;
    if (isWorkflowAbortError(error)) {
      const terminalReason = workflowAbortReasonFromError(error);
      tracer.emit({
        kind: "run_aborted",
        stepId: "run",
        status: "aborted",
        summary: terminalReason,
        payload: { terminalReason },
      });
      const aborted = buildAbortedWorkflowRunRecord({
        terminalReason,
        tracer,
        persistedRecord: latestPersisted,
      });
      writeRunRecord(aborted);
      return aborted;
    }
    const terminalReason = error instanceof Error ? error.message : String(error);
    tracer.emit({
      kind: "run_failed",
      stepId: "run",
      status: "failed",
      summary: terminalReason,
      payload: { terminalReason },
    });
    const failed = buildFailedWorkflowRunRecord({
      terminalReason,
      tracer,
      persistedRecord: latestPersisted,
    });
    writeRunRecord(failed);
    try {
      await emitVisibleFailureAnnouncement({
        runId,
        moduleId,
        tracer,
        terminalReason,
        persistedRecord: failed,
      });
    } catch {
      // Preserve the original workflow failure if the best-effort fallback announcement path breaks.
    }
    return failed;
  }
}

export async function startWorkflowRunAsync(
  moduleId: string,
  request: WorkflowStartRequest,
): Promise<WorkflowRunRecord> {
  const module = getWorkflowModule(moduleId);
  if (!module) {
    throw new Error(`Workflow-Modul nicht gefunden: ${moduleId}`);
  }

  const runId = crypto.randomUUID();
  const initialRecord = buildInitialRunRecord({
    runId,
    moduleId,
    request,
    status: "pending",
  });
  writeRunRecord(initialRecord);
  const abortController = new AbortController();

  const backgroundRun = new Promise<WorkflowRunRecord>((resolve, reject) => {
    setTimeout(() => {
      void (async () => {
        try {
          const latestRecord = readRunRecord(runId) ?? initialRecord;
          if (latestRecord.abortRequested) {
            abortController.abort(createWorkflowAbortError("Abort requested by operator."));
          }
          const runningRecord: WorkflowRunRecord = abortController.signal.aborted
            ? latestRecord
            : {
                ...latestRecord,
                status: "running",
                updatedAt: nowIso(),
              };
          if (!abortController.signal.aborted) {
            writeRunRecord(runningRecord);
          }
          resolve(
            await startWorkflowRunWithRunId(moduleId, request, runId, {
              initialPersistedRecord: runningRecord,
              abortSignal: abortController.signal,
            }),
          );
        } catch (error) {
          reject(error);
        }
      })();
    }, 0);
  });

  activeWorkflowRuns.set(runId, {
    promise: backgroundRun,
    abortController,
  });
  void backgroundRun.finally(() => {
    const active = activeWorkflowRuns.get(runId);
    if (active?.promise === backgroundRun) {
      activeWorkflowRuns.delete(runId);
    }
  });

  return initialRecord;
}

export function getWorkflowRunStatus(runId: string): WorkflowRunRecord {
  const record = readRunRecord(runId);
  if (!record) {
    throw new Error(`Workflow-Run nicht gefunden: ${runId}`);
  }
  return record;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForWorkflowRun(
  runId: string,
  timeoutMs = DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS,
): Promise<WorkflowWaitResult> {
  const normalizedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS;

  const initialRecord = readRunRecord(runId);
  if (!initialRecord) {
    return {
      status: "error",
      error: `Workflow-Run nicht gefunden: ${runId}`,
    };
  }
  if (isTerminalStatus(initialRecord.status)) {
    return {
      status: "ok",
      run: initialRecord,
    };
  }

  const active = activeWorkflowRuns.get(runId);
  if (active) {
    const timeoutPromise = sleep(normalizedTimeout).then(() => ({ status: "timeout" as const }));
    try {
      const result = await Promise.race([
        active.promise.then((run) => ({ status: "ok" as const, run })),
        timeoutPromise,
      ]);
      if (result.status === "timeout") {
        return { status: "timeout" };
      }
      return result;
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const deadline = Date.now() + normalizedTimeout;
  while (Date.now() < deadline) {
    const current = readRunRecord(runId);
    if (!current) {
      return {
        status: "error",
        error: `Workflow-Run nicht gefunden: ${runId}`,
      };
    }
    if (isTerminalStatus(current.status)) {
      return {
        status: "ok",
        run: current,
      };
    }
    await sleep(WORKFLOW_WAIT_POLL_MS);
  }

  return { status: "timeout" };
}

export function abortWorkflowRun(runId: string): WorkflowRunRecord {
  const record = readRunRecord(runId);
  if (!record) {
    throw new Error(`Workflow-Run nicht gefunden: ${runId}`);
  }
  const module = getWorkflowModule(record.moduleId);
  if (!module) {
    throw new Error(`Workflow-Modul für Run nicht gefunden: ${record.moduleId}`);
  }
  if (!module.manifest.supportsAbort) {
    throw new Error(`Workflow-Modul unterstützt kein Abort: ${record.moduleId}`);
  }
  if (isTerminalStatus(record.status)) {
    return record;
  }
  const requestedAt = record.abortRequestedAt ?? nowIso();
  const abortRequestedRecord = markAbortRequested(record, requestedAt);
  if (
    abortRequestedRecord.abortRequested !== record.abortRequested ||
    abortRequestedRecord.updatedAt !== record.updatedAt
  ) {
    writeRunRecord(abortRequestedRecord);
  }
  activeWorkflowRuns
    .get(runId)
    ?.abortController.abort(createWorkflowAbortError("Abort requested by operator."));
  return readRunRecord(runId) ?? abortRequestedRecord;
}

export function listWorkflowRuns(limit = 20): WorkflowRunRecord[] {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  return listRunRecords().slice(0, normalizedLimit);
}

export function getWorkflowTraceSummary(runId: string): WorkflowTraceSummary {
  const record = getWorkflowRunStatus(runId);
  return readWorkflowTraceSummary(runId) ?? deriveWorkflowTraceSummaryFromRun(record);
}

export function getWorkflowTraceEvents(
  runId: string,
  query?: WorkflowTraceEventQuery,
): WorkflowTraceEvent[] {
  void getWorkflowRunStatus(runId);
  return readWorkflowTraceEvents(runId, query);
}

export function getWorkflowProgress(runId: string): WorkflowProgressSnapshot {
  const record = getWorkflowRunStatus(runId);
  const summary = getWorkflowTraceSummary(runId);
  const events = getWorkflowTraceEvents(runId);
  let activeRole: string | null = null;
  let currentStepId: string | null = null;
  let lastCompletedRole: string | null = null;
  let lastArtifactPath: string | null = null;

  for (const event of events) {
    if (event.kind === "role_turn_started" && event.role) {
      activeRole = event.role;
      currentStepId = event.stepId ?? currentStepId;
    }
    if (event.kind === "role_turn_completed" && event.role) {
      lastCompletedRole = event.role;
      if (activeRole === event.role) {
        activeRole = null;
        currentStepId = null;
      }
    }
    if (event.kind === "artifact_written" && event.artifactPath) {
      lastArtifactPath = event.artifactPath;
    }
  }

  const lastEvent =
    [...events].toReversed().find((event) => !isNoisyProgressEvent(event)) ?? events.at(-1) ?? null;
  const progressWithoutSummary: Omit<WorkflowProgressSnapshot, "humanSummary"> = {
    runId: record.runId,
    moduleId: record.moduleId,
    status: record.status,
    isTerminal: isTerminalStatus(record.status),
    abortRequested: record.abortRequested,
    abortRequestedAt: record.abortRequestedAt,
    currentRound: record.currentRound,
    maxRounds: record.maxRounds,
    traceLevel: summary.traceLevel,
    eventCount: summary.eventCount,
    artifactCount: summary.artifactCount,
    startedAt: record.createdAt,
    updatedAt: record.updatedAt,
    terminalReason: record.terminalReason,
    currentStepId,
    activeRole,
    lastCompletedRole,
    lastArtifactPath,
    lastArtifactName: artifactNameFromPath(lastArtifactPath),
    lastEventSeq: lastEvent?.seq ?? null,
    lastEventKind: lastEvent?.kind ?? null,
    lastEventAt: lastEvent?.ts ?? null,
    lastEventSummary: lastEvent?.summary ?? null,
    sessions: record.sessions,
  };

  return {
    ...progressWithoutSummary,
    humanSummary: buildProgressHumanSummary(progressWithoutSummary),
  };
}

export function listWorkflowArtifacts(runId: string): WorkflowArtifactInfo[] {
  void getWorkflowRunStatus(runId);
  const dirPath = workflowArtifactsDir(runId);
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      } satisfies WorkflowArtifactInfo;
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function readWorkflowArtifact(
  runId: string,
  name: string,
  opts?: { headLines?: number; tailLines?: number },
): WorkflowArtifactContent {
  void getWorkflowRunStatus(runId);
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Workflow-Artefaktname fehlt.");
  }
  if (path.basename(normalizedName) !== normalizedName) {
    throw new Error(`Ungueltiger Artefaktname: ${name}`);
  }
  const headLines =
    typeof opts?.headLines === "number" && Number.isFinite(opts.headLines) && opts.headLines > 0
      ? Math.floor(opts.headLines)
      : undefined;
  const tailLines =
    typeof opts?.tailLines === "number" && Number.isFinite(opts.tailLines) && opts.tailLines > 0
      ? Math.floor(opts.tailLines)
      : undefined;
  if (headLines && tailLines) {
    throw new Error("headLines und tailLines koennen nicht gleichzeitig gesetzt werden.");
  }

  const artifactPath = workflowArtifactPath(runId, normalizedName);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Workflow-Artefakt nicht gefunden: ${normalizedName}`);
  }
  const stat = fs.statSync(artifactPath);
  const raw = fs.readFileSync(artifactPath, "utf8");
  const lines = raw.split(/\r?\n/);
  let selectedLines = lines;
  let mode: WorkflowArtifactContent["mode"] = "full";
  if (headLines) {
    selectedLines = lines.slice(0, headLines);
    mode = "head";
  } else if (tailLines) {
    selectedLines = lines.slice(-tailLines);
    mode = "tail";
  }
  return {
    name: normalizedName,
    path: artifactPath,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    mode,
    totalLines: lines.length,
    truncated: selectedLines.length !== lines.length,
    content: selectedLines.join("\n"),
  };
}

export function workflowsList(opts: { json?: boolean }) {
  const modules = listWorkflowModuleManifests();
  if (opts.json) {
    printJson({ modules });
    return;
  }
  if (modules.length === 0) {
    console.log("Keine Workflow-Module registriert.");
    return;
  }
  printModuleSummary(modules);
}

export function workflowsDescribe(moduleId: string, opts: { json?: boolean }) {
  try {
    const manifest = describeWorkflowModule(moduleId);
    if (opts.json) {
      printJson(manifest);
      return;
    }

    console.log(`Module: ${manifest.moduleId}`);
    console.log(`Name: ${manifest.displayName}`);
    console.log(`Beschreibung: ${manifest.description}`);
    console.log(`Kind: ${manifest.kind}`);
    console.log(`Version: ${manifest.version}`);
    console.log(
      `Required agents: ${manifest.requiredAgents.length ? manifest.requiredAgents.join(", ") : "none"}`,
    );
    console.log(`Supports abort: ${manifest.supportsAbort ? "yes" : "no"}`);
    console.log(`Terminal states: ${terminalStatesText(manifest.terminalStates)}`);
    console.log("Input schema summary:");
    for (const line of manifest.inputSchemaSummary) {
      console.log(`- ${line}`);
    }
    console.log("Artifact contract:");
    for (const line of manifest.artifactContract) {
      console.log(`- ${line}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function workflowsStart(
  moduleId: string,
  opts: {
    json?: string;
    stdin?: boolean;
    maxRounds?: string;
    outputJson?: boolean;
  } & TrustedWorkflowMutationCliOptions,
) {
  try {
    const stdinInput = await readMaybeStdin(opts.stdin);
    const argInput = opts.json ? readJsonArg(opts.json) : undefined;
    const input = stdinInput ?? argInput ?? {};
    const request = buildWorkflowStartRequestFromCli({
      ...opts,
      input,
    });
    const record = await startWorkflowRun(moduleId, request);

    if (opts.outputJson) {
      printJson(record);
      return;
    }

    console.log(`Run gestartet: ${record.runId}`);
    console.log(`Module: ${record.moduleId}`);
    console.log(`Status: ${record.status}`);
    if (record.terminalReason) {
      console.log(`Reason: ${record.terminalReason}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function workflowsStartAsync(
  moduleId: string,
  opts: {
    json?: string;
    stdin?: boolean;
    maxRounds?: string;
    outputJson?: boolean;
  } & TrustedWorkflowMutationCliOptions,
) {
  try {
    const stdinInput = await readMaybeStdin(opts.stdin);
    const argInput = opts.json ? readJsonArg(opts.json) : undefined;
    const input = stdinInput ?? argInput ?? {};
    const request = buildWorkflowStartRequestFromCli({
      ...opts,
      input,
    });
    const record = await startWorkflowRunAsync(moduleId, request);

    if (opts.outputJson) {
      printJson(record);
      return;
    }

    console.log(`Run asynchron gestartet: ${record.runId}`);
    console.log(`Module: ${record.moduleId}`);
    console.log(`Status: ${record.status}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function workflowsWait(runId: string, opts: { timeoutMs?: string; json?: boolean }) {
  try {
    const timeoutValue = opts.timeoutMs === undefined ? undefined : Number(opts.timeoutMs);
    const result = await waitForWorkflowRun(
      runId,
      Number.isFinite(timeoutValue) ? timeoutValue : undefined,
    );
    if (opts.json) {
      printJson(result);
      return;
    }
    if (result.status === "ok" && result.run) {
      printStatusText(result.run);
      return;
    }
    if (result.status === "timeout") {
      console.log("Workflow wait timed out.");
      return;
    }
    console.log(`Workflow wait failed: ${result.error ?? "unknown error"}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function workflowsStatus(runId: string, opts: { json?: boolean }) {
  try {
    const record = getWorkflowRunStatus(runId);
    if (opts.json) {
      printJson(record);
      return;
    }
    printStatusText(record);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function workflowsProgress(runId: string, opts: { json?: boolean }) {
  try {
    const progress = getWorkflowProgress(runId);
    if (opts.json) {
      printJson(progress);
      return;
    }
    printProgressText(progress);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function workflowsAbort(runId: string, opts: { json?: boolean }) {
  try {
    const before = getWorkflowRunStatus(runId);
    const record = abortWorkflowRun(runId);
    if (opts.json) {
      printJson(record);
      return;
    }
    if (isTerminalStatus(record.status) && record.status !== "aborted") {
      console.log(`Run bereits terminal: ${record.runId} (${record.status})`);
      return;
    }
    if (record.status === "aborted") {
      console.log(
        before.status === "aborted"
          ? `Run bereits abgebrochen: ${record.runId}`
          : `Run abgebrochen: ${record.runId}`,
      );
      console.log(`Status: ${record.status}`);
      console.log(`Reason: ${record.terminalReason}`);
      return;
    }
    console.log(
      before.abortRequested
        ? `Abort bereits angefordert: ${record.runId}`
        : `Abort angefordert: ${record.runId}`,
    );
    console.log(`Status: ${record.status}`);
    console.log(`Abort requested: ${record.abortRequested ? "yes" : "no"}`);
    console.log(
      "Reason: Abort requested; wait for the active workflow step to stop before the run becomes terminal.",
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function workflowsRuns(opts: { json?: boolean; limit?: string }) {
  const parsedLimit = opts.limit === undefined ? 20 : Number(opts.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
  const runs = listWorkflowRuns(limit);

  if (opts.json) {
    printJson({ runs });
    return;
  }

  if (runs.length === 0) {
    console.log("Keine Workflow-Runs gefunden.");
    return;
  }

  for (const run of runs) {
    console.log(`- ${run.runId} ${run.moduleId} ${run.status} ${run.updatedAt}`);
  }
}

export function workflowsTraceSummary(runId: string, opts: { json?: boolean }) {
  try {
    const summary = getWorkflowTraceSummary(runId);
    if (opts.json) {
      printJson(summary);
      return;
    }
    console.log(`Run: ${summary.runId}`);
    console.log(`Module: ${summary.moduleId}`);
    console.log(`Trace level: ${summary.traceLevel}`);
    console.log(`Status: ${summary.status ?? "n/a"}`);
    console.log(`Events: ${summary.eventCount}`);
    console.log(`Steps: ${summary.stepCount}`);
    console.log(`Rounds: ${summary.roundCount}`);
    console.log(`Artifacts: ${summary.artifactCount}`);
    console.log(`Roles: ${summary.rolesSeen.length ? summary.rolesSeen.join(", ") : "none"}`);
    console.log(`Started: ${summary.startedAt ?? "n/a"}`);
    console.log(`Ended: ${summary.endedAt ?? "n/a"}`);
    console.log(`Last event: ${summary.lastEventKind ?? "n/a"}`);
    if (summary.errorSummary) {
      console.log(`Error summary: ${summary.errorSummary}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function workflowsTraceEvents(
  runId: string,
  opts: {
    json?: boolean;
    limit?: string;
    sinceSeq?: string;
    role?: string;
    kind?: string;
  },
) {
  try {
    const events = getWorkflowTraceEvents(runId, {
      limit: readPositiveNumberOption(opts.limit),
      sinceSeq: readPositiveNumberOption(opts.sinceSeq),
      role: opts.role?.trim() || undefined,
      kind: opts.kind?.trim() as WorkflowTraceEventQuery["kind"],
    });
    if (opts.json) {
      printJson({ events });
      return;
    }
    if (events.length === 0) {
      console.log("Keine Trace-Events fuer diesen Run vorhanden.");
      return;
    }
    for (const event of events) {
      const parts = [
        `#${event.seq}`,
        event.ts,
        event.kind,
        ...(event.stepId ? [`step=${event.stepId}`] : []),
        ...(typeof event.round === "number" ? [`round=${event.round}`] : []),
        ...(event.role ? [`role=${event.role}`] : []),
        ...(event.status ? [`status=${event.status}`] : []),
      ];
      console.log(parts.join("  "));
      if (event.summary) {
        console.log(`  ${event.summary}`);
      }
      if (event.artifactPath) {
        console.log(`  artifact: ${event.artifactPath}`);
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function workflowsArtifacts(runId: string, opts: { json?: boolean }) {
  try {
    const artifacts = listWorkflowArtifacts(runId);
    if (opts.json) {
      printJson({ artifacts });
      return;
    }
    printArtifactListText(artifacts);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function workflowsArtifact(
  runId: string,
  name: string,
  opts: { json?: boolean; headLines?: string; tailLines?: string },
) {
  try {
    const artifact = readWorkflowArtifact(runId, name, {
      headLines: readPositiveNumberOption(opts.headLines),
      tailLines: readPositiveNumberOption(opts.tailLines),
    });
    if (opts.json) {
      printJson(artifact);
      return;
    }
    printArtifactContentText(artifact);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
