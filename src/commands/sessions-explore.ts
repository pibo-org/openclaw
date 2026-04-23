import { stripToolMessages } from "../agents/tools/sessions-helpers.js";
import {
  capSessionHistoryMessages,
  sanitizeSessionHistoryMessages,
} from "../agents/tools/sessions-history-sanitize.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveAgentMainSessionKey,
  type SessionEntry,
} from "../config/sessions.js";
import {
  findStoreKeysIgnoreCase,
  readSessionMessages,
  resolveFreshestSessionStoreMatchFromStoreKeys,
} from "../gateway/session-utils.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import { formatSessionAgeCell } from "./sessions-table.js";

const DEFAULT_PEEK_LIMIT = 5;
const DEFAULT_SHOW_LIMIT = 20;
const DEFAULT_GREP_LIMIT = 8;
const DEFAULT_FIND_LIMIT = 10;
const DEFAULT_SNIPPET_SIDE_CHARS = 80;
const MAX_WINDOW_LIMIT = 50;
const MAX_GREP_LIMIT = 20;
const MAX_FIND_LIMIT = 25;
const MAX_SNIPPET_SIDE_CHARS = 240;
const MESSAGE_PREVIEW_MAX_CHARS = 160;

type ExploreScopeOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
};

type SessionRoleFilter = "user" | "assistant" | "tool";

type ResolvedSessionRecord = {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
};

type MessageWithSeq = {
  message: unknown;
  seq: number;
  role: string;
};

type ParsedCursor = {
  kind: "before" | "after";
  seq: number;
  token: string;
};

type ShowWindowResult = {
  page: MessageWithSeq[];
  totalMessages: number;
  olderCursor: string | null;
  newerCursor: string | null;
  requestedCursor: string | null;
};

type FindCandidate = {
  agentId: string;
  storePath: string;
  key: string;
  updatedAt: number | null;
  sessionId?: string;
  displayName?: string;
  subject?: string;
  label?: string;
  channel?: string;
  model?: string;
  matchedFields: string[];
  matchField: string;
  matchValue: string;
  score: number;
};

function parseBoundedPositiveInteger(params: {
  label: string;
  value: unknown;
  runtime: RuntimeEnv;
  defaultValue: number;
  max: number;
}): number | null {
  if (params.value === undefined || params.value === null || params.value === "") {
    return params.defaultValue;
  }
  const rawValue =
    typeof params.value === "string" || typeof params.value === "number" ? `${params.value}` : null;
  if (rawValue === null) {
    params.runtime.error(`${params.label} must be a positive integer`);
    params.runtime.exit(1);
    return null;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    params.runtime.error(`${params.label} must be a positive integer`);
    params.runtime.exit(1);
    return null;
  }
  return Math.min(parsed, params.max);
}

function parseRoleFilter(
  value: unknown,
  runtime: RuntimeEnv,
): SessionRoleFilter | null | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
  if (normalized === "user" || normalized === "assistant" || normalized === "tool") {
    return normalized;
  }
  runtime.error("--role must be one of: user, assistant, tool");
  runtime.exit(1);
  return null;
}

function parseCursor(value: unknown, runtime: RuntimeEnv): ParsedCursor | null | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const raw = typeof value === "string" ? (normalizeOptionalString(value) ?? "") : "";
  const match = /^(before|after):(\d+)$/i.exec(raw);
  if (!match) {
    runtime.error("--cursor must look like before:<seq> or after:<seq>");
    runtime.exit(1);
    return null;
  }
  const seq = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(seq) || seq <= 0) {
    runtime.error("--cursor sequence must be a positive integer");
    runtime.exit(1);
    return null;
  }
  return {
    kind: normalizeLowercaseStringOrEmpty(match[1]) as "before" | "after",
    seq,
    token: `${normalizeLowercaseStringOrEmpty(match[1])}:${seq}`,
  };
}

