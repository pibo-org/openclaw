import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  Codex,
  type ModelReasoningEffort,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from "@openai/codex-sdk";

const CODEX_SESSION_ROOT = path.join(homedir(), ".codex", "sessions");
const CODEX_WRAPPER_CONFIG_PATH = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
  "codex-cli-wrapper",
  "config.json",
);
const SUPPORTED_REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type CodexWorkerReasoningEffort = ModelReasoningEffort;
export type CodexWorkerFastMode = boolean;

export type CodexWorkerRuntimeOptions = {
  workingDirectory: string;
  contextWorkspaceDir?: string;
  model?: string;
  reasoningEffort?: CodexWorkerReasoningEffort;
  fastMode?: CodexWorkerFastMode;
  developerInstructions?: string;
};

export type CodexWorkerTurnResult = {
  text: string;
  threadId: string;
  usage: Usage | null;
  eventSummaries: string[];
  tracePath: string | null;
};

export type CodexWorkerCompactionResult = {
  threadId: string;
  compactionTurnId: string | null;
  notificationSummaries: string[];
  tracePath: string | null;
};

export interface CodexWorkerRuntime {
  getThreadId(): string | null;
  getTracePath(): string | null;
  prepareForRetry(): string;
  runTurn(params: {
    text: string;
    hardTimeoutSeconds: number;
    idleTimeoutSeconds: number;
    abortSignal?: AbortSignal;
  }): Promise<CodexWorkerTurnResult>;
  compactThread(params?: {
    abortSignal?: AbortSignal;
  }): Promise<CodexWorkerCompactionResult | null>;
}

