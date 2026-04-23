import "@tanstack/react-start/server-only";
import fs from "node:fs";
import path from "node:path";
import { requireAuthenticatedUsername } from "#/lib/auth.server";
import {
  listRunRecords,
  readRunRecord,
  workflowArtifactPath,
  workflowArtifactsDir,
  workflowsStateDir,
} from "../../../src/cli/pibo/workflows/store.ts";
import {
  deriveWorkflowTraceSummaryFromRun,
  readWorkflowTraceEvents,
  readWorkflowTraceSummary,
} from "../../../src/cli/pibo/workflows/tracing/runtime.ts";
import type { WorkflowTraceEvent } from "../../../src/cli/pibo/workflows/tracing/types.ts";
import type { WorkflowRunRecord } from "../../../src/cli/pibo/workflows/types.ts";
import {
  WORKFLOW_STATUSES,
  WORKFLOW_TIME_WINDOWS,
  WORKFLOW_TRACE_EVENT_KINDS,
  type ArtifactPreviewMode,
  type WorkflowDashboardPage,
  type WorkflowDashboardQuery,
  type WorkflowDashboardRunRow,
  type WorkflowDetailQuery,
  type WorkflowModuleOption,
  type WorkflowRunDetailPage,
  type WorkflowStatus,
  type WorkflowTimeWindow,
  type WorkflowTraceEventKind,
} from "./workflows.shared";

const DEFAULT_DASHBOARD_LIMIT = 80;
const MAX_DASHBOARD_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 80;
const MAX_EVENT_LIMIT = 250;
const DEFAULT_ARTIFACT_LINES = 80;
const MAX_ARTIFACT_LINES = 200;

const WORKFLOW_MODULE_METADATA = {
  codex_controller: {
    displayName: "Codex Controller",
    description: "Orchestriert agentische Codex-Runden mit Artefakten und Trace-Daten.",
    version: "v1",
    kind: "agent_workflow",
  },
  langgraph_worker_critic: {
    displayName: "LangGraph Worker Critic",
    description: "Worker/Critic-Ablauf mit mehreren Runden und Review-Schleife.",
    version: "v1",
    kind: "agent_workflow",
  },
  noop: {
    displayName: "Noop",
    description: "Minimaler Referenz-Workflow fuer Runtime-Checks.",
    version: "v1",
    kind: "maintenance_workflow",
  },
  ralph_from_specs: {
    displayName: "Ralph From Specs",
    description: "Leitet Ralph-Ausfuehrung aus vorhandenen Spezifikationen ab.",
    version: "v1",
    kind: "analysis_workflow",
  },
  self_ralph: {
    displayName: "Self Ralph",
    description: "Mehrphasiger Ralph-Workflow mit Datei- und Trace-Artefakten.",
    version: "v1",
    kind: "analysis_workflow",
  },
} as const;

const TEXT_ARTIFACT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".xml",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".sh",
  ".diff",
  ".patch",
]);

function getModuleMetadata(moduleId: string) {
  return (
    WORKFLOW_MODULE_METADATA[moduleId as keyof typeof WORKFLOW_MODULE_METADATA] ?? {
      displayName: moduleId,
      description: "",
      version: "unknown",
      kind: "agent_workflow",
    }
  );
}

function listModuleOptions(records: WorkflowRunRecord[]) {
  const seen = new Set<string>([
    ...Object.keys(WORKFLOW_MODULE_METADATA),
    ...records.map((record) => record.moduleId),
  ]);
  return Array.from(seen)
    .map((moduleId) => ({
      moduleId,
      displayName: getModuleMetadata(moduleId).displayName,
    }))
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
}