function resolveScopedTargets(params: {
  key?: string;
  scope: ExploreScopeOptions;
  runtime: RuntimeEnv;
  defaultAllAgents?: boolean;
}) {
  const cfg = loadConfig();
  const parsed = params.key ? parseAgentSessionKey(params.key) : undefined;
  if (
    parsed &&
    params.scope.agent &&
    normalizeAgentId(params.scope.agent) !== normalizeAgentId(parsed.agentId)
  ) {
    params.runtime.error("--agent does not match the explicit agent embedded in the session key");
    params.runtime.exit(1);
    return null;
  }
  const shouldSearchAllAgents =
    params.scope.allAgents === true ||
    (params.defaultAllAgents === true && !params.scope.store && !params.scope.agent);
  const agent =
    params.scope.store || params.scope.allAgents
      ? params.scope.agent
      : (params.scope.agent ?? parsed?.agentId);
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: params.scope.store,
      agent,
      allAgents: shouldSearchAllAgents,
    },
    runtime: params.runtime,
  });
  return targets ? { targets } : null;
}

function canonicalizeKeyForTarget(params: { key: string; agentId: string }) {
  const cfg = loadConfig();
  const parsed = parseAgentSessionKey(params.key);
  const requested = parsed
    ? `agent:${normalizeAgentId(parsed.agentId)}:${normalizeLowercaseStringOrEmpty(parsed.rest)}`
    : toAgentStoreSessionKey({
        agentId: params.agentId,
        requestKey: params.key,
        mainKey: cfg.session?.mainKey,
      });
  const effectiveAgentId = parseAgentSessionKey(requested)?.agentId ?? params.agentId;
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: effectiveAgentId,
    sessionKey: requested,
  });
}

function buildLookupSeeds(params: { key: string; agentId: string }): string[] {
  const cfg = loadConfig();
  const raw = normalizeOptionalString(params.key) ?? "";
  if (!raw) {
    return [];
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed && normalizeAgentId(parsed.agentId) !== normalizeAgentId(params.agentId)) {
    return [];
  }

  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const loweredRaw = normalizeLowercaseStringOrEmpty(raw);
  const explicitKey = canonicalizeKeyForTarget({ key: raw, agentId: params.agentId });
  const seeds = new Set<string>([raw, loweredRaw, explicitKey]);
  if (!parsed) {
    seeds.add(
      toAgentStoreSessionKey({
        agentId: params.agentId,
        requestKey: raw,
        mainKey: cfg.session?.mainKey,
      }),
    );
  }

  const explicitRest = parseAgentSessionKey(explicitKey)?.rest;
  const isMainAlias =
    loweredRaw === "main" ||
    loweredRaw === mainKey ||
    explicitRest === "main" ||
    explicitRest === mainKey;
  if (isMainAlias) {
    seeds.add("main");
    seeds.add(mainKey);
    seeds.add(resolveAgentMainSessionKey({ cfg, agentId: params.agentId }));
    seeds.add(`agent:${normalizeAgentId(params.agentId)}:main`);
  }

  return [...seeds].filter(Boolean);
}

function resolveSessionRecord(params: {
  key: string;
  scope: ExploreScopeOptions;
  runtime: RuntimeEnv;
}): ResolvedSessionRecord | null {
  const scoped = resolveScopedTargets({
    key: params.key,
    scope: params.scope,
    runtime: params.runtime,
  });
  if (!scoped) {
    return null;
  }

  const matches: ResolvedSessionRecord[] = [];
  for (const target of scoped.targets) {
    const store = loadSessionStore(target.storePath);
    const storeKeys = new Set<string>();
    for (const seed of buildLookupSeeds({ key: params.key, agentId: target.agentId })) {
      if (store[seed]) {
        storeKeys.add(seed);
      }
      for (const legacyKey of findStoreKeysIgnoreCase(store, seed)) {
        storeKeys.add(legacyKey);
      }
    }
    const match = resolveFreshestSessionStoreMatchFromStoreKeys(store, [...storeKeys]);
    if (!match?.entry) {
      continue;
    }
    matches.push({
      storePath: target.storePath,
      sessionKey: canonicalizeKeyForTarget({ key: params.key, agentId: target.agentId }),
      entry: match.entry,
    });
  }

  if (matches.length === 0) {
    params.runtime.error(`Session not found: ${params.key}`);
    params.runtime.exit(1);
    return null;
  }
  if (matches.length > 1) {
    params.runtime.error(
      `Session key is ambiguous across stores; rerun with --agent, --store, or a full key: ${matches
        .map((match) => match.sessionKey)
        .join(", ")}`,
    );
    params.runtime.exit(1);
    return null;
  }
  return matches[0] ?? null;
}

