import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { getWorkflowModule, listWorkflowModules } from "./modules/index.js";
import { listRunRecords, readRunRecord, writeRunRecord } from "./store.js";
import type {
  WorkflowModuleManifest,
  WorkflowRunRecord,
  WorkflowStartRequest,
  WorkflowTerminalState,
} from "./types.js";

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

function isTerminalStatus(status: WorkflowRunRecord["status"]) {
  return (
    status === "done" ||
    status === "blocked" ||
    status === "aborted" ||
    status === "failed" ||
    status === "max_rounds_reached"
  );
}

function printStatusText(record: WorkflowRunRecord) {
  console.log(`Run: ${record.runId}`);
  console.log(`Module: ${record.moduleId}`);
  console.log(`Status: ${record.status}`);
  console.log(`Created: ${record.createdAt}`);
  console.log(`Updated: ${record.updatedAt}`);
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
  const module = getWorkflowModule(moduleId);
  if (!module) {
    throw new Error(`Workflow-Modul nicht gefunden: ${moduleId}`);
  }

  const runId = crypto.randomUUID();
  let persistedRecord: WorkflowRunRecord | null = null;
  const persist = (record: WorkflowRunRecord) => {
    persistedRecord = record;
    writeRunRecord(record);
  };

  try {
    const record = await module.start(request, {
      runId,
      nowIso,
      persist,
    });
    writeRunRecord(record);
    return record;
  } catch (error) {
    const persisted = persistedRecord as WorkflowRunRecord | null;
    if (persisted === null) {
      throw error;
    }
    const terminalReason = error instanceof Error ? error.message : String(error);
    const failed: WorkflowRunRecord = {
      runId: persisted.runId,
      moduleId: persisted.moduleId,
      status: "failed",
      terminalReason,
      currentRound: persisted.currentRound,
      maxRounds: persisted.maxRounds,
      input: persisted.input,
      artifacts: persisted.artifacts,
      sessions: persisted.sessions,
      latestWorkerOutput: persisted.latestWorkerOutput,
      latestCriticVerdict: persisted.latestCriticVerdict,
      originalTask: persisted.originalTask,
      currentTask: persisted.currentTask,
      createdAt: persisted.createdAt,
      updatedAt: nowIso(),
    };
    writeRunRecord(failed);
    return failed;
  }
}

export function getWorkflowRunStatus(runId: string): WorkflowRunRecord {
  const record = readRunRecord(runId);
  if (!record) {
    throw new Error(`Workflow-Run nicht gefunden: ${runId}`);
  }
  return record;
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
  const aborted: WorkflowRunRecord = {
    ...record,
    status: "aborted",
    terminalReason: record.terminalReason ?? "Aborted by operator.",
    updatedAt: nowIso(),
  };
  writeRunRecord(aborted);
  return aborted;
}

export function listWorkflowRuns(limit = 20): WorkflowRunRecord[] {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  return listRunRecords().slice(0, normalizedLimit);
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
  opts: { json?: string; stdin?: boolean; maxRounds?: string; outputJson?: boolean },
) {
  try {
    const stdinInput = await readMaybeStdin(opts.stdin);
    const argInput = opts.json ? readJsonArg(opts.json) : undefined;
    const input = stdinInput ?? argInput ?? {};
    const maxRoundsValue = opts.maxRounds === undefined ? undefined : Number(opts.maxRounds);
    const request: WorkflowStartRequest = {
      input,
      maxRounds: Number.isFinite(maxRoundsValue) ? maxRoundsValue : undefined,
    };
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

export function workflowsAbort(runId: string, opts: { json?: boolean }) {
  try {
    const record = abortWorkflowRun(runId);
    if (opts.json) {
      printJson(record);
      return;
    }
    if (isTerminalStatus(record.status) && record.status !== "aborted") {
      console.log(`Run bereits terminal: ${record.runId} (${record.status})`);
      return;
    }
    console.log(`Run abgebrochen: ${record.runId}`);
    console.log(`Status: ${record.status}`);
    console.log(`Reason: ${record.terminalReason}`);
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