function clampInt(value: unknown, fallback: number, max: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDashboardStatus(value: unknown): WorkflowDashboardQuery["status"] {
  const normalized = normalizeText(value);
  if (!normalized || normalized === "all") {
    return "all";
  }
  return WORKFLOW_STATUSES.includes(normalized as WorkflowStatus)
    ? (normalized as WorkflowStatus)
    : "all";
}

function normalizeTraceKind(value: unknown): WorkflowTraceEventKind | "" {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  return WORKFLOW_TRACE_EVENT_KINDS.includes(normalized as WorkflowTraceEventKind)
    ? (normalized as WorkflowTraceEventKind)
    : "";
}

function normalizeTimeWindow(value: unknown): WorkflowTimeWindow {
  const normalized = normalizeText(value);
  return WORKFLOW_TIME_WINDOWS.includes(normalized as WorkflowTimeWindow)
    ? (normalized as WorkflowTimeWindow)
    : "7d";
}

function normalizeArtifactMode(value: unknown): ArtifactPreviewMode {
  return normalizeText(value) === "head" ? "head" : "tail";
}

function normalizeDashboardQuery(
  input: Partial<WorkflowDashboardQuery> | undefined,
): WorkflowDashboardQuery {
  return {
    q: normalizeText(input?.q),
    status: normalizeDashboardStatus(input?.status),
    moduleId: normalizeText(input?.moduleId),
    role: normalizeText(input?.role),
    window: normalizeTimeWindow(input?.window),
    activeOnly: Boolean(input?.activeOnly),
    limit: clampInt(input?.limit, DEFAULT_DASHBOARD_LIMIT, MAX_DASHBOARD_LIMIT),
  };
}

function normalizeDetailQuery(
  input: Partial<WorkflowDetailQuery> | undefined,
): WorkflowDetailQuery {
  const afterSeqRaw = normalizeText(input?.afterSeq);
  const parsedAfterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : Number.NaN;
  return {
    kind: normalizeTraceKind(input?.kind),
    role: normalizeText(input?.role),
    q: normalizeText(input?.q),
    afterSeq:
      Number.isFinite(parsedAfterSeq) && parsedAfterSeq > 0 ? Math.floor(parsedAfterSeq) : null,
    eventLimit: clampInt(input?.eventLimit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT),
    artifact: normalizeText(input?.artifact),
    artifactMode: normalizeArtifactMode(input?.artifactMode),
    artifactLines: clampInt(input?.artifactLines, DEFAULT_ARTIFACT_LINES, MAX_ARTIFACT_LINES),
  };
}

function summarizeText(value: string | null | undefined, maxLength = 180) {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function rolesFromRun(record: WorkflowRunRecord) {
  const summary = readWorkflowTraceSummary(record.runId);
  const derived = summary ?? deriveWorkflowTraceSummaryFromRun(record);
  const roles = derived.rolesSeen.length
    ? derived.rolesSeen
    : [
        ...(record.sessions.orchestrator ? ["orchestrator"] : []),
        ...(record.sessions.worker ? ["worker"] : []),
        ...(record.sessions.critic ? ["critic"] : []),
      ];
  return { summary, derived, roles: Array.from(new Set(roles)) };
}

function hasMeaningfulTraceError(params: {
  errorSummary: string | null | undefined;
  lastEventKind: string | null | undefined;
}) {
  if (!params.errorSummary) {
    return false;
  }
  if (params.errorSummary === "event-disabled") {
    return false;
  }
  return !(params.lastEventKind === "report_failed" && params.errorSummary === "event-disabled");
}

function buildDashboardRow(
  record: WorkflowRunRecord,
  moduleOptions: Map<string, WorkflowModuleOption>,
): WorkflowDashboardRunRow {
  const trace = rolesFromRun(record);
  const module = moduleOptions.get(record.moduleId);
  const lastEventAt = record.trace?.updatedAt ?? record.updatedAt;
  return {
    runId: record.runId,
    moduleId: record.moduleId,
    moduleDisplayName: module?.displayName ?? record.moduleId,
    status: record.status,
    terminalReason: record.terminalReason,
    abortRequested: record.abortRequested,
    currentRound: record.currentRound,
    maxRounds: record.maxRounds,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    originalTask: record.originalTask,
    currentTask: record.currentTask,
    latestWorkerOutput: record.latestWorkerOutput,
    latestCriticVerdict: record.latestCriticVerdict,
    taskSnippet: summarizeText(
      record.currentTask ?? record.originalTask ?? record.latestWorkerOutput,
    ),
    sessions: record.sessions,
    trace: {
      summaryAvailable: trace.summary !== null,
      traceLevel: trace.derived.traceLevel,
      eventCount: trace.derived.eventCount,
      artifactCount: trace.derived.artifactCount,
      rolesSeen: trace.roles,
      lastEventKind: trace.derived.lastEventKind ?? null,
      lastEventAt,
      errorSummary: trace.derived.errorSummary ?? null,
      hasMeaningfulError: hasMeaningfulTraceError({
        errorSummary: trace.derived.errorSummary,
        lastEventKind: trace.derived.lastEventKind,
      }),
    },
  };
}

function isActiveStatus(status: WorkflowStatus) {
  return status === "pending" || status === "running";
}

function matchesTimeWindow(updatedAt: string, window: WorkflowTimeWindow) {
  if (window === "all") {
    return true;
  }
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }
  const hours =
    window === "24h" ? 24 : window === "7d" ? 24 * 7 : window === "30d" ? 24 * 30 : 24 * 90;
  return Date.now() - updatedAtMs <= hours * 60 * 60 * 1000;
}

function buildSearchHaystack(row: WorkflowDashboardRunRow) {
  return [
    row.runId,
    row.moduleId,
    row.moduleDisplayName,
    row.status,
    row.terminalReason ?? "",
    row.taskSnippet,
    row.currentTask ?? "",
    row.originalTask ?? "",
    row.latestWorkerOutput ?? "",
    row.latestCriticVerdict ?? "",
    row.trace.rolesSeen.join(" "),
    row.sessions.orchestrator ?? "",
    row.sessions.worker ?? "",
    row.sessions.critic ?? "",
    ...Object.values(row.sessions.extras ?? {}),
  ]
    .join(" ")
    .toLowerCase();
}

function filterDashboardRows(rows: WorkflowDashboardRunRow[], query: WorkflowDashboardQuery) {
  const needle = query.q.toLowerCase();
  return rows.filter((row) => {
    if (query.activeOnly && !isActiveStatus(row.status)) {
      return false;
    }
    if (query.status !== "all" && row.status !== query.status) {
      return false;
    }
    if (query.moduleId && row.moduleId !== query.moduleId) {
      return false;
    }
    if (query.role && !row.trace.rolesSeen.includes(query.role)) {
      return false;
    }
    if (!matchesTimeWindow(row.updatedAt, query.window)) {
      return false;
    }
    if (needle && !buildSearchHaystack(row).includes(needle)) {
      return false;
    }
    return true;
  });
}

function buildDashboardStats(rows: WorkflowDashboardRunRow[]) {
  return rows.reduce(
    (stats, row) => {
      stats.total += 1;
      if (isActiveStatus(row.status)) {
        stats.active += 1;
      }
      if (row.status === "blocked") {
        stats.blocked += 1;
      }
      if (row.status === "failed") {
        stats.failed += 1;
      }
      if (row.status === "done" || row.status === "planning_done") {
        stats.done += 1;
      }
      if (row.status === "aborted") {
        stats.aborted += 1;
      }
      if (row.status === "max_rounds_reached") {
        stats.maxRoundsReached += 1;
      }
      if (row.abortRequested) {
        stats.abortRequested += 1;
      }
      return stats;
    },
    {
      total: 0,
      active: 0,
      blocked: 0,
      failed: 0,
      done: 0,
      aborted: 0,
      maxRoundsReached: 0,
      abortRequested: 0,
    },
  );
}

function readRunRecordRequired(runId: string) {
  const record = readRunRecord(runId);
  if (!record) {
    throw new Error(`Workflow-Run nicht gefunden: ${runId}`);
  }
  return record;
}

function isNoisyProgressEvent(event: WorkflowTraceEvent) {
  if (event.kind === "report_delivery_attempted" || event.kind === "report_delivered") {
    return true;
  }
  return event.kind === "report_failed" && event.summary === "event-disabled";
}

function deriveWorkflowStatusPhase(params: {
  status: WorkflowStatus;
  currentRound: number;
  activeRole: string | null;
}) {
  if (params.status === "pending") {
    return "bootstrapping";
  }
  if (params.status !== "running") {
    return null;
  }
  if (params.activeRole === "worker") {
    return "starting_worker";
  }
  if (params.activeRole === "controller") {
    return "assessing_closeout";
  }
  if (params.currentRound > 0) {
    return "running_round";
  }
  return "starting_controller";
}

function buildProgressHumanSummary(params: {
  status: WorkflowStatus;
  abortRequested: boolean;
  activeRole: string | null;
  statusPhase: string | null;
  currentRound: number;
  maxRounds: number | null;
  terminalReason: string | null;
}) {
  if (params.status === "pending") {
    return params.abortRequested
      ? "Abort wurde angefordert, bevor der Run gestartet hat."
      : "Run is bootstrapping; the detached workflow host has not started active execution yet.";
  }
  if (params.status === "running") {
    if (params.abortRequested) {
      return params.activeRole
        ? `Abort wurde angefordert; aktive Rolle ${params.activeRole} wird beendet und es starten keine weiteren Runden.`
        : "Abort wurde angefordert; der laufende Schritt wird beendet und es starten keine weiteren Runden.";
    }
    if (params.statusPhase === "starting_worker") {
      return `Worker is starting${params.currentRound > 0 ? ` round ${params.currentRound}` : ""}; waiting for the first Codex result.`;
    }
    if (params.statusPhase === "assessing_closeout") {
      return `Controller is assessing closeout or next steps for${params.currentRound > 0 ? ` round ${params.currentRound}` : ""}.`;
    }
    if (params.activeRole) {
      return `Run laeuft${params.currentRound > 0 ? ` Runde ${params.currentRound}` : ""}; aktive Rolle: ${params.activeRole}.`;
    }
    if (params.statusPhase === "running_round") {
      return `Run is executing round ${params.currentRound}.`;
    }
    return "Run is starting; no active role is visible in the trace yet.";
  }
  if (params.status === "done" || params.status === "planning_done") {
    return `Run erfolgreich abgeschlossen${params.currentRound > 0 ? ` nach Runde ${params.currentRound}` : ""}.`;
  }
  if (params.status === "blocked") {
    return `Run ist blockiert: ${params.terminalReason ?? "kein Grund im Run-Record"}.`;
  }
  if (params.status === "failed") {
    return `Run ist fehlgeschlagen: ${params.terminalReason ?? "kein Fehlertext im Run-Record"}.`;
  }
  if (params.status === "aborted") {
    return `Run wurde abgebrochen: ${params.terminalReason ?? "kein Abbruchgrund im Run-Record"}.`;
  }
  return `Run hat die Rundengrenze erreicht${params.maxRounds ? ` (${params.maxRounds})` : ""}.`;
}

function deriveProgress(record: WorkflowRunRecord) {
  const summary =
    readWorkflowTraceSummary(record.runId) ?? deriveWorkflowTraceSummaryFromRun(record);
  const events = readWorkflowTraceEvents(record.runId);
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
  const statusPhase = deriveWorkflowStatusPhase({
    status: record.status,
    currentRound: record.currentRound,
    activeRole,
  });

  return {
    statusPhase,
    humanSummary: buildProgressHumanSummary({
      status: record.status,
      abortRequested: record.abortRequested,
      activeRole,
      statusPhase,
      currentRound: record.currentRound,
      maxRounds: record.maxRounds,
      terminalReason: record.terminalReason,
    }),
    isTerminal: !isActiveStatus(record.status),
    currentStepId,
    activeRole,
    lastCompletedRole,
    lastArtifactName: lastArtifactPath ? path.basename(lastArtifactPath) : null,
    lastEventSeq: lastEvent?.seq ?? null,
    lastEventKind: lastEvent?.kind ?? null,
    lastEventAt: lastEvent?.ts ?? null,
    lastEventSummary: lastEvent?.summary ?? null,
    eventCount: summary.eventCount,
    artifactCount: summary.artifactCount,
  };
}

function listWorkflowArtifactsLocal(runId: string) {
  void readRunRecordRequired(runId);
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
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function readWorkflowArtifactLocal(
  runId: string,
  name: string,
  opts?: { headLines?: number; tailLines?: number },
) {
  void readRunRecordRequired(runId);
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Workflow-Artefaktname fehlt.");
  }
  if (path.basename(normalizedName) !== normalizedName) {
    throw new Error(`Ungueltiger Artefaktname: ${name}`);
  }
  const artifactPath = workflowArtifactPath(runId, normalizedName);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Workflow-Artefakt nicht gefunden: ${normalizedName}`);
  }
  const raw = fs.readFileSync(artifactPath, "utf8");
  const stat = fs.statSync(artifactPath);
  const lines = raw.split(/\r?\n/);
  const headLines =
    typeof opts?.headLines === "number" && Number.isFinite(opts.headLines) && opts.headLines > 0
      ? Math.floor(opts.headLines)
      : undefined;
  const tailLines =
    typeof opts?.tailLines === "number" && Number.isFinite(opts.tailLines) && opts.tailLines > 0
      ? Math.floor(opts.tailLines)
      : undefined;
  const selectedLines = headLines
    ? lines.slice(0, headLines)
    : tailLines
      ? lines.slice(-tailLines)
      : lines;

  return {
    name: normalizedName,
    path: artifactPath,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    totalLines: lines.length,
    truncated: selectedLines.length !== lines.length,
    content: selectedLines.join("\n"),
  };
}

function payloadToText(payload: unknown) {
  if (payload === undefined) {
    return null;
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (payload instanceof Error) {
    return payload.message;
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return Object.prototype.toString.call(payload);
  }
}

function matchesTraceText(event: WorkflowTraceEvent, needle: string) {
  if (!needle) {
    return true;
  }
  const haystack = [
    event.kind,
    event.role ?? "",
    event.status ?? "",
    event.stepId ?? "",
    event.sessionKey ?? "",
    event.agentId ?? "",
    event.artifactPath ?? "",
    event.summary ?? "",
    payloadToText(event.payload) ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function isPreviewableArtifact(name: string) {
  return TEXT_ARTIFACT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function pickPreviewArtifactName(artifactNames: string[], requestedName: string) {
  if (requestedName && artifactNames.includes(requestedName)) {
    return requestedName;
  }
  return (
    artifactNames.find((name) =>
      ["run-summary.txt", "run-summary.md", "summary.txt", "summary.md"].includes(name),
    ) ??
    artifactNames.find((name) => isPreviewableArtifact(name)) ??
    artifactNames[0] ??
    ""
  );
}

export async function readWorkflowsDashboardPage(
  input?: Partial<WorkflowDashboardQuery>,
): Promise<WorkflowDashboardPage> {
  requireAuthenticatedUsername();
  const query = normalizeDashboardQuery(input);
  const fetchLimit = Math.max(query.limit * 3, 150);
  const records = listRunRecords().slice(0, fetchLimit);
  const moduleOptions = new Map(
    listModuleOptions(records).map(
      (module) => [module.moduleId, module] satisfies [string, WorkflowModuleOption],
    ),
  );
  const rows = records
    .map((record) => buildDashboardRow(record, moduleOptions))
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const filtered = filterDashboardRows(rows, query).slice(0, query.limit);
  const roles = Array.from(new Set(rows.flatMap((row) => row.trace.rolesSeen))).toSorted((a, b) =>
    a.localeCompare(b),
  );

  return {
    generatedAt: new Date().toISOString(),
    query,
    stats: buildDashboardStats(filtered),
    modules: listModuleOptions(records),
    roles,
    runs: filtered,
  };
}

export async function readWorkflowRunDetailPage(
  runId: string,
  input?: Partial<WorkflowDetailQuery>,
): Promise<WorkflowRunDetailPage> {
  requireAuthenticatedUsername();
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    throw new Error("Workflow-Run-ID fehlt.");
  }

  const query = normalizeDetailQuery(input);
  const record = readRunRecordRequired(normalizedRunId);
  const progress = deriveProgress(record);
  const artifacts = listWorkflowArtifactsLocal(normalizedRunId);
  const manifest = getModuleMetadata(record.moduleId);

  const summaryFile = readWorkflowTraceSummary(normalizedRunId);
  const traceSummary = summaryFile ?? deriveWorkflowTraceSummaryFromRun(record);
  const fetchEventLimit = query.q
    ? Math.min(query.eventLimit * 4, MAX_EVENT_LIMIT)
    : query.eventLimit;
  const recentEvents = readWorkflowTraceEvents(normalizedRunId, {
    limit: fetchEventLimit,
    sinceSeq: query.afterSeq ?? undefined,
    role: query.role || undefined,
    kind: query.kind || undefined,
  });
  const filteredEvents = recentEvents
    .filter((event) => matchesTraceText(event, query.q.toLowerCase()))
    .slice(-query.eventLimit);
  const previewArtifactName = pickPreviewArtifactName(
    artifacts.map((artifact) => artifact.name),
    query.artifact,
  );
  const selectedArtifact =
    artifacts.find((artifact) => artifact.name === previewArtifactName) ?? null;

  let artifactPreview: WorkflowRunDetailPage["artifactPreview"] = null;
  if (selectedArtifact) {
    if (!isPreviewableArtifact(selectedArtifact.name)) {
      artifactPreview = {
        artifactName: selectedArtifact.name,
        mode: query.artifactMode,
        totalLines: null,
        truncated: false,
        content: "",
        unsupportedReason: "Preview ist nur fuer textartige Artefakte aktiviert.",
      };
    } else {
      const preview = readWorkflowArtifactLocal(
        normalizedRunId,
        selectedArtifact.name,
        query.artifactMode === "head"
          ? { headLines: query.artifactLines }
          : { tailLines: query.artifactLines },
      );
      artifactPreview = {
        artifactName: preview.name,
        mode: query.artifactMode,
        totalLines: preview.totalLines,
        truncated: preview.truncated,
        content: preview.content,
        unsupportedReason: null,
      };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    query: {
      ...query,
      artifact: previewArtifactName,
    },
    module: {
      moduleId: record.moduleId,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      kind: manifest.kind,
    },
    run: {
      runId: record.runId,
      moduleId: record.moduleId,
      status: record.status,
      terminalReason: record.terminalReason,
      abortRequested: record.abortRequested,
      abortRequestedAt: record.abortRequestedAt,
      currentRound: record.currentRound,
      maxRounds: record.maxRounds,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      originalTask: record.originalTask,
      currentTask: record.currentTask,
      latestWorkerOutput: record.latestWorkerOutput,
      latestCriticVerdict: record.latestCriticVerdict,
      sessions: record.sessions,
      origin: record.origin,
      reporting: record.reporting,
    },
    progress: {
      statusPhase: progress.statusPhase,
      humanSummary: progress.humanSummary,
      isTerminal: progress.isTerminal,
      currentStepId: progress.currentStepId,
      activeRole: progress.activeRole,
      lastCompletedRole: progress.lastCompletedRole,
      lastArtifactName: progress.lastArtifactName,
      lastEventSeq: progress.lastEventSeq,
      lastEventKind: progress.lastEventKind,
      lastEventAt: progress.lastEventAt,
      lastEventSummary: progress.lastEventSummary,
      eventCount: progress.eventCount,
      artifactCount: progress.artifactCount,
    },
    traceSummary: {
      summaryAvailable: summaryFile !== null,
      traceLevel: traceSummary.traceLevel,
      status: traceSummary.status ?? null,
      startedAt: traceSummary.startedAt ?? null,
      endedAt: traceSummary.endedAt ?? null,
      durationMs: traceSummary.durationMs ?? null,
      eventCount: traceSummary.eventCount,
      stepCount: traceSummary.stepCount,
      roundCount: traceSummary.roundCount,
      rolesSeen: traceSummary.rolesSeen,
      artifactCount: traceSummary.artifactCount,
      lastEventKind: traceSummary.lastEventKind ?? null,
      errorSummary: traceSummary.errorSummary ?? null,
      hasMeaningfulError: hasMeaningfulTraceError({
        errorSummary: traceSummary.errorSummary,
        lastEventKind: traceSummary.lastEventKind,
      }),
    },
    availableRoles: Array.from(
      new Set([
        ...traceSummary.rolesSeen,
        ...(record.sessions.orchestrator ? ["orchestrator"] : []),
        ...(record.sessions.worker ? ["worker"] : []),
        ...(record.sessions.critic ? ["critic"] : []),
      ]),
    ).toSorted((left, right) => left.localeCompare(right)),
    availableKinds: [...WORKFLOW_TRACE_EVENT_KINDS],
    events: filteredEvents.map((event) => ({
      eventId: event.eventId,
      ts: event.ts,
      seq: event.seq,
      kind: event.kind,
      stepId: event.stepId ?? null,
      round: typeof event.round === "number" ? event.round : null,
      role: event.role ?? null,
      sessionKey: event.sessionKey ?? null,
      agentId: event.agentId ?? null,
      artifactPath: event.artifactPath ?? null,
      status: event.status ?? null,
      summary: event.summary ?? null,
      payloadText: payloadToText(event.payload),
    })),
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      path: artifact.path,
      sizeBytes: artifact.sizeBytes,
      updatedAt: artifact.updatedAt,
      previewable: isPreviewableArtifact(artifact.name),
    })),
    artifactPreview,
  };
}

export function getWorkflowsStateRoot() {
  return workflowsStateDir();
}