function normalizeMessageRole(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "unknown";
  }
  const raw = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  if (raw === "toolresult") {
    return "tool";
  }
  return raw || "unknown";
}

function attachMessageSeq(messages: unknown[]): MessageWithSeq[] {
  return messages.map((message, index) => {
    const meta =
      message && typeof message === "object"
        ? ((message as { __openclaw?: unknown }).__openclaw as { seq?: unknown } | undefined)
        : undefined;
    const seq =
      typeof meta?.seq === "number" && Number.isFinite(meta.seq) && meta.seq > 0
        ? Math.floor(meta.seq)
        : index + 1;
    return {
      message,
      seq,
      role: normalizeMessageRole(message),
    };
  });
}

function filterMessages(params: {
  messages: unknown[];
  includeTools?: boolean;
  role?: SessionRoleFilter;
}): MessageWithSeq[] {
  const filtered =
    params.includeTools || params.role === "tool"
      ? params.messages
      : stripToolMessages(params.messages);
  return attachMessageSeq(filtered).filter((entry) => {
    if (!params.role) {
      return true;
    }
    return entry.role === params.role;
  });
}

function paginateMessages(params: {
  messages: MessageWithSeq[];
  limit: number;
  before?: number;
  after?: number;
  requestedCursor?: string | null;
}): ShowWindowResult {
  const totalMessages = params.messages.length;
  let eligible = params.messages;
  if (typeof params.before === "number") {
    const before = params.before;
    eligible = eligible.filter((entry) => entry.seq < before);
    eligible = eligible.slice(Math.max(0, eligible.length - params.limit));
  } else if (typeof params.after === "number") {
    const after = params.after;
    eligible = eligible.filter((entry) => entry.seq > after).slice(0, params.limit);
  } else {
    eligible = eligible.slice(Math.max(0, eligible.length - params.limit));
  }

  const firstSeq = eligible[0]?.seq;
  const lastSeq = eligible.at(-1)?.seq;
  const olderCursor =
    typeof firstSeq === "number" && params.messages.some((entry) => entry.seq < firstSeq)
      ? `before:${firstSeq}`
      : null;
  const newerCursor =
    typeof lastSeq === "number" && params.messages.some((entry) => entry.seq > lastSeq)
      ? `after:${lastSeq}`
      : null;

  return {
    page: eligible,
    totalMessages,
    olderCursor,
    newerCursor,
    requestedCursor: params.requestedCursor ?? null,
  };
}

function collectTextFragments(value: unknown, out: string[]) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const entry = value as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (typeof entry.text === "string") {
    collectTextFragments(entry.text, out);
  }
  if (typeof entry.thinking === "string") {
    collectTextFragments(entry.thinking, out);
  }
  if (typeof entry.partialJson === "string") {
    collectTextFragments(entry.partialJson, out);
  }
  if (type === "image" && entry.omitted === true) {
    out.push("[image omitted]");
    return;
  }
  if (type && out.length === 0) {
    const name = typeof entry.name === "string" ? `: ${entry.name}` : "";
    out.push(`[${type}${name}]`);
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const out: string[] = [];
  const entry = message as Record<string, unknown>;
  if (typeof entry.text === "string") {
    collectTextFragments(entry.text, out);
  }
  collectTextFragments(entry.content, out);
  return out
    .map((part) => collapseWhitespace(part))
    .filter(Boolean)
    .join("\n");
}

function truncatePreview(text: string, maxChars = MESSAGE_PREVIEW_MAX_CHARS): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

function renderMessageWindow(params: { runtime: RuntimeEnv; messages: unknown[] }) {
  const lines = attachMessageSeq(params.messages);
  if (lines.length === 0) {
    params.runtime.log("No messages in this window.");
    return;
  }
  for (const entry of lines) {
    const preview = truncatePreview(messageText(entry.message)) || "(non-text content)";
    params.runtime.log(`[${entry.seq}] ${entry.role.padEnd(9)} ${preview}`);
  }
}

