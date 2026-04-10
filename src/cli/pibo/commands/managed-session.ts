import type { Command } from "commander";
import { resolveDefaultAgentId } from "../../../agents/agent-scope.js";
import { createDefaultDeps } from "../../../cli/deps.js";
import { loadConfig } from "../../../config/config.js";
import { coreGatewayHandlers } from "../../../gateway/server-methods.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { loadGatewaySessionRow } from "../../../gateway/session-utils.js";
import { formatTimeAgo } from "../../../infra/format-time/format-relative.ts";
import {
  buildManagedWorkflowSessionKey,
  classifyManagedSessionType,
  createRuntimeManagedSessions,
  type ManagedSessionResolveParams,
  type ManagedSessionsListResult,
  type ManagedSessionType,
} from "../../../plugins/runtime/runtime-managed-sessions.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";

type JsonRecord = Record<string, unknown>;
const DEFAULT_MANAGED_SESSION_LIST_LIMIT = 10;
const TYPE_PAD = 6;
const AGENT_PAD = 10;
const AGE_PAD = 9;
const STATUS_PAD = 9;
const SESSION_PAD = 42;
const LABEL_PAD = 28;

const unavailableSubagent = {
  run: async () => {
    throw new Error("managed-session CLI cannot run subagents directly");
  },
  waitForRun: async () => {
    throw new Error("managed-session CLI cannot wait for subagents directly");
  },
  getSessionMessages: async () => {
    throw new Error("managed-session CLI cannot read session messages directly");
  },
  getSession: async () => {
    throw new Error("managed-session CLI cannot read sessions directly");
  },
  deleteSession: async () => {
    throw new Error("managed-session CLI cannot delete sessions directly");
  },
};

const managedSessions = createRuntimeManagedSessions(unavailableSubagent);

function createMinimalGatewayContext(): GatewayRequestContext {
  return {
    deps: createDefaultDeps(),
    cron: {} as GatewayRequestContext["cron"],
    cronStorePath: "/tmp/openclaw-cron.json",
    loadGatewayModelCatalog: async () => [],
    getHealthCache: () => null,
    refreshHealthSnapshot: async () =>
      ({ ok: true }) as unknown as Awaited<
        ReturnType<GatewayRequestContext["refreshHealthSnapshot"]>
      >,
    logHealth: { error: () => {} },
    logGateway: {
      subsystem: "managed-session-cli",
      isEnabled: () => false,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: () => undefined,
      withBindings: () => undefined,
    } as unknown as GatewayRequestContext["logGateway"],
    incrementPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    broadcast: () => {},
    broadcastToConnIds: () => {},
    nodeSendToSession: () => {},
    nodeSendToAllSubscribed: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    nodeUnsubscribeAll: () => {},
    hasConnectedMobileNode: () => false,
    nodeRegistry: {} as GatewayRequestContext["nodeRegistry"],
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    addChatRun: () => {},
    removeChatRun: () => undefined,
    subscribeSessionEvents: () => {},
    unsubscribeSessionEvents: () => {},
    subscribeSessionMessageEvents: () => {},
    unsubscribeSessionMessageEvents: () => {},
    unsubscribeAllSessionEvents: () => {},
    getSessionEventSubscriberConnIds: () => new Set(),
    registerToolEventRecipient: () => {},
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: () => null,
    purgeWizardSession: () => {},
    getRuntimeSnapshot: () =>
      ({ channels: [] }) as unknown as ReturnType<GatewayRequestContext["getRuntimeSnapshot"]>,
    startChannel: async () => {},
    stopChannel: async () => {},
    markChannelLoggedOut: () => {},
    wizardRunner: async () => {},
    broadcastVoiceWakeChanged: () => {},
  };
}