type WrapperConfig = {
  model?: string;
  effort?: string;
  fastMode?: CodexWorkerFastMode;
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type UnknownRecord = Record<string, unknown>;

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcRequest = {
  id: string;
  method: string;
  params?: unknown;
};

type JsonRpcSuccessResponse = {
  id: string;
  result: JsonValue;
};

type JsonRpcErrorResponse = {
  id: string;
  error: {
    code: number;
    message: string;
    data?: JsonValue;
  };
};

type JsonRpcMessage =
  | JsonRpcNotification
  | JsonRpcRequest
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

type AppServerNotification = JsonRpcNotification;

type AppServerNotificationSummary = {
  scope: "event" | "item";
  message: string;
};

function asUnknownRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function getStringField(record: UnknownRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function getNumberField(record: UnknownRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function getStringArrayField(record: UnknownRecord | null, key: string): string[] | null {
  const value = record?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

class CodexSdkWorkerRuntimeImpl implements CodexWorkerRuntime {
  private readonly codex: Codex;
  private readonly developerInstructions?: string;
  private readonly threadOptions: {
    workingDirectory: string;
    skipGitRepoCheck: boolean;
    model?: string;
    modelReasoningEffort?: CodexWorkerReasoningEffort;
    fastMode?: CodexWorkerFastMode;
    additionalDirectories?: string[];
  };
  private thread: Thread | null = null;
  private threadId: string | null = null;

  constructor(options: CodexWorkerRuntimeOptions) {
    const workingDirectory = path.resolve(options.workingDirectory);
    const contextWorkspaceDir = options.contextWorkspaceDir?.trim()
      ? path.resolve(options.contextWorkspaceDir)
      : undefined;
    const additionalDirectories =
      contextWorkspaceDir && contextWorkspaceDir !== workingDirectory
        ? [contextWorkspaceDir]
        : undefined;
    this.developerInstructions = options.developerInstructions?.trim() || undefined;
    const codexConfig: Record<string, string> = {};
    if (this.developerInstructions) {
      codexConfig.developer_instructions = this.developerInstructions;
    }
    const serviceTier = codexServiceTierForFastMode(options.fastMode);
    if (serviceTier) {
      codexConfig.service_tier = serviceTier;
    }
    this.codex = new Codex(
      Object.keys(codexConfig).length > 0
        ? {
            config: codexConfig,
          }
        : undefined,
    );
    this.threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { modelReasoningEffort: options.reasoningEffort } : {}),
      ...(options.fastMode !== undefined ? { fastMode: options.fastMode } : {}),
      ...(additionalDirectories ? { additionalDirectories } : {}),
    };
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getTracePath(): string | null {
    return this.threadId ? resolveCodexThreadTracePath(this.threadId) : null;
  }

  prepareForRetry(): string {
    const priorThreadId = this.threadId;
    this.thread = null;
    return priorThreadId
      ? `Codex SDK will resume thread ${priorThreadId} with a fresh CLI exec process on retry.`
      : "Codex SDK will create a fresh CLI exec process on retry.";
  }

  async runTurn(params: {
    text: string;
    hardTimeoutSeconds: number;
    idleTimeoutSeconds: number;
    abortSignal?: AbortSignal;
  }): Promise<CodexWorkerTurnResult> {
    const hardTimeoutMs = Math.max(1, params.hardTimeoutSeconds) * 1_000;
    const idleTimeoutMs = Math.max(1, params.idleTimeoutSeconds) * 1_000;
    const hardTimeoutController = new AbortController();
    const idleTimeoutController = new AbortController();
    let hardTimedOut = false;
    let idleTimedOut = false;
    const hardTimeoutHandle = setTimeout(() => {
      hardTimedOut = true;
      hardTimeoutController.abort(new Error(`Timed out after ${hardTimeoutMs}ms`));
    }, hardTimeoutMs);
    let idleTimeoutHandle: NodeJS.Timeout | null = null;
    const resetIdleTimeout = () => {
      if (idleTimeoutHandle) {
        clearTimeout(idleTimeoutHandle);
      }
      idleTimeoutHandle = setTimeout(() => {
        idleTimedOut = true;
        idleTimeoutController.abort(
          new Error(`Idle timed out after ${idleTimeoutMs}ms without Codex worker events`),
        );
      }, idleTimeoutMs);
    };
    resetIdleTimeout();
    const mergedAbort = mergeAbortSignals(
      params.abortSignal,
      hardTimeoutController.signal,
      idleTimeoutController.signal,
    );
    const streamedTextByItem = new Map<string, string>();
    const eventSummaries: string[] = [];
    let usage: Usage | null = null;

    try {
      const thread = this.getOrCreateThread();
      const { events } = await thread.runStreamed(params.text, {
        signal: mergedAbort.signal,
      });
      for await (const event of events) {
        resetIdleTimeout();
        const summary = summarizeThreadEvent(event);
        if (summary) {
          eventSummaries.push(summary);
        }
        if (event.type === "thread.started") {
          this.threadId = event.thread_id;
          continue;
        }
        if (event.type === "turn.completed") {
          usage = event.usage;
          continue;
        }
        if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
        if (isThreadItemEvent(event) && event.item.type === "agent_message") {
          streamAgentMessage(streamedTextByItem, event.item);
        }
      }

      const threadId = thread.id ?? this.threadId;
      if (!threadId) {
        throw new Error("Codex worker did not expose a thread id.");
      }
      this.threadId = threadId;
      const text = [...streamedTextByItem.values()].join("").trim();
      if (!text) {
        throw new Error(
          `Codex worker produced no visible assistant message on thread ${threadId}.`,
        );
      }
      return {
        text,
        threadId,
        usage,
        eventSummaries,
        tracePath: resolveCodexThreadTracePath(threadId),
      };
    } catch (error) {
      if (params.abortSignal?.aborted) {
        throw params.abortSignal.reason ?? error;
      }
      if (idleTimedOut) {
        throw new Error(`Idle timed out after ${idleTimeoutMs}ms without Codex worker events`, {
          cause: error,
        });
      }
      if (hardTimedOut) {
        throw new Error(`Timed out after ${hardTimeoutMs}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(hardTimeoutHandle);
      if (idleTimeoutHandle) {
        clearTimeout(idleTimeoutHandle);
      }
      mergedAbort.cleanup();
    }
  }

  async compactThread(params?: {
    abortSignal?: AbortSignal;
  }): Promise<CodexWorkerCompactionResult | null> {
    const threadId = this.threadId;
    if (!threadId) {
      return null;
    }

    const client = new CodexAppServerClient({
      cwd: this.threadOptions.workingDirectory,
      developerInstructions: this.developerInstructions,
      fastMode: this.threadOptions.fastMode,
    });
    try {
      await client.start();
      await client.initialize();
      await client.request("thread/resume", {
        threadId,
        ...(this.threadOptions.model ? { model: this.threadOptions.model } : {}),
        ...(this.threadOptions.modelReasoningEffort || this.threadOptions.fastMode !== undefined
          ? {
              config: {
                ...(this.threadOptions.modelReasoningEffort
                  ? { model_reasoning_effort: this.threadOptions.modelReasoningEffort }
                  : {}),
                ...(this.threadOptions.fastMode !== undefined
                  ? { service_tier: codexServiceTierForFastMode(this.threadOptions.fastMode) }
                  : {}),
              },
            }
          : {}),
      });
      const notificationSummaries = drainNotificationSummaries(client);
      await client.request("thread/compact/start", { threadId });
      const compactionTurnId = await waitForCompaction(
        client,
        threadId,
        notificationSummaries,
        params?.abortSignal,
      );
      return {
        threadId,
        compactionTurnId,
        notificationSummaries,
        tracePath: resolveCodexThreadTracePath(threadId),
      };
    } finally {
      await client.close();
    }
  }

  private getOrCreateThread(): Thread {
    if (this.thread) {
      return this.thread;
    }
    this.thread = this.threadId
      ? this.codex.resumeThread(this.threadId, this.threadOptions)
      : this.codex.startThread(this.threadOptions);
    return this.thread;
  }
}

const require = createRequire(import.meta.url);

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: Interface | null = null;
  private lineIterator: AsyncIterator<string> | null = null;
  private pendingNotifications: AppServerNotification[] = [];
  private stderrLines: string[] = [];
  private readonly cwd: string;
  private readonly developerInstructions?: string;
  private readonly fastMode?: CodexWorkerFastMode;

  constructor(options: {
    cwd: string;
    developerInstructions?: string;
    fastMode?: CodexWorkerFastMode;
  }) {
    this.cwd = options.cwd;
    this.developerInstructions = options.developerInstructions?.trim() || undefined;
    this.fastMode = options.fastMode;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    const args = [resolveCodexCliScript(), "app-server", "--listen", "stdio://"];
    if (this.developerInstructions) {
      args.push(
        "--config",
        `developer_instructions=${serializeTomlString(this.developerInstructions)}`,
      );
    }
    const serviceTier = codexServiceTierForFastMode(this.fastMode);
    if (serviceTier) {
      args.push("--config", `service_tier=${serializeTomlString(serviceTier)}`);
    }
    const child = spawn(process.execPath, args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      this.stderrLines.push(...lines);
      this.stderrLines = this.stderrLines.slice(-40);
    });
    const lineReader = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.child = child;
    this.lineReader = lineReader;
    this.lineIterator = lineReader[Symbol.asyncIterator]();
  }

  async close(): Promise<void> {
    if (!this.child) {
      return;
    }
    const child = this.child;
    const lineReader = this.lineReader;
    this.child = null;
    this.lineReader = null;
    this.lineIterator = null;
    this.pendingNotifications = [];
    lineReader?.close();
    if (child.stdin.writable) {
      child.stdin.end();
    }
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill();
      await once(child, "exit");
    }
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "openclaw_codex_controller",
        title: "OpenClaw Codex Controller",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
  }

  notify(method: string, params: JsonObject = {}): void {
    this.writeMessage({
      method,
      params,
    });
  }

  async request(method: string, params: JsonObject = {}): Promise<JsonValue> {
    const requestId = randomUUID();
    this.writeMessage({
      id: requestId,
      method,
      params,
    });
    while (true) {
      const message = await this.readMessage();
      if (isServerRequest(message)) {
        this.writeMessage({
          id: message.id,
          result: {},
        });
        continue;
      }
      if (isNotification(message)) {
        this.pendingNotifications.push(message);
        continue;
      }
      if (!isResponse(message) || message.id !== requestId) {
        continue;
      }
      if ("error" in message) {
        throw new Error(message.error.message);
      }
      return message.result;
    }
  }

  drainPendingNotifications(): AppServerNotification[] {
    const notifications = this.pendingNotifications;
    this.pendingNotifications = [];
    return notifications;
  }

  async nextNotification(): Promise<AppServerNotification> {
    const pending = this.pendingNotifications.shift();
    if (pending) {
      return pending;
    }
    while (true) {
      const message = await this.readMessage();
      if (isServerRequest(message)) {
        this.writeMessage({
          id: message.id,
          result: {},
        });
        continue;
      }
      if (isNotification(message)) {
        return message;
      }
    }
  }

  private writeMessage(payload: JsonObject): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Codex app server is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async readMessage(): Promise<JsonRpcMessage> {
    if (!this.lineIterator) {
      throw new Error("Codex app server is not running.");
    }
    const result = await this.lineIterator.next();
    if (result.done || result.value === undefined) {
      throw new Error(`Codex app server closed stdout. stderr_tail=${this.stderrTail()}`);
    }
    try {
      return JSON.parse(result.value) as JsonRpcMessage;
    } catch (error) {
      throw new Error(`Invalid JSON-RPC line: ${result.value}`, { cause: error });
    }
  }

  private stderrTail(): string {
    return this.stderrLines.join("\n").slice(-2000);
  }
}

export function createCodexSdkWorkerRuntime(
  options: CodexWorkerRuntimeOptions,
): CodexWorkerRuntime {
  return new CodexSdkWorkerRuntimeImpl(options);
}

export function resolveCodexWorkerDefaultOptions(params?: {
  model?: string;
  reasoningEffort?: unknown;
  fastMode?: unknown;
}): {
  model?: string;
  reasoningEffort?: CodexWorkerReasoningEffort;
  fastMode?: CodexWorkerFastMode;
} {
  const configured = loadWrapperConfig();
  const explicitReasoningEffort = normalizeReasoningEffort(params?.reasoningEffort);
  const explicitFastMode = normalizeFastMode(params?.fastMode);
  return {
    model: params?.model?.trim() || configured.model,
    reasoningEffort: explicitReasoningEffort ?? normalizeReasoningEffort(configured.effort),
    fastMode: explicitFastMode ?? configured.fastMode,
  };
}

function loadWrapperConfig(): WrapperConfig {
  if (!existsSync(CODEX_WRAPPER_CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(CODEX_WRAPPER_CONFIG_PATH, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const config = raw as { model?: unknown; effort?: unknown; fastMode?: unknown };
    return {
      model:
        typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined,
      effort:
        typeof config.effort === "string" && config.effort.trim()
          ? config.effort.trim()
          : undefined,
      fastMode: normalizeFastMode(config.fastMode),
    };
  } catch {
    return {};
  }
}

function normalizeReasoningEffort(value: unknown): CodexWorkerReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const effort = value.trim() as CodexWorkerReasoningEffort;
  return SUPPORTED_REASONING_EFFORTS.has(effort) ? effort : undefined;
}

function normalizeFastMode(value: unknown): CodexWorkerFastMode | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes", "fast"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no", "default"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function codexServiceTierForFastMode(
  fastMode: CodexWorkerFastMode | undefined,
): string | undefined {
  if (fastMode === undefined) {
    return undefined;
  }
  return fastMode ? "fast" : "flex";
}

function serializeTomlString(value: string): string {
  return JSON.stringify(value);
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
  const forwardAbort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      forwardAbort(signal);
      continue;
    }
    const handler = () => forwardAbort(signal);
    signal.addEventListener("abort", handler, { once: true });
    listeners.push({ signal, handler });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, handler } of listeners) {
        signal.removeEventListener("abort", handler);
      }
    },
  };
}

function streamAgentMessage(
  streamedTextByItem: Map<string, string>,
  item: { id: string; text: string },
): void {
  streamedTextByItem.set(item.id, item.text);
}

function isThreadItemEvent(
  event: ThreadEvent,
): event is Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }> {
  return (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  );
}

function summarizeThreadEvent(event: ThreadEvent): string | null {
  switch (event.type) {
    case "thread.started":
      return `thread.started thread_id=${event.thread_id}`;
    case "turn.started":
      return "turn.started";
    case "turn.completed":
      return `turn.completed input=${event.usage.input_tokens} output=${event.usage.output_tokens} cached=${event.usage.cached_input_tokens}`;
    case "turn.failed":
      return `turn.failed message=${event.error.message}`;
    case "error":
      return `error message=${event.message}`;
    case "item.started":
    case "item.updated":
    case "item.completed":
      return summarizeThreadItemEvent(event.type, event.item);
  }
}

function summarizeThreadItemEvent(
  eventType: "item.started" | "item.updated" | "item.completed",
  item: ThreadItem,
): string | null {
  switch (item.type) {
    case "agent_message":
    case "reasoning":
      return null;
    case "command_execution": {
      const exitCode = item.exit_code === undefined ? "" : ` exit_code=${item.exit_code}`;
      return `${eventType} ${item.type} status=${item.status}${exitCode} command=${item.command}`;
    }
    case "web_search":
      return `${eventType} ${item.type} query=${item.query}`;
    case "mcp_tool_call":
      return `${eventType} ${item.type} status=${item.status} server=${item.server} tool=${item.tool}`;
    case "file_change": {
      const changes = item.changes.map((change) => `${change.kind}:${change.path}`).join(", ");
      return `${eventType} ${item.type} status=${item.status} changes=${changes || "none"}`;
    }
    case "todo_list":
      return `${eventType} ${item.type} items=${item.items.length}`;
    case "error":
      return `${eventType} ${item.type} message=${item.message}`;
  }
}

function resolveCodexCliScript(): string {
  return require.resolve("@openai/codex/bin/codex.js");
}

function resolveCodexThreadTracePath(threadId: string): string | null {
  if (!threadId || !existsSync(CODEX_SESSION_ROOT)) {
    return null;
  }
  try {
    const output = execFileSync(
      "find",
      [CODEX_SESSION_ROOT, "-type", "f", "-name", `*${threadId}*.jsonl`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return output.at(-1) ?? null;
  } catch {
    return null;
  }
}

function drainNotificationSummaries(client: CodexAppServerClient): string[] {
  return client
    .drainPendingNotifications()
    .map(summarizeAppServerNotification)
    .filter((summary): summary is AppServerNotificationSummary => summary !== null)
    .map((summary) => summary.message);
}

async function waitForCompaction(
  client: CodexAppServerClient,
  threadId: string,
  notificationSummaries: string[],
  abortSignal?: AbortSignal,
): Promise<string | null> {
  let compactionTurnId: string | null = null;
  while (true) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error("Workflow abort requested during Codex compaction.");
    }
    for (const notification of client.drainPendingNotifications()) {
      const next = handleCompactionNotification(notification, threadId, compactionTurnId);
      if (next.summary) {
        notificationSummaries.push(next.summary);
      }
      compactionTurnId = next.turnId;
      if (next.completed) {
        return compactionTurnId;
      }
    }
    const notification = await client.nextNotification();
    const next = handleCompactionNotification(notification, threadId, compactionTurnId);
    if (next.summary) {
      notificationSummaries.push(next.summary);
    }
    compactionTurnId = next.turnId;
    if (next.completed) {
      return compactionTurnId;
    }
  }
}

function handleCompactionNotification(
  notification: AppServerNotification,
  threadId: string,
  currentTurnId: string | null,
): { completed: boolean; turnId: string | null; summary: string | null } {
  const summarized = summarizeAppServerNotification(notification);
  const params = asUnknownRecord(notification.params);
  const turn = asUnknownRecord(params?.turn);
  const paramsThreadId = getStringField(params, "threadId");
  const turnId = getStringField(turn, "id");
  const compactedTurnId = getStringField(params, "turnId");
  const errorMessage = getStringField(params, "message");
  let nextTurnId = currentTurnId;
  if (notification.method === "turn/started" && paramsThreadId === threadId && turnId) {
    nextTurnId = turnId;
  }
  if (
    notification.method === "turn/completed" &&
    paramsThreadId === threadId &&
    turnId &&
    (nextTurnId === null || turnId === nextTurnId)
  ) {
    return {
      completed: true,
      turnId,
      summary: summarized?.message ?? null,
    };
  }
  if (
    notification.method === "thread/compacted" &&
    paramsThreadId === threadId &&
    compactedTurnId
  ) {
    return {
      completed: true,
      turnId: compactedTurnId,
      summary: summarized?.message ?? null,
    };
  }
  if (notification.method === "error" && errorMessage) {
    throw new Error(errorMessage);
  }
  return {
    completed: false,
    turnId: nextTurnId,
    summary: summarized?.message ?? null,
  };
}

function summarizeAppServerNotification(
  notification: AppServerNotification,
): AppServerNotificationSummary | null {
  const params = asUnknownRecord(notification.params);
  if (notification.method === "mcpServer/startupStatus/updated" && params) {
    const errorMessage = getStringField(params, "error");
    const errorSuffix = errorMessage ? ` error=${errorMessage}` : "";
    return {
      scope: "event",
      message:
        `mcpServer/startupStatus/updated name=${getStringField(params, "name")} ` +
        `status=${getStringField(params, "status")}${errorSuffix}`,
    };
  }
  if (notification.method === "thread/status/changed" && params) {
    const status = asUnknownRecord(params.status);
    const activeFlags = getStringArrayField(status, "activeFlags")?.join(",") ?? "";
    return {
      scope: "event",
      message:
        `thread/status/changed thread_id=${getStringField(params, "threadId")} ` +
        `status=${getStringField(status, "type")}${activeFlags ? ` active_flags=${activeFlags}` : ""}`,
    };
  }
  if (notification.method === "turn/started" && params) {
    const turn = asUnknownRecord(params.turn);
    return {
      scope: "event",
      message:
        `turn/started thread_id=${getStringField(params, "threadId")} ` +
        `turn_id=${getStringField(turn, "id")}`,
    };
  }
  if (notification.method === "turn/completed" && params) {
    const turn = asUnknownRecord(params.turn);
    const durationMs = getNumberField(turn, "durationMs");
    const duration = durationMs === null ? "" : ` duration_ms=${durationMs}`;
    return {
      scope: "event",
      message:
        `turn/completed thread_id=${getStringField(params, "threadId")} ` +
        `turn_id=${getStringField(turn, "id")} status=${getStringField(turn, "status")}${duration}`,
    };
  }
  if (
    (notification.method === "item/started" || notification.method === "item/completed") &&
    params
  ) {
    const item = asUnknownRecord(params.item);
    return {
      scope: "item",
      message:
        `${notification.method} thread_id=${getStringField(params, "threadId")} ` +
        `turn_id=${getStringField(params, "turnId")} item_type=${getStringField(item, "type")} ` +
        `item_id=${getStringField(item, "id")}`,
    };
  }
  if (notification.method === "thread/tokenUsage/updated" && params) {
    const tokenUsage = asUnknownRecord(params.tokenUsage);
    const totals = asUnknownRecord(tokenUsage?.total);
    return {
      scope: "event",
      message:
        `thread/tokenUsage/updated thread_id=${getStringField(params, "threadId")} ` +
        `turn_id=${getStringField(params, "turnId")} input=${getNumberField(totals, "inputTokens")} ` +
        `output=${getNumberField(totals, "outputTokens")} ` +
        `cached=${getNumberField(totals, "cachedInputTokens")} ` +
        `total=${getNumberField(totals, "totalTokens")} ` +
        `window=${getNumberField(tokenUsage, "modelContextWindow")}`,
    };
  }
  if (notification.method === "thread/compacted" && params) {
    return {
      scope: "event",
      message:
        `thread/compacted thread_id=${getStringField(params, "threadId")} ` +
        `turn_id=${getStringField(params, "turnId")}`,
    };
  }
  if (notification.method === "error") {
    return {
      scope: "event",
      message: `error message=${getStringField(params, "message") ?? "unknown"}`,
    };
  }
  return notification.method
    ? {
        scope: "event",
        message: notification.method,
      }
    : null;
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function isServerRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

function isResponse(
  message: JsonRpcMessage,
): message is JsonRpcSuccessResponse | JsonRpcErrorResponse {
  return "id" in message && ("result" in message || "error" in message);
}
