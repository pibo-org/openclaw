import type { FileUIPart } from "ai";
import type { ChatAttachment } from "../../../../ui/src/ui/ui-types.ts";
import type { ModelCatalogEntry, SessionsListResult } from "../../../../ui/src/ui/types.ts";
import { type ToolStreamEntry } from "../../../../ui/src/ui/app-tool-stream.ts";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../../src/gateway/control-ui-contract.ts";

declare const __OPENCLAW_DEV_GATEWAY_TOKEN__: string | undefined;
declare global {
  interface Window {
    __OPENCLAW_BOOTSTRAP_GATEWAY_TOKEN__?: string;
  }
}

export type CustomUiSettings = {
  gatewayUrl: string;
  sessionKey: string;
  token: string;
};

export type CustomUiConnectionSettings = CustomUiSettings & {
  password: string;
};

export type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

export type TranscriptAttachment = FileUIPart & {
  id: string;
};

export type TranscriptToolCard = {
  id: string;
  title: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  state:
    | "approval-requested"
    | "approval-responded"
    | "input-available"
    | "input-streaming"
    | "output-available"
    | "output-denied"
    | "output-error";
};

export type RenderableMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  text: string | null;
  reasoning: string | null;
  attachments: TranscriptAttachment[];
  tools: TranscriptToolCard[];
  timestamp: number | null;
  streaming?: boolean;
};

export type GatewayChatHost = {
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> } | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  chatStreamSegments: Array<{ text: string; ts: number }>;
  toolStreamSyncTimer: number | null;
};

type BootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
};

const SETTINGS_KEY = "openclaw.custom-ui.settings.v1";
const TOKEN_KEY_PREFIX = "openclaw.custom-ui.token.v1:";
const DEFAULT_GATEWAY_PROXY_PATH = "/__openclaw/gateway";

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeGatewayTokenScope(gatewayUrl: string): string {
  const trimmed = trimToNull(gatewayUrl) ?? "";
  if (!trimmed) {
    return "default";
  }
  try {
    const parsed = new URL(trimmed, window.location.href);
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return trimmed;
  }
}

function tokenStorageKey(gatewayUrl: string): string {
  return `${TOKEN_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

function loadSessionToken(gatewayUrl: string): string {
  try {
    return trimToNull(window.sessionStorage.getItem(tokenStorageKey(gatewayUrl))) ?? "";
  } catch {
    return "";
  }
}

function resolveDefaultDevToken(): string {
  if (!import.meta.env.DEV) {
    return "";
  }
  return trimToNull(__OPENCLAW_DEV_GATEWAY_TOKEN__) ?? "";
}

function resolveBootstrapGatewayToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return trimToNull(window.__OPENCLAW_BOOTSTRAP_GATEWAY_TOKEN__) ?? "";
}

function resolveSessionTokenWithDevFallback(gatewayUrl: string): string {
  return loadSessionToken(gatewayUrl) || resolveBootstrapGatewayToken() || resolveDefaultDevToken();
}

function persistSessionToken(gatewayUrl: string, token: string) {
  try {
    const key = tokenStorageKey(gatewayUrl);
    const normalized = trimToNull(token) ?? "";
    if (normalized) {
      window.sessionStorage.setItem(key, normalized);
      return;
    }
    window.sessionStorage.removeItem(key);
  } catch {
    // Best effort only.
  }
}

function inferBasePathFromLocation(): string {
  const pathname = window.location.pathname || "/";
  if (pathname === "/") {
    return "";
  }
  const trimmedIndex = pathname.endsWith("/index.html")
    ? pathname.slice(0, -"/index.html".length)
    : pathname;
  const withoutSlash = trimmedIndex.replace(/\/+$/, "");
  return withoutSlash === "/" ? "" : withoutSlash;
}

function inferDevGatewayHost(): string {
  const hostname = window.location.hostname;
  const labels = hostname.split(".");
  const first = labels[0] ?? "";
  const suffix = labels.slice(1).join(".");
  const firstIsPortLike = /^\d{2,5}$/.test(first);
  const usesWildcardIpHost =
    hostname.endsWith(".sslip.io") ||
    hostname.endsWith(".nip.io") ||
    hostname.endsWith(".traefik.me");

  // Dev pages exposed through hosts like 5174.192.168.0.204.sslip.io need the
  // gateway host rewritten to 18789.192.168.0.204.sslip.io instead of adding
  // :18789 to the existing frontend host.
  if (firstIsPortLike && usesWildcardIpHost && suffix) {
    return `18789.${suffix}`;
  }

  return `${hostname}:18789`;
}

export function buildDefaultGatewayUrl(basePath: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  void basePath;
  return `${protocol}//${window.location.host}${DEFAULT_GATEWAY_PROXY_PATH}`;
}

