import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import {
  type SessionsListParams,
  type SessionsResolveParams,
} from "../../gateway/protocol/index.js";
import { ErrorCodes, errorShape } from "../../gateway/protocol/index.js";
import { performGatewaySessionReset } from "../../gateway/session-reset-service.js";
import {
  archiveSessionTranscriptsForSession,
  cleanupSessionBeforeMutation,
  emitSessionUnboundLifecycleEvent,
} from "../../gateway/session-reset-service.js";
import {
  archiveFileOnDisk,
  buildGatewaySessionRow,
  getSessionDefaults,
  loadSessionEntry,
  loadGatewaySessionRow,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionMessages,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  type GatewaySessionRow,
  type SessionsListResult,
} from "../../gateway/session-utils.js";
import type { SessionsPatchResult } from "../../gateway/session-utils.types.js";
import { applySessionsPatchToStore } from "../../gateway/sessions-patch.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { PluginRuntime } from "./types.js";

function normalizeSegment(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "");
}

export type ManagedSessionPolicy = "ephemeral" | "reusable" | "sticky" | "reset-on-reuse";
export type ManagedSessionRole =
  | "worker"
  | "critic"
  | "planner"
  | "orchestrator"
  | "specialist"
  | "scratch";

export type ManagedSessionLifecycleDecision = {
  shouldCreate: boolean;
  shouldResetBeforeRun: boolean;
  shouldDeleteAfterRun: boolean;
};

export function decideManagedSessionLifecycle(params: {
  exists: boolean;
  policy: ManagedSessionPolicy;
}): ManagedSessionLifecycleDecision {
  const { exists, policy } = params;
  switch (policy) {
    case "ephemeral":
      return { shouldCreate: !exists, shouldResetBeforeRun: false, shouldDeleteAfterRun: true };
    case "reset-on-reuse":
      return { shouldCreate: !exists, shouldResetBeforeRun: exists, shouldDeleteAfterRun: false };
    case "sticky":
      return { shouldCreate: !exists, shouldResetBeforeRun: false, shouldDeleteAfterRun: false };
    case "reusable":
    default:
      return { shouldCreate: !exists, shouldResetBeforeRun: false, shouldDeleteAfterRun: false };
  }
}

export type BuildManagedSessionKeyInput = {
  owner: string;
  scope: string;
  role?: string;
  name?: string;
  agentId?: string;
};

export function buildManagedSessionKey(input: BuildManagedSessionKeyInput): string {
  const agentId = normalizeSegment(input.agentId) ?? "pibo";
  const owner = normalizeSegment(input.owner);
  const scope = normalizeSegment(input.scope);
  const role = normalizeSegment(input.role);
  const name = normalizeSegment(input.name);

  if (!owner) {
    throw new Error("buildManagedSessionKey: owner is required");
  }
  if (!scope) {
    throw new Error("buildManagedSessionKey: scope is required");
  }

  return ["agent", agentId, "pibo", owner, scope, role, name].filter(Boolean).join(":");
}

export function buildManagedWorkflowSessionKey(input: {
  flowId: string;
  role: string;
  name?: string;
  agentId?: string;
}): string {
  return buildManagedSessionKey({
    owner: "workflow",
    scope: input.flowId,
    role: input.role,
    name: input.name,
    agentId: input.agentId,
  });
}

export type ManagedSessionResolveResult = {
  found: boolean;
  key: string;
  entry?: unknown;
  payload?: unknown;
  row?: GatewaySessionRow;
  messageCount?: number;
  sessionId?: string;
};

export type ManagedSessionType = "pibo" | "native" | "both";

export type ManagedSessionsListParams = SessionsListParams & {
  sessionType?: ManagedSessionType;
  all?: boolean;
};

export type ManagedSessionResolveParams = SessionsResolveParams & {
  sessionType?: ManagedSessionType;
};

export type ManagedSessionsListResult = SessionsListResult & {
  sessionType: ManagedSessionType;
  totalCount: number;
  shownCount: number;
  truncated: boolean;
};

export type ManagedSessionStatusResult = {
  found: boolean;
  key: string;
  row?: GatewaySessionRow;
  entry?: SessionEntry;
  messages: unknown[];
  messageCount: number;
};