async function callGatewayMethod<T = unknown>(method: string, params: JsonRecord = {}) {
  const handler = coreGatewayHandlers[method];
  if (!handler) {
    throw new Error(`Unknown gateway method: ${method}`);
  }

  let result: { ok: boolean; payload?: unknown; error?: { message?: string } } | undefined;
  await handler({
    req: { type: "req", id: `managed-session-cli-${Date.now()}`, method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      result = { ok, payload, error: error as { message?: string } | undefined };
    },
    context: createMinimalGatewayContext(),
  });

  if (!result) {
    throw new Error(`Gateway method ${method} returned no result`);
  }
  if (!result.ok) {
    throw new Error(result.error?.message ?? `Gateway method ${method} failed`);
  }
  return result.payload as T;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printLines(lines: string[]) {
  for (const line of lines) {
    console.log(line);
  }
}

function readScalarString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function parseOptionalInteger(value: unknown): number | undefined {
  const raw = readScalarString(value);
  if (value == null || raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const raw = readScalarString(value);
  if (value == null || raw === undefined || raw === "") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parseOptionalJsonObject(raw: unknown): JsonRecord {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--patch must be a JSON object");
  }
  return parsed as JsonRecord;
}

function nullableStringOption(value: unknown, clear: unknown): string | null | undefined {
  if (clear === true) {
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function buildPatchFromOptions(key: string, opts: Record<string, unknown>): JsonRecord {
  const patch: JsonRecord = { key, ...parseOptionalJsonObject(opts.patch) };

  const label = nullableStringOption(opts.label, opts.clearLabel);
  if (label !== undefined) {
    patch.label = label;
  }

  const model = nullableStringOption(opts.model, opts.clearModel);
  if (model !== undefined) {
    patch.model = model;
  }

  const thinkingLevel = nullableStringOption(opts.thinkingLevel, opts.clearThinkingLevel);
  if (thinkingLevel !== undefined) {
    patch.thinkingLevel = thinkingLevel;
  }

  const verboseLevel = nullableStringOption(opts.verboseLevel, opts.clearVerboseLevel);
  if (verboseLevel !== undefined) {
    patch.verboseLevel = verboseLevel;
  }

  const reasoningLevel = nullableStringOption(opts.reasoningLevel, opts.clearReasoningLevel);
  if (reasoningLevel !== undefined) {
    patch.reasoningLevel = reasoningLevel;
  }

  const elevatedLevel = nullableStringOption(opts.elevatedLevel, opts.clearElevatedLevel);
  if (elevatedLevel !== undefined) {
    patch.elevatedLevel = elevatedLevel;
  }

  const spawnedBy = nullableStringOption(opts.spawnedBy, opts.clearSpawnedBy);
  if (spawnedBy !== undefined) {
    patch.spawnedBy = spawnedBy;
  }

  const spawnedWorkspaceDir = nullableStringOption(
    opts.spawnedWorkspaceDir,
    opts.clearSpawnedWorkspaceDir,
  );
  if (spawnedWorkspaceDir !== undefined) {
    patch.spawnedWorkspaceDir = spawnedWorkspaceDir;
  }

  const execHost = nullableStringOption(opts.execHost, opts.clearExecHost);
  if (execHost !== undefined) {
    patch.execHost = execHost;
  }

  const execSecurity = nullableStringOption(opts.execSecurity, opts.clearExecSecurity);
  if (execSecurity !== undefined) {
    patch.execSecurity = execSecurity;
  }

  const execAsk = nullableStringOption(opts.execAsk, opts.clearExecAsk);
  if (execAsk !== undefined) {
    patch.execAsk = execAsk;
  }

  const execNode = nullableStringOption(opts.execNode, opts.clearExecNode);
  if (execNode !== undefined) {
    patch.execNode = execNode;
  }

  const fastMode = parseOptionalBoolean(opts.fastMode);
  if (fastMode !== undefined) {
    patch.fastMode = fastMode;
  }

  const spawnDepth = parseOptionalInteger(opts.spawnDepth);
  if (spawnDepth !== undefined) {
    patch.spawnDepth = spawnDepth;
  }

  if (typeof opts.subagentRole === "string" && opts.subagentRole.trim()) {
    patch.subagentRole = opts.subagentRole.trim();
  }
  if (typeof opts.subagentControlScope === "string" && opts.subagentControlScope.trim()) {
    patch.subagentControlScope = opts.subagentControlScope.trim();
  }
  if (typeof opts.sendPolicy === "string" && opts.sendPolicy.trim()) {
    patch.sendPolicy = opts.sendPolicy.trim();
  }
  if (typeof opts.groupActivation === "string" && opts.groupActivation.trim()) {
    patch.groupActivation = opts.groupActivation.trim();
  }
  if (typeof opts.responseUsage === "string" && opts.responseUsage.trim()) {
    patch.responseUsage = opts.responseUsage.trim();
  }

  return patch;
}

function parseManagedSessionTypeOption(value: unknown): ManagedSessionType {
  const normalized = readScalarString(value)?.trim().toLowerCase();
  if (!normalized || normalized === "pibo") {
    return "pibo";
  }
  if (normalized === "native" || normalized === "both") {
    return normalized;
  }
  throw new Error(`Invalid --session-type value: ${String(value)}`);
}

function pad(value: string, width: number) {
  return value.padEnd(width);
}

function truncate(value: string, width: number) {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
}

function formatManagedSessionTarget(key: string) {
  const parsed = parseAgentSessionKey(key);
  if (!parsed) {
    return key;
  }
  if (key.includes(":pibo:")) {
    return parsed.rest.replace(/^pibo:/, "");
  }
  return parsed.rest;
}

export function renderManagedSessionList(result: ManagedSessionsListResult): string[] {
  if (result.sessions.length === 0) {
    return [`No ${result.sessionType} sessions found.`];
  }

  const header = [
    pad("Type", TYPE_PAD),
    pad("Agent", AGENT_PAD),
    pad("Age", AGE_PAD),
    pad("Status", STATUS_PAD),
    pad("Session", SESSION_PAD),
    pad("Label", LABEL_PAD),
  ].join(" ");

  const lines = [header];
  for (const session of result.sessions) {
    const parsed = parseAgentSessionKey(session.key);
    const type = classifyManagedSessionType(session.key);
    const age = session.updatedAt ? formatTimeAgo(Date.now() - session.updatedAt) : "-";
    const status = session.status ?? "-";
    const target = formatManagedSessionTarget(session.key);
    const label = session.displayName ?? session.label ?? session.derivedTitle ?? "-";
    lines.push(
      [
        pad(type, TYPE_PAD),
        pad(parsed?.agentId ?? "-", AGENT_PAD),
        pad(age, AGE_PAD),
        pad(status, STATUS_PAD),
        pad(truncate(target, SESSION_PAD), SESSION_PAD),
        pad(truncate(label, LABEL_PAD), LABEL_PAD),
      ]
        .join(" ")
        .trimEnd(),
    );
  }

  if (result.truncated) {
    lines.push(
      `Showing ${result.shownCount} of ${result.totalCount} ${result.sessionType} sessions. Use --all or --limit <n> for more.`,
    );
  } else {
    lines.push(`Showing ${result.shownCount} ${result.sessionType} sessions.`);
  }
  return lines;
}

export async function managedSessionSmoke() {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const flowId = `smoke-${Date.now()}`;
  const sessionKey = buildManagedWorkflowSessionKey({
    flowId,
    role: "worker",
    name: "main",
    agentId,
  });

  const created = await callGatewayMethod("sessions.create", {
    key: sessionKey,
    agentId,
    label: `PIBo Managed Session Smoke ${flowId}`,
  });

  const run = await callGatewayMethod<{ runId?: string }>("agent", {
    sessionKey,
    message: "This is a managed-session smoke test. Reply with exactly: MANAGED_SESSION_SMOKE_OK",
    deliver: false,
    idempotencyKey: `managed-session-smoke-${Date.now()}`,
  });

  const waited = run.runId
    ? await callGatewayMethod<{ status?: string; error?: string }>("agent.wait", {
        runId: run.runId,
        timeoutMs: 120000,
      })
    : undefined;

  const session = await callGatewayMethod("sessions.get", {
    key: sessionKey,
    limit: 20,
  });

  const result = {
    agentId,
    flowId,
    sessionKey,
    created,
    run,
    waited,
    session,
  };
  printJson(result);
  return result;
}

export function registerManagedSessionCommands(managed: Command) {
  managed
    .command("smoke")
    .description("Ersten managed-session smoke test ausführen")
    .action(async () => {
      await managedSessionSmoke();
    });

  managed
    .command("list")
    .description("Managed/agent Sessions listen")
    .option("-a, --all", "Alle passenden Sessions anzeigen")
    .option("--json", "JSON-Ausgabe")
    .option("--limit <n>", "Maximale Anzahl")
    .option("--session-type <type>", "pibo|native|both", "pibo")
    .option("--active-minutes <n>", "Nur kürzlich aktive Sessions")
    .option("--include-global", "Globale Session einschließen")
    .option("--include-unknown", "Unknown Session einschließen")
    .option("--include-derived-titles", "Abgeleitete Titel lesen")
    .option("--include-last-message", "Letzte Nachricht als Preview lesen")
    .option("--label <label>", "Nach Label filtern")
    .option("--spawned-by <key>", "Nach Parent/Spawner filtern")
    .option("--agent-id <id>", "Nach Agent filtern")
    .option("--search <text>", "Textsuche")
    .action(async (opts) => {
      const result = await managedSessions.list({
        ...(opts.all ? { all: true } : {}),
        limit: opts.all
          ? undefined
          : (parseOptionalInteger(opts.limit) ?? DEFAULT_MANAGED_SESSION_LIST_LIMIT),
        sessionType: parseManagedSessionTypeOption(opts.sessionType),
        ...(parseOptionalInteger(opts.activeMinutes) !== undefined
          ? { activeMinutes: parseOptionalInteger(opts.activeMinutes) }
          : {}),
        ...(opts.includeGlobal ? { includeGlobal: true } : {}),
        ...(opts.includeUnknown ? { includeUnknown: true } : {}),
        ...(opts.includeDerivedTitles ? { includeDerivedTitles: true } : {}),
        ...(opts.includeLastMessage ? { includeLastMessage: true } : {}),
        ...(typeof opts.label === "string" && opts.label.trim()
          ? { label: opts.label.trim() }
          : {}),
        ...(typeof opts.spawnedBy === "string" && opts.spawnedBy.trim()
          ? { spawnedBy: opts.spawnedBy.trim() }
          : {}),
        ...(typeof opts.agentId === "string" && opts.agentId.trim()
          ? { agentId: opts.agentId.trim() }
          : {}),
        ...(typeof opts.search === "string" && opts.search.trim()
          ? { search: opts.search.trim() }
          : {}),
      });
      if (opts.json) {
        printJson(result);
        return;
      }
      printLines(renderManagedSessionList(result));
    });

  managed
    .command("resolve")
    .description("Session-Key aus key/sessionId/label auflösen")
    .option("--json", "JSON-Ausgabe")
    .option("--key <key>", "Expliziter Session-Key")
    .option("--session-id <id>", "Session-ID")
    .option("--label <label>", "Session-Label")
    .option("--session-type <type>", "pibo|native|both", "pibo")
    .option("--agent-id <id>", "Agent-ID Filter")
    .option("--spawned-by <key>", "Spawner/Parent Filter")
    .option("--include-global", "Globale Session einschließen")
    .option("--include-unknown", "Unknown Session einschließen")
    .action(async (opts) => {
      const selector = {
        ...(typeof opts.key === "string" && opts.key.trim() ? { key: opts.key.trim() } : {}),
        ...(typeof opts.sessionId === "string" && opts.sessionId.trim()
          ? { sessionId: opts.sessionId.trim() }
          : {}),
        ...(typeof opts.label === "string" && opts.label.trim()
          ? { label: opts.label.trim() }
          : {}),
        ...(typeof opts.agentId === "string" && opts.agentId.trim()
          ? { agentId: opts.agentId.trim() }
          : {}),
        ...(typeof opts.spawnedBy === "string" && opts.spawnedBy.trim()
          ? { spawnedBy: opts.spawnedBy.trim() }
          : {}),
        ...(opts.includeGlobal ? { includeGlobal: true } : {}),
        ...(opts.includeUnknown ? { includeUnknown: true } : {}),
        sessionType: parseManagedSessionTypeOption(opts.sessionType),
      } satisfies ManagedSessionResolveParams;
      const result = await managedSessions.resolveSelector(selector);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      if (opts.json) {
        printJson({
          ok: true,
          key: result.key,
          sessionType: classifyManagedSessionType(result.key),
          row: loadGatewaySessionRow(result.key),
        });
        return;
      }
      console.log(result.key);
    });

  managed
    .command("status")
    .alias("get")
    .description("Session-Status inkl. Transcript anzeigen")
    .argument("<key>", "Session-Key")
    .option("--limit <n>", "Maximale Nachrichtenanzahl", "50")
    .action(async (key, opts) => {
      const limit = parseOptionalInteger(opts.limit) ?? 50;
      const session = await managedSessions.status({ key: String(key).trim(), limit });
      const row = session.row ?? loadGatewaySessionRow(String(key).trim());
      printJson({
        key: String(key).trim(),
        row,
        session,
      });
    });

  managed
    .command("add")
    .alias("create")
    .description("Neue managed Session anlegen")
    .requiredOption("--key <key>", "Session-Key")
    .option("--agent-id <id>", "Agent-ID")
    .option("--label <label>", "Label")
    .option("--model <model>", "Model-Override")
    .option("--parent-session-key <key>", "Parent-Session-Key")
    .option("--task <text>", "Initiale Task")
    .option("--message <text>", "Initiale Nachricht")
    .action(async (opts) => {
      printJson(
        await callGatewayMethod("sessions.create", {
          key: opts.key,
          ...(typeof opts.agentId === "string" && opts.agentId.trim()
            ? { agentId: opts.agentId.trim() }
            : {}),
          ...(typeof opts.label === "string" && opts.label.trim()
            ? { label: opts.label.trim() }
            : {}),
          ...(typeof opts.model === "string" && opts.model.trim()
            ? { model: opts.model.trim() }
            : {}),
          ...(typeof opts.parentSessionKey === "string" && opts.parentSessionKey.trim()
            ? { parentSessionKey: opts.parentSessionKey.trim() }
            : {}),
          ...(typeof opts.task === "string" ? { task: opts.task } : {}),
          ...(typeof opts.message === "string" ? { message: opts.message } : {}),
        }),
      );
    });

  managed
    .command("edit")
    .alias("patch")
    .description("Managed Session bearbeiten")
    .argument("<key>", "Session-Key")
    .option("--patch <json>", "Direkter JSON-Patch")
    .option("--label <label>", "Label setzen")
    .option("--clear-label", "Label löschen")
    .option("--model <model>", "Model setzen")
    .option("--clear-model", "Model löschen")
    .option("--thinking-level <value>", "Thinking-Level setzen")
    .option("--clear-thinking-level", "Thinking-Level löschen")
    .option("--verbose-level <value>", "Verbose-Level setzen")
    .option("--clear-verbose-level", "Verbose-Level löschen")
    .option("--reasoning-level <value>", "Reasoning-Level setzen")
    .option("--clear-reasoning-level", "Reasoning-Level löschen")
    .option("--elevated-level <value>", "Elevated-Level setzen")
    .option("--clear-elevated-level", "Elevated-Level löschen")
    .option("--fast-mode <bool>", "Fast-Mode true/false")
    .option("--response-usage <mode>", "off|tokens|full|on")
    .option("--spawned-by <key>", "spawnedBy setzen")
    .option("--clear-spawned-by", "spawnedBy löschen")
    .option("--spawned-workspace-dir <dir>", "spawnedWorkspaceDir setzen")
    .option("--clear-spawned-workspace-dir", "spawnedWorkspaceDir löschen")
    .option("--spawn-depth <n>", "spawnDepth setzen")
    .option("--subagent-role <role>", "orchestrator|leaf")
    .option("--subagent-control-scope <scope>", "children|none")
    .option("--send-policy <policy>", "allow|deny")
    .option("--group-activation <mode>", "mention|always")
    .option("--exec-host <value>", "execHost setzen")
    .option("--clear-exec-host", "execHost löschen")
    .option("--exec-security <value>", "execSecurity setzen")
    .option("--clear-exec-security", "execSecurity löschen")
    .option("--exec-ask <value>", "execAsk setzen")
    .option("--clear-exec-ask", "execAsk löschen")
    .option("--exec-node <value>", "execNode setzen")
    .option("--clear-exec-node", "execNode löschen")
    .action(async (key, opts) => {
      printJson(
        await callGatewayMethod("sessions.patch", buildPatchFromOptions(String(key), opts)),
      );
    });

  managed
    .command("delete")
    .alias("rm")
    .description("Managed Session löschen")
    .argument("<key>", "Session-Key")
    .option("--keep-transcript", "Transcript nicht archivieren/löschen")
    .action(async (key, opts) => {
      printJson(
        await callGatewayMethod("sessions.delete", {
          key,
          deleteTranscript: !opts.keepTranscript,
        }),
      );
    });

  managed
    .command("reset")
    .description("Managed Session zurücksetzen")
    .argument("<key>", "Session-Key")
    .option("--reason <reason>", "new|reset", "reset")
    .action(async (key, opts) => {
      printJson(await callGatewayMethod("sessions.reset", { key, reason: opts.reason }));
    });

  managed
    .command("compact")
    .description("Transcript brutal auf die letzten Zeilen kürzen")
    .argument("<key>", "Session-Key")
    .option("--max-lines <n>", "Anzahl Zeilen", "400")
    .action(async (key, opts) => {
      printJson(
        await callGatewayMethod("sessions.compact", {
          key,
          maxLines: parseOptionalInteger(opts.maxLines) ?? 400,
        }),
      );
    });

  managed
    .command("send")
    .description("Nachricht an Session senden")
    .argument("<key>", "Session-Key")
    .argument("<message>", "Nachricht")
    .option("--thinking <value>", "Thinking-Override")
    .option("--timeout <ms>", "Wait-Budget in ms")
    .option("--idempotency-key <key>", "Idempotency-Key")
    .action(async (key, message, opts) => {
      printJson(
        await callGatewayMethod("sessions.send", {
          key,
          message,
          ...(typeof opts.thinking === "string" && opts.thinking.trim()
            ? { thinking: opts.thinking.trim() }
            : {}),
          ...(parseOptionalInteger(opts.timeout) !== undefined
            ? { timeoutMs: parseOptionalInteger(opts.timeout) }
            : {}),
          ...(typeof opts.idempotencyKey === "string" && opts.idempotencyKey.trim()
            ? { idempotencyKey: opts.idempotencyKey.trim() }
            : {}),
        }),
      );
    });

  managed
    .command("abort")
    .description("Aktiven Run einer Session abbrechen")
    .argument("<key>", "Session-Key")
    .option("--run-id <id>", "Explizite Run-ID")
    .action(async (key, opts) => {
      printJson(
        await callGatewayMethod("sessions.abort", {
          key,
          ...(typeof opts.runId === "string" && opts.runId.trim()
            ? { runId: opts.runId.trim() }
            : {}),
        }),
      );
    });
}