function searchSnippets(params: {
  messages: MessageWithSeq[];
  query: string;
  limit: number;
  beforeChars: number;
  afterChars: number;
  ignoreCase?: boolean;
}): {
  totalHits: number;
  hits: Array<{ seq: number; role: string; snippet: string }>;
} {
  const normalizedQuery = params.ignoreCase ? params.query.toLowerCase() : params.query;
  const hits: Array<{ seq: number; role: string; snippet: string }> = [];
  let totalHits = 0;

  for (const entry of [...params.messages].toReversed()) {
    const text = messageText(entry.message);
    if (!text) {
      continue;
    }
    const haystack = params.ignoreCase ? text.toLowerCase() : text;
    let fromIndex = 0;
    while (fromIndex < haystack.length) {
      const matchIndex = haystack.indexOf(normalizedQuery, fromIndex);
      if (matchIndex === -1) {
        break;
      }
      totalHits += 1;
      if (hits.length < params.limit) {
        const start = Math.max(0, matchIndex - params.beforeChars);
        const end = Math.min(text.length, matchIndex + params.query.length + params.afterChars);
        const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
        hits.push({
          seq: entry.seq,
          role: entry.role,
          snippet: collapseWhitespace(snippet),
        });
      }
      fromIndex = matchIndex + Math.max(1, params.query.length);
    }
  }

  return { totalHits, hits };
}

function scoreField(value: string, query: string) {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (!normalized.includes(query)) {
    return 0;
  }
  if (normalized === query) {
    return 400;
  }
  if (normalized.startsWith(query)) {
    return 250;
  }
  if (normalized.split(/[\s:_-]+/).some((part) => part.startsWith(query))) {
    return 180;
  }
  return 100;
}

function rankFindCandidate(params: {
  key: string;
  agentId: string;
  storePath: string;
  entry: SessionEntry;
  query: string;
}): FindCandidate | null {
  const fields = [
    { name: "key", value: params.key, weight: 5 },
    { name: "sessionId", value: params.entry.sessionId, weight: 5 },
    { name: "displayName", value: params.entry.displayName, weight: 4 },
    { name: "subject", value: params.entry.subject, weight: 4 },
    { name: "label", value: params.entry.label, weight: 3 },
    { name: "channel", value: params.entry.channel, weight: 2 },
    { name: "groupChannel", value: params.entry.groupChannel, weight: 2 },
    { name: "space", value: params.entry.space, weight: 2 },
    { name: "lastChannel", value: params.entry.lastChannel, weight: 2 },
    { name: "lastTo", value: params.entry.lastTo, weight: 1 },
  ];

  let score = 0;
  let matchField = "";
  let matchValue = "";
  let bestWeighted = 0;
  const matchedFields: string[] = [];

  for (const field of fields) {
    if (typeof field.value !== "string" || !field.value.trim()) {
      continue;
    }
    const fieldScore = scoreField(field.value, params.query);
    if (fieldScore <= 0) {
      continue;
    }
    matchedFields.push(field.name);
    const weighted = fieldScore * field.weight;
    score += weighted;
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      matchField = field.name;
      matchValue = field.value;
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    agentId: params.agentId,
    storePath: params.storePath,
    key: params.key,
    updatedAt: params.entry.updatedAt ?? null,
    sessionId: params.entry.sessionId,
    displayName: params.entry.displayName,
    subject: params.entry.subject,
    label: params.entry.label,
    channel: params.entry.channel,
    model: params.entry.model,
    matchedFields,
    matchField,
    matchValue,
    score,
  };
}

function renderFindResults(params: {
  runtime: RuntimeEnv;
  query: string;
  candidates: FindCandidate[];
  searchedStores: number;
  truncated: boolean;
}) {
  params.runtime.log(`Query: ${params.query}`);
  params.runtime.log(
    `Stores searched: ${params.searchedStores} (metadata only; transcript bodies not loaded)`,
  );
  params.runtime.log(
    `Candidates: ${params.candidates.length}${params.truncated ? " (bounded output; refine query or raise --limit)" : ""}`,
  );
  if (params.candidates.length === 0) {
    return;
  }
  for (const candidate of params.candidates) {
    const age = formatSessionAgeCell(candidate.updatedAt, false).trim();
    const matchValue = truncatePreview(candidate.matchValue, 90);
    params.runtime.log(
      `${candidate.agentId.padEnd(8)} ${candidate.key}  ${age}  ${candidate.matchField}: ${matchValue}`,
    );
  }
}

