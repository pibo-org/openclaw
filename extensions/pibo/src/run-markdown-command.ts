import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionEntry } from "../../../src/config/sessions/types.js";
import { loadRegistry, type PromptCommandMeta } from "./prompt-command-registry.js";

type SessionStoreEntry = {
  sessionId?: string;
  sessionFile?: string;
  modelProvider?: string;
  model?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  lastFrom?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  origin?: Record<string, unknown>;
  updatedAt?: number;
  createdAt?: number;
};

type ModelSelection = {
  provider?: string;
  model?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

type EmbeddedRunResult = {
  didSendViaMessagingTool?: boolean;
  payloads?: Array<{ type?: string; text?: string }>;
  text?: string;
};

type CommandReply = {
  text: string;
  isError?: boolean;
};

const AGENT_ID = "main";
const TEMP_SESSION_DIR = path.join(os.homedir(), ".cache", "openclaw-pibo", "sessions");

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*/m, "").trim();
}

function buildPrompt(markdown: string, args: string | undefined, meta: PromptCommandMeta): string {
  const base = stripFrontmatter(markdown);
  const extra = args?.trim();
  if (meta.behavior === "mode" || meta.behavior === "one-shot") {
    return extra ? `${base}\n\n---\n\nZusätzlicher Nutzerkontext:\n${extra}` : base;
  }
  return extra ? `${base}\n\n---\n\nKonkreter aktueller Auftrag / Kontext:\n${extra}` : base;
}

function deriveTelegramSessionKeyFromRoute(ctx: PluginCommandContext): string | null {
  const rawTarget =
    typeof ctx.to === "string" && ctx.to.startsWith("slash:")
      ? (ctx.from ?? ctx.to)
      : (ctx.to ?? ctx.from);
  if (!rawTarget) {
    return null;
  }
  let target = rawTarget.startsWith("telegram:") ? rawTarget.slice("telegram:".length) : rawTarget;
  if (target.startsWith("group:")) {
    const threadId = ctx.messageThreadId;
    return threadId != null
      ? `agent:${AGENT_ID}:telegram:${target}:topic:${threadId}`
      : `agent:${AGENT_ID}:telegram:${target}`;
  }
  if (target.startsWith("direct:") || target.startsWith("user:")) {
    return `agent:${AGENT_ID}:telegram:${target}`;
  }
  return null;
}

function deriveTargetSessionKey(ctx: PluginCommandContext): string {
  if (ctx.channel === "telegram") {
    return (
      deriveTelegramSessionKeyFromRoute(ctx) ??
      `agent:${AGENT_ID}:telegram:direct:${ctx.senderId ?? "unknown"}`
    );
  }
  return `agent:${AGENT_ID}:${ctx.channel}:direct:${ctx.senderId ?? "unknown"}`;
}

function resolveRunModel(entry: SessionStoreEntry | undefined): ModelSelection {
  return {
    provider: entry?.modelProvider,
    model: entry?.model,
    authProfileId: entry?.authProfileOverride,
    authProfileIdSource: entry?.authProfileOverrideSource,
  };
}

function parseModelRef(ref: string | undefined): { provider?: string; model?: string } {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return {};
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return {};
  }
  return {
    provider: trimmed.slice(0, slashIndex),
    model: trimmed.slice(slashIndex + 1),
  };
}

function pickPrimaryModelRef(candidate: unknown): string | undefined {
  if (typeof candidate === "string") {
    return candidate;
  }
  if (candidate && typeof candidate === "object") {
    const primary = (candidate as { primary?: unknown }).primary;
    return typeof primary === "string" ? primary : undefined;
  }
  return undefined;
}

function resolveConfiguredDefaultModel(config: unknown): ModelSelection {
  const cfg = (config ?? {}) as {
    agents?: {
      defaults?: { model?: unknown };
      list?: Array<{ id?: string; model?: unknown }>;
    };
  };
  const agentEntry = cfg.agents?.list?.find((entry) => entry?.id === AGENT_ID);
  const modelRef =
    pickPrimaryModelRef(agentEntry?.model) ?? pickPrimaryModelRef(cfg.agents?.defaults?.model);
  const { provider, model } = parseModelRef(modelRef);
  return { provider, model };
}

function mergeModelSelection(primary: ModelSelection, fallback: ModelSelection): ModelSelection {
  return {
    provider: primary.provider ?? fallback.provider,
    model: primary.model ?? fallback.model,
    authProfileId: primary.authProfileId ?? fallback.authProfileId,
    authProfileIdSource: primary.authProfileIdSource ?? fallback.authProfileIdSource,
  };
}