function isLegacyDevGatewayUrl(raw: string, basePath: string): boolean {
  try {
    const parsed = new URL(raw, window.location.href);
    const normalizedParsedPath = parsed.pathname.replace(/\/+$/, "") || "/";

    if (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      parsed.host === window.location.host &&
      normalizedParsedPath === "/"
    ) {
      return true;
    }

    if (!import.meta.env.DEV) {
      return false;
    }

    const oldDirectHost = inferDevGatewayHost();
    const normalizedBasePath = (basePath || "/").replace(/\/+$/, "") || "/";
    return (
      (parsed.host === oldDirectHost &&
        (normalizedParsedPath === "/" || normalizedParsedPath === normalizedBasePath)) ||
      (parsed.hostname === window.location.hostname && parsed.port === "18789")
    );
  } catch {
    return false;
  }
}

function normalizeGatewayUrl(raw: string, basePath: string): string {
  const normalized = trimToNull(raw);
  if (!normalized) {
    return buildDefaultGatewayUrl(basePath);
  }
  if (isLegacyDevGatewayUrl(normalized, basePath)) {
    return buildDefaultGatewayUrl(basePath);
  }
  return normalized;
}

export function loadCustomUiSettings(): CustomUiConnectionSettings {
  const basePath = inferBasePathFromLocation();
  const defaultGatewayUrl = buildDefaultGatewayUrl(basePath);
  const defaults: CustomUiConnectionSettings = {
    gatewayUrl: defaultGatewayUrl,
    password: "",
    sessionKey: "main",
    token: resolveSessionTokenWithDevFallback(defaultGatewayUrl),
  };

  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return applyUrlOverrides(defaults);
    }
    const parsed = JSON.parse(raw) as Partial<CustomUiSettings>;
    const gatewayUrl = normalizeGatewayUrl(parsed.gatewayUrl ?? defaults.gatewayUrl, basePath);
    const next = {
      gatewayUrl,
      password: "",
      sessionKey: trimToNull(parsed.sessionKey) ?? defaults.sessionKey,
      token: resolveSessionTokenWithDevFallback(gatewayUrl),
    } satisfies CustomUiConnectionSettings;
    return applyUrlOverrides(next);
  } catch {
    return applyUrlOverrides(defaults);
  }
}