type SessionWindowOptions = {
  key: string;
  limit?: unknown;
  role?: unknown;
  includeTools?: boolean;
  json?: boolean;
} & ExploreScopeOptions;

export async function sessionsPeekCommand(opts: SessionWindowOptions, runtime: RuntimeEnv) {
  const record = resolveSessionRecord({
    key: opts.key,
    scope: opts,
    runtime,
  });
  if (!record) {
    return;
  }
  if (!record.entry.sessionId) {
    runtime.error(`Session ${record.sessionKey} has no transcript`);
    runtime.exit(1);
    return;
  }

  const limit = parseBoundedPositiveInteger({
    label: "--limit",
    value: opts.limit,
    runtime,
    defaultValue: DEFAULT_PEEK_LIMIT,
    max: MAX_WINDOW_LIMIT,
  });
  const role = parseRoleFilter(opts.role, runtime);
  if (limit === null || role === null) {
    return;
  }
  const toolMessagesVisible = Boolean(opts.includeTools || role === "tool");

  const messages = readSessionMessages(
    record.entry.sessionId,
    record.storePath,
    record.entry.sessionFile,
  );
  const filtered = filterMessages({
    messages,
    includeTools: toolMessagesVisible,
    role: role ?? undefined,
  });
  const page = filtered.slice(Math.max(0, filtered.length - limit));
  const sanitized = sanitizeSessionHistoryMessages(page.map((entry) => entry.message));
  const capped = capSessionHistoryMessages({ messages: sanitized.messages });
  const payload = {
    sessionKey: record.sessionKey,
    limit,
    role: role ?? null,
    includeTools: toolMessagesVisible,
    messages: capped.messages,
    truncated: filtered.length > page.length || capped.truncated || sanitized.contentTruncated,
    contentTruncated: sanitized.contentTruncated,
    contentRedacted: sanitized.contentRedacted,
    bytes: capped.bytes,
    window: {
      totalMessages: filtered.length,
      availableOlder: Math.max(0, filtered.length - page.length),
    },
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Session: ${record.sessionKey}`);
  runtime.log(
    `Showing the last ${payload.messages.length} sanitized message(s)${toolMessagesVisible ? "" : " with tool messages hidden"}${payload.truncated ? " (bounded window)" : ""}.`,
  );
  runtime.log(`Bytes: ${payload.bytes}`);
  renderMessageWindow({ runtime, messages: payload.messages });
}

export async function sessionsShowCommand(
  opts: SessionWindowOptions & { cursor?: unknown; before?: unknown; after?: unknown },
  runtime: RuntimeEnv,
) {
  const record = resolveSessionRecord({
    key: opts.key,
    scope: opts,
    runtime,
  });
  if (!record) {
    return;
  }
  if (!record.entry.sessionId) {
    runtime.error(`Session ${record.sessionKey} has no transcript`);
    runtime.exit(1);
    return;
  }

  const limit = parseBoundedPositiveInteger({
    label: "--limit",
    value: opts.limit,
    runtime,
    defaultValue: DEFAULT_SHOW_LIMIT,
    max: MAX_WINDOW_LIMIT,
  });
  const role = parseRoleFilter(opts.role, runtime);
  const cursor = parseCursor(opts.cursor, runtime);
  const before =
    cursor?.kind === "before"
      ? cursor.seq
      : parseBoundedPositiveInteger({
          label: "--before",
          value: opts.before,
          runtime,
          defaultValue: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
  const after =
    cursor?.kind === "after"
      ? cursor.seq
      : parseBoundedPositiveInteger({
          label: "--after",
          value: opts.after,
          runtime,
          defaultValue: 0,
          max: Number.MAX_SAFE_INTEGER,
        });

  if (limit === null || role === null || cursor === null || before === null || after === null) {
    return;
  }
  const toolMessagesVisible = Boolean(opts.includeTools || role === "tool");
  if (opts.cursor && (opts.before !== undefined || opts.after !== undefined)) {
    runtime.error("--cursor cannot be combined with --before or --after");
    runtime.exit(1);
    return;
  }
  if (opts.before !== undefined && opts.after !== undefined) {
    runtime.error("--before and --after cannot be combined");
    runtime.exit(1);
    return;
  }

  const messages = readSessionMessages(
    record.entry.sessionId,
    record.storePath,
    record.entry.sessionFile,
  );
  const filtered = filterMessages({
    messages,
    includeTools: toolMessagesVisible,
    role: role ?? undefined,
  });
  const window = paginateMessages({
    messages: filtered,
    limit,
    before: cursor?.kind === "before" ? cursor.seq : opts.before !== undefined ? before : undefined,
    after: cursor?.kind === "after" ? cursor.seq : opts.after !== undefined ? after : undefined,
    requestedCursor: cursor?.token ?? null,
  });
  const sanitized = sanitizeSessionHistoryMessages(window.page.map((entry) => entry.message));
  const capped = capSessionHistoryMessages({ messages: sanitized.messages });
  const payload = {
    sessionKey: record.sessionKey,
    limit,
    role: role ?? null,
    includeTools: toolMessagesVisible,
    messages: capped.messages,
    truncated:
      Boolean(window.olderCursor || window.newerCursor) ||
      capped.truncated ||
      sanitized.contentTruncated,
    contentTruncated: sanitized.contentTruncated,
    contentRedacted: sanitized.contentRedacted,
    bytes: capped.bytes,
    cursor: {
      requested: window.requestedCursor,
      older: window.olderCursor,
      newer: window.newerCursor,
    },
    window: {
      totalMessages: window.totalMessages,
      startSeq: window.page[0]?.seq ?? null,
      endSeq: window.page.at(-1)?.seq ?? null,
    },
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Session: ${record.sessionKey}`);
  runtime.log(
    `Showing ${payload.messages.length} sanitized message(s)${toolMessagesVisible ? "" : " with tool messages hidden"}${payload.truncated ? " (paged window)" : ""}.`,
  );
  runtime.log(`Bytes: ${payload.bytes}`);
  if (payload.cursor.older) {
    runtime.log(`Older cursor: ${payload.cursor.older}`);
  }
  if (payload.cursor.newer) {
    runtime.log(`Newer cursor: ${payload.cursor.newer}`);
  }
  renderMessageWindow({ runtime, messages: payload.messages });
}

