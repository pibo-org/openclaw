import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../../../infra/openclaw-root.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { parseRawSessionConversationRef } from "../../../sessions/session-key-utils.js";
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
  WorkflowStatusPhase,
  WorkflowTerminalState,
  WorkflowWaitResult,
} from "./types.js";
import { emitTracedWorkflowReportEvent } from "./workflow-reporting.js";

const WORKFLOW_ABORT_POLL_MS = 250;
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

type WorkflowRunOperatorCliOptions = TrustedWorkflowMutationCliOptions & {
  json?: string;
  stdin?: boolean;
  maxRounds?: string;
  outputJson?: boolean;
  wait?: boolean;
  waitTimeoutMs?: string;
  replyHere?: boolean;
  task?: string;
  cwd?: string;
  repoRoot?: string;
  agentId?: string;
  success?: string[];
  constraint?: string[];
  workerModel?: string;
  workerReasoningEffort?: string;
};

type ResolvedWorkflowRunDefaults = {
  cwd?: string;
  replyTarget?: string;
};

type WorkflowRunStartResolution = {
  request: WorkflowStartRequest;
  resolvedDefaults: ResolvedWorkflowRunDefaults;
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

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRepeatedTextOption(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function objectHasOwnKey(value: Record<string, unknown>, keys: string[]) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasCodexControllerDirectInput(opts: WorkflowRunOperatorCliOptions) {
  return Boolean(
    normalizeNonEmptyString(opts.task) ||
    normalizeNonEmptyString(opts.cwd) ||
    normalizeNonEmptyString(opts.repoRoot) ||
    normalizeNonEmptyString(opts.agentId) ||
    normalizeNonEmptyString(opts.workerModel) ||
    normalizeNonEmptyString(opts.workerReasoningEffort) ||
    normalizeRepeatedTextOption(opts.success).length > 0 ||
    normalizeRepeatedTextOption(opts.constraint).length > 0,
  );
}

function assertNoJsonDirectInputConflict(
  jsonInput: Record<string, unknown>,
  opts: WorkflowRunOperatorCliOptions,
) {
  const conflicts: string[] = [];
  if (normalizeNonEmptyString(opts.task) && objectHasOwnKey(jsonInput, ["task"])) {
    conflicts.push("--task conflicts with JSON field `task`");
  }
  if (
    normalizeNonEmptyString(opts.cwd) &&
    objectHasOwnKey(jsonInput, ["workingDirectory", "cwd"])
  ) {
    conflicts.push("--cwd conflicts with JSON field `workingDirectory`");
  }
  if (normalizeNonEmptyString(opts.repoRoot) && objectHasOwnKey(jsonInput, ["repoRoot"])) {
    conflicts.push("--repo-root conflicts with JSON field `repoRoot`");
  }
  if (normalizeNonEmptyString(opts.agentId) && objectHasOwnKey(jsonInput, ["agentId"])) {
    conflicts.push("--agent-id conflicts with JSON field `agentId`");
  }
  if (
    normalizeRepeatedTextOption(opts.success).length > 0 &&
    objectHasOwnKey(jsonInput, ["successCriteria"])
  ) {
    conflicts.push("--success conflicts with JSON field `successCriteria`");
  }
  if (
    normalizeRepeatedTextOption(opts.constraint).length > 0 &&
    objectHasOwnKey(jsonInput, ["constraints"])
  ) {
    conflicts.push("--constraint conflicts with JSON field `constraints`");
  }
  if (normalizeNonEmptyString(opts.workerModel) && objectHasOwnKey(jsonInput, ["workerModel"])) {
    conflicts.push("--worker-model conflicts with JSON field `workerModel`");
  }
  if (
    normalizeNonEmptyString(opts.workerReasoningEffort) &&
    objectHasOwnKey(jsonInput, ["workerReasoningEffort"])
  ) {
    conflicts.push("--worker-reasoning-effort conflicts with JSON field `workerReasoningEffort`");
  }
  if (
    normalizeNonEmptyString(opts.maxRounds) &&
    objectHasOwnKey(jsonInput, ["maxRounds", "maxRetries"])
  ) {
    conflicts.push("--max-rounds conflicts with JSON field `maxRounds` or `maxRetries`");
  }
  if (conflicts.length > 0) {
    throw new Error(`Conflicting --json and direct flag inputs:\n- ${conflicts.join("\n- ")}`);
  }
}

function resolveExistingDirectory(rawPath: string, flag: string): string {
  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${flag} path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${flag} path is not a directory: ${resolved}`);
  }
  return resolved;
}

function splitRawConversationThread(params: { rawId: string; channel?: string }): {
  rawId: string;
  threadId?: string;
} {
  const lowerRawId = params.rawId.toLowerCase();
  const threadIndex = lowerRawId.lastIndexOf(":thread:");
  if (threadIndex !== -1) {
    const rawId = params.rawId.slice(0, threadIndex);
    const threadId = params.rawId.slice(threadIndex + ":thread:".length);
    return {
      rawId,
      ...(threadId.trim() ? { threadId: threadId.trim() } : {}),
    };
  }
  if (params.channel === "telegram") {
    const topicIndex = lowerRawId.lastIndexOf(":topic:");
    if (topicIndex !== -1) {
      const rawId = params.rawId.slice(0, topicIndex);
      const threadId = params.rawId.slice(topicIndex + ":topic:".length);
      return {
        rawId,
        ...(threadId.trim() ? { threadId: threadId.trim() } : {}),
      };
    }
  }
  return { rawId: params.rawId };
}

function deriveWorkflowOriginFromSessionKey(ownerSessionKey?: string): {
  channel?: string;
  to?: string;
  threadId?: string;
} {
  const parsed = parseRawSessionConversationRef(ownerSessionKey);
  if (!parsed) {
    return {};
  }
  const channel = parsed.channel;
  const conversation = splitRawConversationThread({ rawId: parsed.rawId, channel });
  return {
    channel,
    to: `${parsed.kind}:${conversation.rawId}`,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
  };
}

function resolveCurrentWorkflowOriginFromEnv(): {
  origin: WorkflowRunStartResolution["request"]["origin"];
  reporting: WorkflowRunStartResolution["request"]["reporting"];
} {
  const ownerSessionKey =
    normalizeNonEmptyString(process.env.OPENCLAW_WORKFLOW_OWNER_SESSION_KEY) ??
    normalizeNonEmptyString(process.env.OPENCLAW_MCP_SESSION_KEY);
  const sessionOrigin = deriveWorkflowOriginFromSessionKey(ownerSessionKey);
  const channel =
    normalizeNonEmptyString(process.env.OPENCLAW_WORKFLOW_CHANNEL) ??
    normalizeNonEmptyString(process.env.OPENCLAW_MCP_MESSAGE_CHANNEL) ??
    sessionOrigin.channel;
  const to = normalizeNonEmptyString(process.env.OPENCLAW_WORKFLOW_TO) ?? sessionOrigin.to;
  const accountId =
    normalizeNonEmptyString(process.env.OPENCLAW_WORKFLOW_ACCOUNT_ID) ??
    normalizeNonEmptyString(process.env.OPENCLAW_MCP_ACCOUNT_ID);
  const threadId =
    normalizeNonEmptyString(process.env.OPENCLAW_WORKFLOW_THREAD_ID) ?? sessionOrigin.threadId;
  const missing = [
    ...(ownerSessionKey ? [] : ["ownerSessionKey"]),
    ...(channel ? [] : ["channel"]),
    ...(to ? [] : ["to"]),
  ];
  if (missing.length > 0) {
    throw new Error(
      [
        "`--reply-here` is not available because no safe current workflow origin is present.",
        `Missing: ${missing.join(", ")}.`,
        "Set OPENCLAW_WORKFLOW_OWNER_SESSION_KEY, OPENCLAW_WORKFLOW_CHANNEL, OPENCLAW_WORKFLOW_TO, and optionally OPENCLAW_WORKFLOW_THREAD_ID; or pass --owner-session-key, --channel, --to, and optionally --thread-id explicitly.",
      ].join(" "),
    );
  }
  if (!ownerSessionKey || !channel || !to) {
    throw new Error("Internal error resolving current workflow origin.");
  }
  return buildTrustedWorkflowContext({
    ownerSessionKey,
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
  });
}

function resolveWorkflowRunTrustedContext(opts: WorkflowRunOperatorCliOptions): {
  origin?: WorkflowRunStartResolution["request"]["origin"];
  reporting?: WorkflowRunStartResolution["request"]["reporting"];
  replyHereDefaultApplied: boolean;
} {
  const hasExplicitRouting = Boolean(
    normalizeNonEmptyString(opts.ownerSessionKey) ||
    normalizeNonEmptyString(opts.channel) ||
    normalizeNonEmptyString(opts.to) ||
    normalizeNonEmptyString(opts.accountId) ||
    normalizeNonEmptyString(opts.threadId),
  );
  if (opts.replyHere && hasExplicitRouting) {
    throw new Error("Use either --reply-here or explicit routing flags, not both.");
  }
  if (opts.replyHere) {
    return {
      ...resolveCurrentWorkflowOriginFromEnv(),
      replyHereDefaultApplied: true,
    };
  }
  if (hasExplicitRouting) {
    const trustedContext = buildTrustedWorkflowContext({
      ownerSessionKey: requireNonEmptyCliOption(opts.ownerSessionKey, "--owner-session-key"),
      channel: requireNonEmptyCliOption(opts.channel, "--channel"),
      to: requireNonEmptyCliOption(opts.to, "--to"),
      ...(normalizeNonEmptyString(opts.accountId) ? { accountId: opts.accountId!.trim() } : {}),
      ...(normalizeNonEmptyString(opts.threadId) ? { threadId: opts.threadId!.trim() } : {}),
    });
    return { ...trustedContext, replyHereDefaultApplied: false };
  }
  return { replyHereDefaultApplied: false };
}

function buildCodexControllerInputForRun(params: {
  jsonInput: unknown;
  opts: WorkflowRunOperatorCliOptions;
}): { input: Record<string, unknown>; cwdDefaultApplied?: string } {
  const { jsonInput, opts } = params;
  if (jsonInput !== null && (typeof jsonInput !== "object" || Array.isArray(jsonInput))) {
    if (hasCodexControllerDirectInput(opts)) {
      throw new Error("Direct codex_controller flags require a JSON object input.");
    }
    throw new Error("run codex_controller requires a JSON object input.");
  }
  const baseInput = { ...(jsonInput as Record<string, unknown>) };
  assertNoJsonDirectInputConflict(baseInput, opts);

  const task = normalizeNonEmptyString(opts.task);
  const cwd = normalizeNonEmptyString(opts.cwd);
  const repoRoot = normalizeNonEmptyString(opts.repoRoot);
  const agentId = normalizeNonEmptyString(opts.agentId);
  const successCriteria = normalizeRepeatedTextOption(opts.success);
  const constraints = normalizeRepeatedTextOption(opts.constraint);
  const workerModel = normalizeNonEmptyString(opts.workerModel);
  const workerReasoningEffort = normalizeNonEmptyString(opts.workerReasoningEffort);
  const maxRounds = readPositiveNumberOption(opts.maxRounds);

  if (task) {
    baseInput.task = task;
  }
  let cwdDefaultApplied: string | undefined;
  if (cwd) {
    baseInput.workingDirectory = resolveExistingDirectory(cwd, "--cwd");
  } else if (!normalizeNonEmptyString(baseInput.workingDirectory)) {
    const resolvedCwd = resolveExistingDirectory(process.cwd(), "cwd default");
    baseInput.workingDirectory = resolvedCwd;
    cwdDefaultApplied = resolvedCwd;
  } else {
    baseInput.workingDirectory = resolveExistingDirectory(
      String(baseInput.workingDirectory),
      "workingDirectory",
    );
  }
  if (repoRoot) {
    baseInput.repoRoot = resolveExistingDirectory(repoRoot, "--repo-root");
  }
  if (agentId) {
    baseInput.agentId = agentId;
  }
  if (successCriteria.length > 0) {
    baseInput.successCriteria = successCriteria;
  }
  if (constraints.length > 0) {
    baseInput.constraints = constraints;
  }
  if (maxRounds !== undefined) {
    baseInput.maxRounds = maxRounds;
  }
  if (workerModel) {
    baseInput.workerModel = workerModel;
  }
  if (workerReasoningEffort) {
    baseInput.workerReasoningEffort = workerReasoningEffort;
  }
  if (!normalizeNonEmptyString(baseInput.task)) {
    throw new Error("run codex_controller requires --task or JSON field `task`.");
  }
  return { input: baseInput, cwdDefaultApplied };
}

function buildWorkflowRunStartRequestFromCli(params: {
  moduleId: string;
  input: unknown;
  opts: WorkflowRunOperatorCliOptions;
}): WorkflowRunStartResolution {
  const { moduleId, opts } = params;
  const trustedContext = resolveWorkflowRunTrustedContext(opts);
  const resolvedDefaults: ResolvedWorkflowRunDefaults = {};
  let input = params.input;
  if (moduleId === "codex_controller") {
    const codexInput = buildCodexControllerInputForRun({ jsonInput: input, opts });
    input = codexInput.input;
    if (codexInput.cwdDefaultApplied) {
      resolvedDefaults.cwd = codexInput.cwdDefaultApplied;
    }
  } else if (hasCodexControllerDirectInput(opts)) {
    throw new Error("Direct workflow run flags are currently supported only for codex_controller.");
  }
  if (trustedContext.replyHereDefaultApplied) {
    resolvedDefaults.replyTarget = "current context";
  }
  return {
    request: {
      input,
      maxRounds: readPositiveNumberOption(opts.maxRounds),
      ...(trustedContext.origin ? { origin: trustedContext.origin } : {}),
      ...(trustedContext.reporting ? { reporting: trustedContext.reporting } : {}),
    },
    resolvedDefaults,
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
  console.log(`Phase: ${progress.statusPhase ?? "n/a"}`);
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

function formatWorkflowReportingTarget(origin?: WorkflowRunRecord["origin"]): string {
  if (!origin) {
    return "none";
  }
  const target = [origin.channel, origin.to].filter(Boolean).join(" ");
  const thread = origin.threadId ? ` topic ${origin.threadId}` : "";
  const account = origin.accountId ? ` account ${origin.accountId}` : "";
  return `${target || origin.ownerSessionKey}${thread}${account}`.trim();
}

function readWorkflowInputWorkingDirectory(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const value = (input as { workingDirectory?: unknown }).workingDirectory;
  return typeof value === "string" && value.trim() ? value : null;
}

function printWorkflowRunStartText(params: {
  record: WorkflowRunRecord;
  resolvedDefaults: ResolvedWorkflowRunDefaults;
  waited?: boolean;
}) {
  console.log(`Started workflow run ${params.record.runId}`);
  console.log(`Module: ${params.record.moduleId}`);
  console.log(`Status: ${params.record.status}`);
  console.log(`Reporting to: ${formatWorkflowReportingTarget(params.record.origin)}`);
  console.log(
    `Working directory: ${readWorkflowInputWorkingDirectory(params.record.input) ?? "n/a"}`,
  );
  console.log(`Next: openclaw pibo workflows progress ${params.record.runId}`);
  const defaultLines = [
    ...(params.resolvedDefaults.cwd ? [`- cwd -> ${params.resolvedDefaults.cwd}`] : []),
    ...(params.resolvedDefaults.replyTarget
      ? [`- reply target -> ${params.resolvedDefaults.replyTarget}`]
      : []),
  ];
  if (defaultLines.length > 0) {
    console.log("Defaults applied:");
    for (const line of defaultLines) {
      console.log(line);
    }
  }
  if (params.record.terminalReason) {
    console.log(`Reason: ${params.record.terminalReason}`);
  }
  if (params.waited) {
    console.log("Wait: completed");
  }
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
    return "Run is bootstrapping; the detached workflow host has not started active execution yet.";
  }
  if (progress.status === "running") {
    if (progress.abortRequested) {
      if (progress.activeRole) {
        return `Abort wurde angefordert; aktive Rolle ${progress.activeRole} wird beendet und es starten keine weiteren Runden.`;
      }
      return "Abort wurde angefordert; der laufende Schritt wird beendet und es starten keine weiteren Runden.";
    }
    if (progress.statusPhase === "starting_controller") {
      return "Run is starting the controller before the first worker round.";
    }
    if (progress.statusPhase === "starting_worker") {
      const roundText = progress.currentRound > 0 ? ` round ${progress.currentRound}` : "";
      return `Worker is starting${roundText}; waiting for the first Codex result.`;
    }
    if (progress.statusPhase === "assessing_closeout") {
      const roundText = progress.currentRound > 0 ? ` round ${progress.currentRound}` : "";
      return `Controller is assessing closeout or next steps for${roundText}.`;
    }
    if (progress.activeRole) {
      const roundText = progress.currentRound > 0 ? ` Runde ${progress.currentRound}` : "";
      return `Run laeuft${roundText}; aktive Rolle: ${progress.activeRole}.`;
    }
    if (progress.statusPhase === "running_round") {
      return `Run is executing round ${progress.currentRound}.`;
    }
    return "Run is starting; no active role is visible in the trace yet.";
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

function deriveWorkflowStatusPhase(
  progress: Omit<WorkflowProgressSnapshot, "humanSummary" | "statusPhase">,
): WorkflowStatusPhase | null {
  if (progress.status === "pending") {
    return "bootstrapping";
  }
  if (progress.status !== "running") {
    return null;
  }
  if (progress.activeRole === "worker") {
    return "starting_worker";
  }
  if (progress.activeRole === "controller") {
    return "assessing_closeout";
  }
  if (progress.currentRound > 0) {
    return "running_round";
  }
  return "starting_controller";
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

function buildStartRequestFromRunRecord(record: WorkflowRunRecord): WorkflowStartRequest {
  return {
    input: record.input,
    maxRounds: record.maxRounds,
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.reporting ? { reporting: record.reporting } : {}),
  };
}

function buildRunningRunRecord(record: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...record,
    status: "running",
    updatedAt: nowIso(),
  };
}

function resolveWorkflowHostCliInvocation(): { command: string; args: string[] } {
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  if (packageRoot) {
    const openClawEntrypoint = path.join(packageRoot, "openclaw.mjs");
    const distEntrypointExists =
      fs.existsSync(path.join(packageRoot, "dist", "entry.js")) ||
      fs.existsSync(path.join(packageRoot, "dist", "entry.mjs"));
    if (distEntrypointExists && fs.existsSync(openClawEntrypoint)) {
      return { command: process.execPath, args: [openClawEntrypoint] };
    }

    const runNodeEntrypoint = path.join(packageRoot, "scripts", "run-node.mjs");
    if (fs.existsSync(runNodeEntrypoint)) {
      return { command: process.execPath, args: [runNodeEntrypoint] };
    }
  }

  const argv1 = typeof process.argv[1] === "string" ? process.argv[1].trim() : "";
  if (argv1 && fs.existsSync(argv1)) {
    return { command: process.execPath, args: [path.resolve(argv1)] };
  }

  return { command: "openclaw", args: [] };
}

function launchDetachedWorkflowRunHost(runId: string) {
  const invocation = resolveWorkflowHostCliInvocation();
  const child = spawn(
    invocation.command,
    [...invocation.args, "pibo", "workflows", "_run-pending", runId],
    {
      detached: true,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
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
  const abortController = new AbortController();
  const upstreamAbortSignal = opts?.abortSignal;
  const forwardAbortFromUpstream = () => {
    abortController.abort(
      createWorkflowAbortError(upstreamAbortSignal?.reason ?? "Abort requested by operator."),
    );
  };
  if (upstreamAbortSignal?.aborted) {
    forwardAbortFromUpstream();
  } else {
    upstreamAbortSignal?.addEventListener("abort", forwardAbortFromUpstream, { once: true });
  }
  if ((persistedRecord ?? readRunRecord(runId))?.abortRequested) {
    abortController.abort(createWorkflowAbortError("Abort requested by operator."));
  }
  const abortPoll = setInterval(() => {
    if (abortController.signal.aborted) {
      return;
    }
    const latestRecord = readRunRecord(runId);
    if (latestRecord?.abortRequested) {
      abortController.abort(createWorkflowAbortError("Abort requested by operator."));
    }
  }, WORKFLOW_ABORT_POLL_MS);
  abortPoll.unref();
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
    abortSignal: abortController.signal,
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
  } finally {
    clearInterval(abortPoll);
    upstreamAbortSignal?.removeEventListener("abort", forwardAbortFromUpstream);
  }
}

export async function runPendingWorkflowRun(runId: string): Promise<WorkflowRunRecord> {
  const persistedRecord = readRunRecord(runId);
  if (!persistedRecord) {
    throw new Error(`Workflow-Run nicht gefunden: ${runId}`);
  }
  if (persistedRecord.status === "running" || isTerminalStatus(persistedRecord.status)) {
    return persistedRecord;
  }
  if (persistedRecord.status !== "pending") {
    throw new Error(`Workflow-Run ${runId} kann nicht gestartet werden.`);
  }

  const request = buildStartRequestFromRunRecord(persistedRecord);
  const initialPersistedRecord = persistedRecord.abortRequested
    ? persistedRecord
    : buildRunningRunRecord(persistedRecord);
  if (!persistedRecord.abortRequested) {
    writeRunRecord(initialPersistedRecord);
  }

  return await startWorkflowRunWithRunId(persistedRecord.moduleId, request, runId, {
    initialPersistedRecord,
  });
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
  launchDetachedWorkflowRunHost(runId);

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
  const progressWithoutPhase: Omit<WorkflowProgressSnapshot, "humanSummary" | "statusPhase"> = {
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
  const progressWithoutSummary: Omit<WorkflowProgressSnapshot, "humanSummary"> = {
    ...progressWithoutPhase,
    statusPhase: deriveWorkflowStatusPhase(progressWithoutPhase),
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

export async function workflowsRun(moduleId: string, opts: WorkflowRunOperatorCliOptions) {
  try {
    const stdinInput = await readMaybeStdin(opts.stdin);
    const argInput = opts.json ? readJsonArg(opts.json) : undefined;
    const input = stdinInput ?? argInput ?? {};
    const { request, resolvedDefaults } = buildWorkflowRunStartRequestFromCli({
      moduleId,
      input,
      opts,
    });
    const record = opts.wait
      ? await startWorkflowRun(moduleId, request)
      : await startWorkflowRunAsync(moduleId, request);

    if (opts.wait) {
      const timeoutValue =
        opts.waitTimeoutMs === undefined ? undefined : Number(opts.waitTimeoutMs);
      const wait = await waitForWorkflowRun(
        record.runId,
        Number.isFinite(timeoutValue) ? timeoutValue : undefined,
      );
      if (wait.status === "ok" && wait.run) {
        if (opts.outputJson) {
          printJson({
            record: wait.run,
            resolvedDefaults,
            resolvedOrigin: wait.run.origin ?? null,
          });
          return;
        }
        printWorkflowRunStartText({ record: wait.run, resolvedDefaults, waited: true });
        return;
      }
      if (opts.outputJson) {
        printJson({
          record,
          wait,
          resolvedDefaults,
          resolvedOrigin: record.origin ?? null,
        });
        return;
      }
      printWorkflowRunStartText({ record, resolvedDefaults });
      console.log(
        wait.status === "timeout"
          ? "Wait: timed out before a terminal state was reached."
          : `Wait: failed: ${wait.error ?? "unknown error"}`,
      );
      return;
    }

    if (opts.outputJson) {
      printJson({
        record,
        resolvedDefaults,
        resolvedOrigin: record.origin ?? null,
      });
      return;
    }

    printWorkflowRunStartText({ record, resolvedDefaults });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export async function workflowsRunPending(runId: string) {
  try {
    await runPendingWorkflowRun(runId);
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