function applyUrlOverrides(settings: CustomUiConnectionSettings): CustomUiConnectionSettings {
  const basePath = inferBasePathFromLocation();
  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const token = trimToNull(hashParams.get("token")) ?? trimToNull(url.searchParams.get("token"));
  const gatewayUrl =
    trimToNull(hashParams.get("gatewayUrl")) ?? trimToNull(url.searchParams.get("gatewayUrl"));
  const sessionKey =
    trimToNull(hashParams.get("sessionKey")) ?? trimToNull(url.searchParams.get("sessionKey"));
  const next = {
    ...settings,
    gatewayUrl: normalizeGatewayUrl(gatewayUrl ?? settings.gatewayUrl, basePath),
    sessionKey: sessionKey ?? settings.sessionKey,
    token: token ?? settings.token,
  };

  if (token || gatewayUrl || sessionKey) {
    url.searchParams.delete("token");
    url.searchParams.delete("gatewayUrl");
    url.searchParams.delete("sessionKey");
    hashParams.delete("token");
    hashParams.delete("gatewayUrl");
    hashParams.delete("sessionKey");
    const nextHash = hashParams.toString();
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`);
  }

  return next;
}

export function persistCustomUiSettings(settings: CustomUiSettings) {
  const next = {
    gatewayUrl: settings.gatewayUrl,
    sessionKey: settings.sessionKey,
  };
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Best effort only.
  }
  persistSessionToken(settings.gatewayUrl, settings.token);
}

export async function loadBootstrapConfig(basePath = inferBasePathFromLocation()) {
  const normalizedBasePath = normalizeBasePath(basePath);
  const url = normalizedBasePath
    ? `${normalizedBasePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
  try {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
    });
    if (!res.ok) {
      return {
        assistantAvatar: "",
        assistantName: "OpenClaw",
        basePath: normalizedBasePath,
      };
    }
    const parsed = (await res.json()) as BootstrapConfig;
    return {
      assistantAvatar: trimToNull(parsed.assistantAvatar) ?? "",
      assistantName: trimToNull(parsed.assistantName) ?? "OpenClaw",
      basePath: normalizeBasePath(parsed.basePath ?? normalizedBasePath),
    };
  } catch {
    return {
      assistantAvatar: "",
      assistantName: "OpenClaw",
      basePath: normalizedBasePath,
    };
  }
}

export function createGatewayChatHost(sessionKey: string): GatewayChatHost {
  return {
    chatAttachments: [],
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamSegments: [],
    chatStreamStartedAt: null,
    chatThinkingLevel: null,
    chatToolMessages: [],
    client: null,
    connected: false,
    lastError: null,
    sessionKey,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
  };
}

export function resolveSessionKeyWithDefaults(
  sessionKey: string,
  defaults?: SessionDefaultsSnapshot | null,
) {
  const raw = trimToNull(sessionKey) ?? "main";
  const mainSessionKey = trimToNull(defaults?.mainSessionKey);
  if (!mainSessionKey) {
    return raw;
  }
  const mainKey = trimToNull(defaults?.mainKey) ?? "main";
  const defaultAgentId = trimToNull(defaults?.defaultAgentId);
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

export function resolveActiveSessionKey(params: {
  currentSessionKey: string;
  defaults?: SessionDefaultsSnapshot | null;
  sessions?: SessionsListResult["sessions"];
}) {
  const current = resolveSessionKeyWithDefaults(params.currentSessionKey, params.defaults);
  const sessions = params.sessions ?? [];
  if (sessions.some((row) => row.key === current)) {
    return current;
  }
  const defaultKey = trimToNull(params.defaults?.mainSessionKey);
  if (defaultKey && sessions.some((row) => row.key === defaultKey)) {
    return defaultKey;
  }
  return sessions[0]?.key ?? current;
}

export async function loadModelCatalog(
  client: { request: <T = unknown>(method: string, params?: unknown) => Promise<T> },
) {
  return client
    .request<{ models?: ModelCatalogEntry[] }>("models.list", {})
    .then((result) => result.models ?? []);
}

function sourceToUrl(source: Record<string, unknown>, mediaType: string, fallbackUrl: string) {
  const explicitUrl = trimToNull(
    typeof source.url === "string" ? source.url : typeof source.href === "string" ? source.href : null,
  );
  if (explicitUrl) {
    return explicitUrl;
  }
  const base64 = trimToNull(
    typeof source.data === "string" ? source.data : typeof source.content === "string" ? source.content : null,
  );
  if (!base64) {
    return fallbackUrl;
  }
  if (base64.startsWith("data:")) {
    return base64;
  }
  return `data:${mediaType};base64,${base64}`;
}

export function extractAttachmentsFromMessage(message: unknown): TranscriptAttachment[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const record = message as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const attachments: TranscriptAttachment[] = [];
  for (const [index, part] of content.entries()) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const entry = part as Record<string, unknown>;
    if (entry.type !== "image" && entry.type !== "audio" && entry.type !== "file") {
      continue;
    }
    const source = entry.source && typeof entry.source === "object" ? (entry.source as Record<string, unknown>) : {};
    const mediaType =
      trimToNull(
        typeof source.media_type === "string"
          ? source.media_type
          : typeof entry.mediaType === "string"
            ? entry.mediaType
            : null,
      ) ?? (entry.type === "audio" ? "audio/mpeg" : entry.type === "image" ? "image/png" : "application/octet-stream");
    const url = sourceToUrl(source, mediaType, "");
    if (!url) {
      continue;
    }
    attachments.push({
      filename:
        trimToNull(typeof entry.filename === "string" ? entry.filename : null) ??
        `${entry.type}-${index + 1}`,
      id: `${entry.type}-${index}`,
      mediaType,
      type: "file",
      url,
    });
  }
  return attachments;
}