export async function sessionsGrepCommand(
  opts: SessionWindowOptions & {
    query: string;
    beforeChars?: unknown;
    afterChars?: unknown;
    ignoreCase?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const query = normalizeOptionalString(opts.query) ?? "";
  if (!query) {
    runtime.error("Query is required");
    runtime.exit(1);
    return;
  }

  const record = resolveSessionRecord({
    key: opts.key,
    scope: opts,
    runtime,
  });
  if (!record) {
    return;
  }
  if (!record.entry.sessionId) {
    runtime.error(`Session ${record.sessionKey} has no transcript`);
    runtime.exit(1);
    return;
  }

  const limit = parseBoundedPositiveInteger({
    label: "--limit",
    value: opts.limit,
    runtime,
    defaultValue: DEFAULT_GREP_LIMIT,
    max: MAX_GREP_LIMIT,
  });
  const beforeChars = parseBoundedPositiveInteger({
    label: "--before-chars",
    value: opts.beforeChars,
    runtime,
    defaultValue: DEFAULT_SNIPPET_SIDE_CHARS,
    max: MAX_SNIPPET_SIDE_CHARS,
  });
  const afterChars = parseBoundedPositiveInteger({
    label: "--after-chars",
    value: opts.afterChars,
    runtime,
    defaultValue: DEFAULT_SNIPPET_SIDE_CHARS,
    max: MAX_SNIPPET_SIDE_CHARS,
  });
  const role = parseRoleFilter(opts.role, runtime);
  if (limit === null || beforeChars === null || afterChars === null || role === null) {
    return;
  }
  const toolMessagesVisible = Boolean(opts.includeTools || role === "tool");

  const messages = readSessionMessages(
    record.entry.sessionId,
    record.storePath,
    record.entry.sessionFile,
  );
  const filtered = filterMessages({
    messages,
    includeTools: toolMessagesVisible,
    role: role ?? undefined,
  });
  const sanitized = sanitizeSessionHistoryMessages(filtered.map((entry) => entry.message));
  const searchable = attachMessageSeq(sanitized.messages).map((entry, index) => ({
    ...entry,
    seq: filtered[index]?.seq ?? entry.seq,
    role: filtered[index]?.role ?? entry.role,
  }));
  const results = searchSnippets({
    messages: searchable,
    query,
    limit,
    beforeChars,
    afterChars,
    ignoreCase: opts.ignoreCase,
  });
  const payload = {
    sessionKey: record.sessionKey,
    query,
    limit,
    role: role ?? null,
    includeTools: toolMessagesVisible,
    ignoreCase: Boolean(opts.ignoreCase),
    hits: results.hits,
    totalHits: results.totalHits,
    truncated: results.totalHits > results.hits.length || sanitized.contentTruncated,
    contentTruncated: sanitized.contentTruncated,
    contentRedacted: sanitized.contentRedacted,
    bytes: jsonUtf8Bytes(results.hits),
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Session: ${record.sessionKey}`);
  runtime.log(
    `Query: ${query} (${results.hits.length}/${results.totalHits} sanitized snippet hit(s) shown${payload.truncated ? "; bounded output" : ""})`,
  );
  if (results.hits.length === 0) {
    return;
  }
  for (const hit of results.hits) {
    runtime.log(`[${hit.seq}] ${hit.role.padEnd(9)} ${hit.snippet}`);
  }
}

export async function sessionsFindCommand(
  opts: ExploreScopeOptions & {
    query: string;
    limit?: unknown;
    json?: boolean;
    active?: unknown;
  },
  runtime: RuntimeEnv,
) {
  const query = normalizeLowercaseStringOrEmpty(opts.query);
  if (!query) {
    runtime.error("Query is required");
    runtime.exit(1);
    return;
  }

  const scoped = resolveScopedTargets({
    scope: opts,
    runtime,
    defaultAllAgents: true,
  });
  if (!scoped) {
    return;
  }

  const limit = parseBoundedPositiveInteger({
    label: "--limit",
    value: opts.limit,
    runtime,
    defaultValue: DEFAULT_FIND_LIMIT,
    max: MAX_FIND_LIMIT,
  });
  const activeMinutes = parseBoundedPositiveInteger({
    label: "--active",
    value: opts.active,
    runtime,
    defaultValue: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (limit === null || activeMinutes === null) {
    return;
  }

  const now = Date.now();
  const candidates: FindCandidate[] = [];
  for (const target of scoped.targets) {
    const store = loadSessionStore(target.storePath);
    for (const [storeKey, entry] of Object.entries(store)) {
      if (!entry) {
        continue;
      }
      if (
        opts.active !== undefined &&
        (typeof entry.updatedAt !== "number" || now - entry.updatedAt > activeMinutes * 60_000)
      ) {
        continue;
      }
      const key = canonicalizeKeyForTarget({ key: storeKey, agentId: target.agentId });
      const candidate = rankFindCandidate({
        key,
        agentId: target.agentId,
        storePath: target.storePath,
        entry,
        query,
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const sliced = candidates.slice(0, limit);
  const payload = {
    query: opts.query,
    metadataOnly: true,
    searchedStores: scoped.targets.length,
    totalCandidates: candidates.length,
    truncated: candidates.length > sliced.length,
    sessions: sliced.map((candidate) => ({
      agentId: candidate.agentId,
      storePath: candidate.storePath,
      key: candidate.key,
      updatedAt: candidate.updatedAt,
      sessionId: candidate.sessionId ?? null,
      displayName: candidate.displayName ?? null,
      subject: candidate.subject ?? null,
      label: candidate.label ?? null,
      channel: candidate.channel ?? null,
      model: candidate.model ?? null,
      matchedFields: candidate.matchedFields,
      match: {
        field: candidate.matchField,
        value: candidate.matchValue,
      },
      score: candidate.score,
    })),
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  renderFindResults({
    runtime,
    query: opts.query,
    candidates: sliced,
    searchedStores: scoped.targets.length,
    truncated: payload.truncated,
  });
}