export type ManagedSessionEnsureInput = {
  flowId: string;
  role: string;
  name?: string;
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  policy?: ManagedSessionPolicy;
};

export type ManagedSessionRunInput = ManagedSessionEnsureInput & {
  message: string;
  provider?: string;
  deliver?: boolean;
  extraSystemPrompt?: string;
  idempotencyKey?: string;
};

export type ManagedSessionsRuntime = {
  buildKey: (input: BuildManagedSessionKeyInput) => string;
  buildWorkflowKey: (input: {
    flowId: string;
    role: string;
    name?: string;
    agentId?: string;
  }) => string;
  list: (input?: ManagedSessionsListParams) => Promise<ManagedSessionsListResult>;
  get: (input: { key: string; limit?: number }) => Promise<ManagedSessionStatusResult>;
  status: (input: { key: string; limit?: number }) => Promise<ManagedSessionStatusResult>;
  resolveSelector: (
    input: ManagedSessionResolveParams,
  ) => Promise<
    { ok: true; key: string } | { ok: false; error: { code?: string | number; message: string } }
  >;
  resolve: (key: string) => Promise<ManagedSessionResolveResult>;
  create: (input: {
    key: string;
    agentId: string;
    label?: string;
    model?: string;
    parentSessionKey?: string;
    task?: string;
    message?: string;
  }) => Promise<{
    ok: true;
    key: string;
    sessionId: string;
    entry: SessionEntry;
    created: boolean;
  }>;
  add: (input: {
    key: string;
    agentId: string;
    label?: string;
    model?: string;
    parentSessionKey?: string;
    task?: string;
    message?: string;
  }) => Promise<{
    ok: true;
    key: string;
    sessionId: string;
    entry: SessionEntry;
    created: boolean;
  }>;
  patch: (input: {
    key: string;
    label?: string | null;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
    responseUsage?: "off" | "tokens" | "full" | "on" | null;
    elevatedLevel?: string | null;
    execHost?: string | null;
    execSecurity?: string | null;
    execAsk?: string | null;
    execNode?: string | null;
    model?: string | null;
    spawnedBy?: string | null;
    spawnedWorkspaceDir?: string | null;
    spawnDepth?: number | null;
    subagentRole?: "orchestrator" | "leaf" | null;
    subagentControlScope?: "children" | "none" | null;
    sendPolicy?: "allow" | "deny" | null;
    groupActivation?: "mention" | "always" | null;
  }) => Promise<SessionsPatchResult>;
  edit: (input: {
    key: string;
    label?: string | null;
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
    responseUsage?: "off" | "tokens" | "full" | "on" | null;
    elevatedLevel?: string | null;
    execHost?: string | null;
    execSecurity?: string | null;
    execAsk?: string | null;
    execNode?: string | null;
    model?: string | null;
    spawnedBy?: string | null;
    spawnedWorkspaceDir?: string | null;
    spawnDepth?: number | null;
    subagentRole?: "orchestrator" | "leaf" | null;
    subagentControlScope?: "children" | "none" | null;
    sendPolicy?: "allow" | "deny" | null;
    groupActivation?: "mention" | "always" | null;
  }) => Promise<SessionsPatchResult>;
  reset: (key: string, reason?: "new" | "reset") => Promise<unknown>;
  delete: (key: string, deleteTranscript?: boolean) => Promise<void>;
  compact: (input: { key: string; maxLines?: number }) => Promise<{
    ok: true;
    key: string;
    compacted: boolean;
    archived?: string;
    kept?: number;
    reason?: string;
  }>;
  ensureWorkflowSession: (input: ManagedSessionEnsureInput) => Promise<{
    key: string;
    created: boolean;
    reset: boolean;
    deleteAfterRun: boolean;
    policy: ManagedSessionPolicy;
  }>;
  runOnManagedSession: (input: {
    sessionKey: string;
    message: string;
    provider?: string;
    model?: string;
    deliver?: boolean;
    extraSystemPrompt?: string;
    idempotencyKey?: string;
  }) => Promise<{ runId?: string }>;
  runFirstManagedWorkflowTurn: (input: ManagedSessionRunInput) => Promise<{
    sessionKey: string;
    created: boolean;
    reset: boolean;
    deleteAfterRun: boolean;
    runId?: string;
  }>;
};

function requireKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("managedSessions: key is required");
  }
  return normalized;
}