function normalizeRunReply(result: EmbeddedRunResult): CommandReply {
  if (result.didSendViaMessagingTool) {
    return { text: "" };
  }
  const payloadText = result.payloads
    ?.map((payload) => payload.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  return { text: payloadText || result.text?.trim() || "⚠️ Keine Antwort erhalten." };
}

async function ensureSessionBinding(
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
  sessionKey: string,
  seedModel?: ModelSelection,
): Promise<{
  sessionId: string;
  sessionFile: string;
  sessionEntry: SessionStoreEntry | undefined;
}> {
  const storePath = api.runtime.agent.session.resolveStorePath(undefined, { agentId: AGENT_ID });
  const store = api.runtime.agent.session.loadSessionStore(storePath) as Record<
    string,
    SessionStoreEntry
  >;
  const existing = store[sessionKey];
  const sessionId = existing?.sessionId ?? ctx.sessionId ?? crypto.randomUUID();
  const sessionFile =
    existing?.sessionFile ??
    api.runtime.agent.session.resolveSessionFilePath(sessionId, existing as never, {
      agentId: AGENT_ID,
    });
  const now = Date.now();

  store[sessionKey] = {
    ...existing,
    sessionId,
    sessionFile,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
    lastFrom: ctx.from ?? existing?.lastFrom,
    lastTo: ctx.to ?? ctx.from ?? existing?.lastTo,
    lastAccountId: ctx.accountId ?? existing?.lastAccountId,
    lastThreadId: ctx.messageThreadId ?? existing?.lastThreadId,
    modelProvider: existing?.modelProvider ?? seedModel?.provider,
    model: existing?.model ?? seedModel?.model,
    authProfileOverride: existing?.authProfileOverride ?? seedModel?.authProfileId,
    authProfileOverrideSource:
      existing?.authProfileOverrideSource ?? seedModel?.authProfileIdSource,
    origin: existing?.origin ?? {
      provider: ctx.channel,
      surface: ctx.channel,
    },
  };

  api.runtime.agent.session.saveSessionStore(storePath, store as Record<string, SessionEntry>);
  return { sessionId, sessionFile, sessionEntry: store[sessionKey] };
}

function createEphemeralSessionFile(baseSessionFile?: string): {
  sessionId: string;
  sessionFile: string;
} {
  fs.mkdirSync(TEMP_SESSION_DIR, { recursive: true });
  const sessionId = crypto.randomUUID();
  const sessionFile = path.join(TEMP_SESSION_DIR, `${sessionId}.jsonl`);
  if (baseSessionFile && fs.existsSync(baseSessionFile)) {
    fs.copyFileSync(baseSessionFile, sessionFile);
  } else {
    fs.writeFileSync(sessionFile, "", "utf8");
  }
  return { sessionId, sessionFile };
}

export async function runMarkdownCommandByName(
  api: OpenClawPluginApi,
  name: string,
  ctx: PluginCommandContext,
): Promise<CommandReply> {
  const registry = loadRegistry();
  const entry = registry.commands[name];
  if (!entry) {
    return { text: `❌ Command nicht gefunden: /${name}` };
  }

  const markdown = fs.readFileSync(entry.file, "utf8");
  const prompt = buildPrompt(markdown, ctx.args, entry.meta);
  const sessionKey = deriveTargetSessionKey(ctx);

  try {
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, AGENT_ID);
    await api.runtime.agent.ensureAgentWorkspace({ dir: workspaceDir });

    const configuredDefaultModel = resolveConfiguredDefaultModel(api.config);
    const binding = await ensureSessionBinding(api, ctx, sessionKey, configuredDefaultModel);
    const isOneShot = entry.meta.behavior === "one-shot";
    const isolated = isOneShot ? createEphemeralSessionFile(binding.sessionFile) : null;
    const sessionId = isolated?.sessionId ?? binding.sessionId;
    const sessionFile = isolated?.sessionFile ?? binding.sessionFile;
    const inheritedModel = resolveRunModel(binding.sessionEntry);
    const runModel = mergeModelSelection(inheritedModel, configuredDefaultModel);
    const agentDir = api.runtime.agent.resolveAgentDir(api.config, AGENT_ID);
    const timeoutMs = api.runtime.agent.resolveAgentTimeoutMs({ cfg: api.config });

    api.logger.info?.(
      `pibo: /${name} invoked behavior=${entry.meta.behavior ?? "mode"} channel=${ctx.channel} sessionKey=${ctx.sessionKey ?? ""} targetSessionKey=${sessionKey} isolated=${isOneShot ? "yes" : "no"} from=${ctx.from ?? ""} to=${ctx.to ?? ""} thread=${ctx.messageThreadId ?? ""} provider=${runModel.provider ?? ""} model=${runModel.model ?? ""} auth=${runModel.authProfileId ?? ""}`,
    );

    const result = (await api.runtime.agent.runEmbeddedPiAgent({
      agentId: AGENT_ID,
      agentDir,
      sessionId,
      sessionFile,
      workspaceDir,
      config: api.config,
      prompt,
      timeoutMs,
      provider: runModel.provider,
      model: runModel.model,
      authProfileId: runModel.authProfileId,
      authProfileIdSource: runModel.authProfileIdSource,
      messageProvider: ctx.channel,
      messageTo: ctx.to,
      agentAccountId: ctx.accountId,
      messageThreadId: ctx.messageThreadId,
      senderId: ctx.senderId,
      runId: crypto.randomUUID(),
    })) as EmbeddedRunResult;

    const reply = normalizeRunReply(result);
    if (isolated) {
      fs.rmSync(isolated.sessionFile, { force: true });
    }
    return reply;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.error?.(`pibo: /${name} failed: ${message}`);
    return { text: `❌ /${name} fehlgeschlagen:\n\n${message}`, isError: true };
  }
}