export function extractToolCardsFromMessage(message: unknown): TranscriptToolCard[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const record = message as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const tools: TranscriptToolCard[] = [];
  for (const [index, part] of content.entries()) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const entry = part as Record<string, unknown>;
    if (entry.type === "toolcall") {
      const title = trimToNull(typeof entry.name === "string" ? entry.name : null) ?? "tool";
      tools.push({
        id: `tool-${index}`,
        input: entry.arguments,
        state: "input-available",
        title,
      });
      continue;
    }
    if (entry.type === "toolresult") {
      const title = trimToNull(typeof entry.name === "string" ? entry.name : null) ?? "tool";
      const existing = [...tools].toReversed().find((tool) => tool.title === title && !tool.output);
      const payload = typeof entry.text === "string" ? entry.text : entry.result ?? entry.output;
      const errorText = trimToNull(typeof entry.errorText === "string" ? entry.errorText : null);
      if (existing) {
        existing.output = payload;
        existing.errorText = errorText ?? undefined;
        existing.state = errorText ? "output-error" : "output-available";
      } else {
        tools.push({
          errorText: errorText ?? undefined,
          id: `tool-result-${index}`,
          output: payload,
          state: errorText ? "output-error" : "output-available",
          title,
        });
      }
    }
  }
  return tools;
}

function normalizeRole(role: unknown): "assistant" | "user" | "system" {
  if (typeof role !== "string") {
    return "assistant";
  }
  const normalized = role.trim().toLowerCase();
  if (normalized === "user") {
    return "user";
  }
  if (normalized === "system") {
    return "system";
  }
  return "assistant";
}

export function formatRelativeTime(timestamp: number | null) {
  if (!timestamp) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);
  } catch {
    return "";
  }
}

export async function filePartToChatAttachment(file: FileUIPart, index: number): Promise<ChatAttachment | null> {
  const url = trimToNull(file.url);
  const mimeType = trimToNull(file.mediaType) ?? "application/octet-stream";
  if (!url) {
    return null;
  }
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("error", () => reject(new Error("Failed to read attachment.")), { once: true });
      reader.addEventListener(
        "load",
        () => {
          if (typeof reader.result !== "string") {
            reject(new Error("Attachment data URL was not a string."));
            return;
          }
          resolve(reader.result);
        },
        { once: true },
      );
      reader.readAsDataURL(blob);
    });
    return {
      dataUrl,
      id: file.filename ?? `attachment-${index}`,
      mimeType,
    };
  } catch {
    return null;
  }
}

export async function filePartsToChatAttachments(files: FileUIPart[]) {
  const items = await Promise.all(files.map((file, index) => filePartToChatAttachment(file, index)));
  return items.filter((item): item is ChatAttachment => item !== null);
}

export function toRenderableMessage(params: {
  message: unknown;
  index: number;
  extractReasoning: (message: unknown) => string | null;
  extractText: (message: unknown) => string | null;
}) {
  const { message, index, extractReasoning, extractText } = params;
  const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
  return {
    attachments: extractAttachmentsFromMessage(message),
    id:
      trimToNull(typeof record.id === "string" ? record.id : null) ??
      trimToNull(typeof record.toolCallId === "string" ? record.toolCallId : null) ??
      `${normalizeRole(record.role)}-${index}`,
    reasoning: extractReasoning(message),
    role: normalizeRole(record.role),
    text: extractText(message),
    timestamp: typeof record.timestamp === "number" ? record.timestamp : null,
    tools: extractToolCardsFromMessage(message),
  } satisfies RenderableMessage;
}