function normalizeManagedSessionType(value: unknown): ManagedSessionType {
  const normalized = normalizeLowercaseStringOrEmpty(typeof value === "string" ? value : "");
  if (normalized === "native" || normalized === "both") {
    return normalized;
  }
  return "pibo";
}

export function classifyManagedSessionType(key: string): Exclude<ManagedSessionType, "both"> {
  return key.includes(":pibo:") ? "pibo" : "native";
}

export function matchesManagedSessionType(key: string, sessionType: ManagedSessionType): boolean {
  if (sessionType === "both") {
    return true;
  }
  return classifyManagedSessionType(key) === sessionType;
}

export function listManagedSessionsFromStore(params: {
  cfg: ReturnType<typeof loadConfig>;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts?: ManagedSessionsListParams;
}): ManagedSessionsListResult {
  const { cfg, storePath, store } = params;
  const opts = params.opts ?? {};
  const now = Date.now();
  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const sessionType = normalizeManagedSessionType(opts.sessionType);
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;
  const explicitLimit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(1, Math.floor(opts.limit))
      : undefined;
  const limit = opts.all === true ? undefined : (explicitLimit ?? 10);

  let candidateEntries = Object.entries(store)
    .filter(([key]) => {
      if (!matchesManagedSessionType(key, sessionType)) {
        return false;
      }
      if (!includeGlobal && key === "global") {
        return false;
      }
      if (!includeUnknown && key === "unknown") {
        return false;
      }
      if (agentId) {
        if (key === "global" || key === "unknown") {
          return false;
        }
        const parsed = parseAgentSessionKey(key);
        if (!parsed) {
          return false;
        }
        return normalizeAgentId(parsed.agentId) === agentId;
      }
      return true;
    })
    .filter(([, entry]) => {
      if (!label) {
        return true;
      }
      return entry?.label === label;
    })
    .toSorted((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0));
  const candidateCountBeforeLimit = candidateEntries.length;

  const canApplyEarlyLimit =
    typeof limit === "number" &&
    !spawnedBy &&
    !search &&
    activeMinutes === undefined &&
    !includeDerivedTitles &&
    !includeLastMessage;
  if (canApplyEarlyLimit) {
    candidateEntries = candidateEntries.slice(0, limit);
  }

  let sessions = candidateEntries
    .map(([key, entry]) =>
      buildGatewaySessionRow({
        cfg,
        storePath,
        store,
        key,
        entry,
        now,
        includeDerivedTitles,
        includeLastMessage,
      }),
    )
    .filter((row) => {
      if (!spawnedBy) {
        return true;
      }
      return row.spawnedBy === spawnedBy || row.parentSessionKey === spawnedBy;
    });

  if (search) {
    sessions = sessions.filter((session) => {
      const fields = [
        session.displayName,
        session.label,
        session.subject,
        session.sessionId,
        session.key,
      ];
      return fields.some(
        (field) =>
          typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
      );
    });
  }

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    sessions = sessions.filter((session) => (session.updatedAt ?? 0) >= cutoff);
  }

  const totalCount = canApplyEarlyLimit ? candidateCountBeforeLimit : sessions.length;
  const shownSessions =
    typeof limit === "number" && sessions.length > limit ? sessions.slice(0, limit) : sessions;

  return {
    ts: now,
    path: storePath,
    count: shownSessions.length,
    defaults: getSessionDefaults(cfg),
    sessions: shownSessions,
    sessionType,
    totalCount,
    shownCount: shownSessions.length,
    truncated: shownSessions.length < totalCount,
  };
}

export async function resolveManagedSessionSelector(params: {
  cfg: ReturnType<typeof loadConfig>;
  storePath: string;
  store: Record<string, SessionEntry>;
  input: ManagedSessionResolveParams;
}): Promise<
  { ok: true; key: string } | { ok: false; error: { code?: string | number; message: string } }
> {
  const { cfg, storePath, store, input } = params;
  const key = normalizeOptionalString(input.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(input.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(input.label) ?? "").length > 0;
  const selectionCount = [hasKey, hasSessionId, hasLabel].filter(Boolean).length;

  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, or label (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Either key, sessionId, or label is required"),
    };
  }

  const listInput = {
    includeGlobal: input.includeGlobal === true,
    includeUnknown: input.includeUnknown === true,
    agentId: input.agentId,
    spawnedBy: input.spawnedBy,
    sessionType: input.sessionType,
    all: true,
  } satisfies ManagedSessionsListParams;

  if (hasKey) {
    const canonicalKey = resolveGatewaySessionStoreTarget({ cfg, key }).canonicalKey;
    const list = listManagedSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: listInput,
    });
    const match = list.sessions.find((session) => session.key === canonicalKey);
    if (!match) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${key}`),
      };
    }
    return { ok: true, key: match.key };
  }

  if (hasSessionId) {
    const list = listManagedSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: listInput,
    });
    const matches = list.sessions.filter(
      (session) => session.sessionId === sessionId || session.key === sessionId,
    );
    if (matches.length === 0) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${sessionId}`),
      };
    }
    if (matches.length > 1) {
      const keys = matches.map((session) => session.key).join(", ");
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
        ),
      };
    }
    return { ok: true, key: String(matches[0]?.key ?? "") };
  }

  const parsedLabel = parseSessionLabel(input.label);
  if (!parsedLabel.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
    };
  }

  const list = listManagedSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      ...listInput,
      label: parsedLabel.label,
      all: true,
    },
  });
  if (list.sessions.length === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `No session found with label: ${parsedLabel.label}`,
      ),
    };
  }
  if (list.sessions.length > 1) {
    const keys = list.sessions.map((session) => session.key).join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
      ),
    };
  }

  return { ok: true, key: String(list.sessions[0]?.key ?? "") };
}

function ensureSessionTranscriptFile(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
}): string {
  const transcriptPath = resolveSessionFilePath(
    params.sessionId,
    params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
    resolveSessionFilePathOptions({
      storePath: params.storePath,
      agentId: params.agentId,
    }),
  );
  if (!fs.existsSync(transcriptPath)) {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
  return transcriptPath;
}

async function loadManagedSessionStatus(input: {
  key: string;
  limit?: number;
}): Promise<ManagedSessionStatusResult> {
  const key = requireKey(input.key);
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  const store = loadSessionStore(target.storePath);
  const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
  const messages = entry?.sessionId
    ? readSessionMessages(entry.sessionId, target.storePath, entry.sessionFile)
    : [];
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(1, Math.floor(input.limit))
      : undefined;
  const limitedMessages =
    typeof limit === "number" && limit < messages.length ? messages.slice(-limit) : messages;
  return {
    found: Boolean(entry?.sessionId),
    key: target.canonicalKey,
    row: loadGatewaySessionRow(target.canonicalKey) ?? undefined,
    entry,
    messages: limitedMessages,
    messageCount: messages.length,
  };
}

export function createRuntimeManagedSessions(
  subagent: PluginRuntime["subagent"],
): ManagedSessionsRuntime {
  return {
    buildKey(input) {
      return buildManagedSessionKey(input);
    },
    buildWorkflowKey(input) {
      return buildManagedWorkflowSessionKey(input);
    },
    async list(input = {}) {
      const cfg = loadConfig();
      const target = resolveGatewaySessionStoreTarget({
        cfg,
        key: `agent:${normalizeAgentId(input.agentId ?? resolveDefaultAgentId(cfg))}:dashboard:list`,
      });
      const store = loadSessionStore(target.storePath);
      return listManagedSessionsFromStore({
        cfg,
        storePath: target.storePath,
        store,
        opts: input,
      });
    },
    async get(input) {
      return await loadManagedSessionStatus(input);
    },
    async status(input) {
      return await loadManagedSessionStatus(input);
    },
    async resolveSelector(input) {
      const cfg = loadConfig();
      const { storePath, store } = (() => {
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key: `agent:${normalizeAgentId(input.agentId ?? resolveDefaultAgentId(cfg))}:dashboard:resolve`,
        });
        return { storePath: target.storePath, store: loadSessionStore(target.storePath) };
      })();
      return await resolveManagedSessionSelector({
        cfg,
        storePath,
        store,
        input,
      });
    },
    async resolve(key) {
      const status = await loadManagedSessionStatus({ key, limit: 1 });
      return {
        found: status.found,
        key: status.key,
        entry: status.entry,
        payload: { messages: status.messages },
        row: status.row,
        messageCount: status.messageCount,
        sessionId: status.entry?.sessionId,
      };
    },
    async create(input) {
      const cfg = loadConfig();
      const requestedKey = requireKey(input.key);
      const agentId = normalizeAgentId(input.agentId || resolveDefaultAgentId(cfg));
      const requestedAgentId = parseAgentSessionKey(requestedKey)?.agentId;
      if (requestedAgentId && requestedAgentId !== agentId) {
        throw new Error(
          `sessions.create key agent (${requestedAgentId}) does not match agentId (${agentId})`,
        );
      }
      const key = toAgentStoreSessionKey({
        agentId,
        requestKey: requestedKey,
        mainKey: cfg.session?.mainKey,
      });
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const existing = await loadManagedSessionStatus({ key: target.canonicalKey, limit: 1 });
      if (existing.entry?.sessionId) {
        return {
          ok: true as const,
          key: target.canonicalKey,
          sessionId: existing.entry.sessionId,
          entry: existing.entry,
          created: false,
        };
      }

      const created = await updateSessionStore(target.storePath, async (store) => {
        const patched = await applySessionsPatchToStore({
          cfg,
          store,
          storeKey: target.canonicalKey,
          patch: {
            key: target.canonicalKey,
            label: input.label?.trim() || undefined,
            model: input.model?.trim() || undefined,
          },
          loadGatewayModelCatalog: async () => [],
        });
        if (!patched.ok) {
          throw new Error(patched.error.message);
        }
        if (input.parentSessionKey) {
          store[target.canonicalKey] = {
            ...patched.entry,
            parentSessionKey: input.parentSessionKey,
          };
          return store[target.canonicalKey];
        }
        return patched.entry;
      });
      const resolvedAgentId = resolveAgentIdFromSessionKey(target.canonicalKey);
      const transcriptPath = ensureSessionTranscriptFile({
        sessionId: created.sessionId,
        storePath: target.storePath,
        sessionFile: created.sessionFile,
        agentId: resolvedAgentId,
      });
      const entry =
        created.sessionFile === transcriptPath
          ? created
          : { ...created, sessionFile: transcriptPath };
      if (entry !== created) {
        await updateSessionStore(target.storePath, (store) => {
          if (store[target.canonicalKey]) {
            store[target.canonicalKey] = entry;
          }
        });
      }
      return {
        ok: true as const,
        key: target.canonicalKey,
        sessionId: entry.sessionId,
        entry,
        created: true,
      };
    },
    async add(input) {
      return await this.create(input);
    },
    async patch(input) {
      const cfg = loadConfig();
      const key = requireKey(input.key);
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const applied = await updateSessionStore(target.storePath, async (store) => {
        const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
        const patched = await applySessionsPatchToStore({
          cfg,
          store,
          storeKey: primaryKey,
          patch: input,
          loadGatewayModelCatalog: async () => [],
        });
        if (!patched.ok) {
          throw new Error(patched.error.message);
        }
        return patched.entry;
      });
      const agentId = normalizeAgentId(
        parseAgentSessionKey(target.canonicalKey)?.agentId ?? resolveDefaultAgentId(cfg),
      );
      const resolved = resolveSessionModelRef(cfg, applied, agentId);
      return {
        ok: true as const,
        path: target.storePath,
        key: target.canonicalKey,
        entry: applied,
        resolved: {
          modelProvider: resolved.provider,
          model: resolved.model,
        },
      };
    },
    async edit(input) {
      return await this.patch(input);
    },
    async reset(key, _reason = "reset") {
      const result = await performGatewaySessionReset({
        key: requireKey(key),
        reason: _reason,
        commandSource: "plugin:managedSessions.reset",
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return { ok: true, key: result.key, entry: result.entry, reset: true };
    },
    async delete(key, deleteTranscript = true) {
      const cfg = loadConfig();
      const normalizedKey = requireKey(key);
      const { target, storePath } = (() => {
        const resolvedTarget = resolveGatewaySessionStoreTarget({ cfg, key: normalizedKey });
        return { target: resolvedTarget, storePath: resolvedTarget.storePath };
      })();
      const mainKey = resolveMainSessionKey(cfg);
      if (target.canonicalKey === mainKey) {
        throw new Error(`Cannot delete the main session (${mainKey}).`);
      }
      const { entry, legacyKey, canonicalKey } = loadSessionEntry(normalizedKey);
      const mutationCleanupError = await cleanupSessionBeforeMutation({
        cfg,
        key: normalizedKey,
        target,
        entry,
        legacyKey,
        canonicalKey,
        reason: "session-delete",
      });
      if (mutationCleanupError) {
        throw new Error(mutationCleanupError.message);
      }
      await updateSessionStore(storePath, (store) => {
        const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
          cfg,
          key: normalizedKey,
          store,
        });
        delete store[primaryKey];
      });
      if (deleteTranscript) {
        archiveSessionTranscriptsForSession({
          sessionId: entry?.sessionId,
          storePath,
          sessionFile: entry?.sessionFile,
          agentId: target.agentId,
          reason: "deleted",
        });
      }
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey,
        reason: "session-delete",
      });
    },
    async compact(input) {
      const cfg = loadConfig();
      const key = requireKey(input.key);
      const maxLines =
        typeof input.maxLines === "number" && Number.isFinite(input.maxLines)
          ? Math.max(1, Math.floor(input.maxLines))
          : 400;
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const compactTarget = await updateSessionStore(target.storePath, (store) => {
        const { entry, primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
        return { entry, primaryKey };
      });
      const entry = compactTarget.entry;
      if (!entry?.sessionId) {
        return {
          ok: true as const,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        };
      }
      const transcriptPath =
        entry.sessionFile ||
        ensureSessionTranscriptFile({
          sessionId: entry.sessionId,
          storePath: target.storePath,
          sessionFile: entry.sessionFile,
          agentId: target.agentId,
        });
      if (!fs.existsSync(transcriptPath)) {
        return {
          ok: true as const,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        };
      }
      const lines = fs
        .readFileSync(transcriptPath, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.trim());
      if (lines.length <= maxLines) {
        return {
          ok: true as const,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        };
      }
      const archived = archiveFileOnDisk(transcriptPath, "bak");
      const keptLines = lines.slice(-maxLines);
      fs.writeFileSync(transcriptPath, `${keptLines.join("\n")}\n`, "utf-8");
      await updateSessionStore(target.storePath, (store) => {
        const current = store[compactTarget.primaryKey];
        if (!current) {
          return;
        }
        delete current.inputTokens;
        delete current.outputTokens;
        delete current.totalTokens;
        delete current.totalTokensFresh;
        current.updatedAt = Date.now();
      });
      return {
        ok: true as const,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      };
    },
    async ensureWorkflowSession(input) {
      const key = buildManagedWorkflowSessionKey({
        flowId: input.flowId,
        role: input.role,
        name: input.name,
        agentId: input.agentId,
      });
      const resolved = await this.resolve(key);
      const policy = input.policy ?? "reusable";
      const lifecycle = decideManagedSessionLifecycle({ exists: resolved.found, policy });

      if (lifecycle.shouldCreate) {
        await this.create({
          key,
          agentId: input.agentId ?? "pibo",
          label: input.label,
          model: input.model,
          parentSessionKey: input.parentSessionKey,
        });
      }

      if (lifecycle.shouldResetBeforeRun) {
        await this.reset(key, "reset");
      }

      return {
        key,
        created: lifecycle.shouldCreate,
        reset: lifecycle.shouldResetBeforeRun,
        deleteAfterRun: lifecycle.shouldDeleteAfterRun,
        policy,
      };
    },
    async runOnManagedSession(input) {
      return await subagent.run({
        sessionKey: input.sessionKey,
        message: input.message,
        provider: input.provider,
        model: input.model,
        deliver: input.deliver ?? false,
        extraSystemPrompt: input.extraSystemPrompt,
        idempotencyKey: input.idempotencyKey,
      });
    },
    async runFirstManagedWorkflowTurn(input) {
      const ensured = await this.ensureWorkflowSession(input);
      const run = await this.runOnManagedSession({
        sessionKey: ensured.key,
        message: input.message,
        provider: input.provider,
        model: input.model,
        deliver: input.deliver ?? false,
        extraSystemPrompt: input.extraSystemPrompt,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        sessionKey: ensured.key,
        created: ensured.created,
        reset: ensured.reset,
        deleteAfterRun: ensured.deleteAfterRun,
        runId: run.runId,
      };
    },
  };
}
