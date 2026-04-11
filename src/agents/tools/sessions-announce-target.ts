import { parseTelegramTarget } from "../../../extensions/telegram/src/targets.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { SessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

function resolveBoundAnnounceAccountId(params: {
  sessionKey: string;
  displayKey: string;
  channel?: string;
  accountId?: string;
}): string | undefined {
  const normalizedChannel =
    normalizeChannelId(params.channel) ?? normalizeLowercaseStringOrEmpty(params.channel);
  if (!normalizedChannel) {
    return params.accountId;
  }

  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey || params.displayKey);
  const boundAccounts = buildChannelAccountBindings(cfg).get(normalizedChannel)?.get(agentId) ?? [];
  if (boundAccounts.length === 0) {
    return params.accountId;
  }

  const currentAccountId =
    typeof params.accountId === "string" && params.accountId.trim()
      ? normalizeAccountId(params.accountId)
      : undefined;
  if (currentAccountId && boundAccounts.includes(currentAccountId)) {
    return currentAccountId;
  }

  const sameNameAccount = boundAccounts.find((accountId) => accountId === agentId);
  return sameNameAccount ?? boundAccounts[0] ?? currentAccountId;
}

function inferAnnounceTargetFromSessionRow(params: {
  row?: SessionListRow;
  sessionKey: string;
  displayKey: string;
  channel?: string;
  accountId?: string;
}): AnnounceTarget | null {
  const row = params.row;
  const normalizedChannel =
    normalizeChannelId(params.channel) ?? normalizeLowercaseStringOrEmpty(params.channel);
  if (!row || !normalizedChannel) {
    return null;
  }

  const groupId =
    typeof row.groupId === "string" && row.groupId.trim() ? row.groupId.trim() : undefined;
  const inferredFromTelegramGroup =
    normalizedChannel === "telegram" && groupId
      ? (() => {
          const topicMatch = /^(-?\d+):topic:(\d+)$/i.exec(groupId);
          if (topicMatch) {
            return {
              channel: "telegram",
              to: topicMatch[1],
              threadId: topicMatch[2],
            } satisfies AnnounceTarget;
          }
          const chatMatch = /^-?\d+$/.exec(groupId);
          if (chatMatch) {
            return {
              channel: "telegram",
              to: groupId,
            } satisfies AnnounceTarget;
          }
          return null;
        })()
      : null;
  const inferredFromGroup =
    inferredFromTelegramGroup ??
    (groupId
      ? resolveAnnounceTargetFromKey(
          `agent:${resolveAgentIdFromSessionKey(row.key || params.sessionKey)}:${normalizedChannel}:group:${groupId}`,
        )
      : null);
  const inferredFromParent =
    typeof row.spawnedBy === "string" && row.spawnedBy.trim()
      ? resolveAnnounceTargetFromKey(row.spawnedBy)
      : null;
  const inferred =
    normalizedChannel === "telegram"
      ? (inferredFromTelegramGroup ?? inferredFromGroup ?? inferredFromParent)
      : (inferredFromParent ?? inferredFromGroup);
  if (!inferred?.to) {
    return null;
  }

  const normalizedInferred = normalizeTelegramAnnounceTarget({
    target: inferred,
    fallbackThreadId:
      typeof row.lastThreadId === "string" || typeof row.lastThreadId === "number"
        ? String(row.lastThreadId)
        : undefined,
  });

  return {
    ...(normalizedInferred ?? inferred),
    accountId: resolveBoundAnnounceAccountId({
      sessionKey: row.key || params.sessionKey,
      displayKey: params.displayKey,
      channel: (normalizedInferred ?? inferred).channel ?? normalizedChannel,
      accountId: params.accountId,
    }),
  };
}

function normalizeTelegramAnnounceTarget(params: {
  target: AnnounceTarget;
  fallbackThreadId?: string;
}): AnnounceTarget | null {
  const normalizedChannel =
    normalizeChannelId(params.target.channel) ??
    normalizeLowercaseStringOrEmpty(params.target.channel);
  if (normalizedChannel !== "telegram") {
    return params.target;
  }
  const parsed = parseTelegramTarget(params.target.to);
  const chatId = normalizeOptionalString(parsed.chatId);
  if (!chatId) {
    return null;
  }
  const threadId =
    normalizeOptionalString(params.target.threadId) ??
    (parsed.messageThreadId != null ? String(parsed.messageThreadId) : undefined) ??
    normalizeOptionalString(params.fallbackThreadId);
  return {
    channel: "telegram",
    to: chatId,
    accountId: params.target.accountId,
    ...(threadId ? { threadId } : {}),
  };
}

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
  const fallback = parsed ?? parsedDisplay ?? null;

  if (fallback) {
    const normalized = normalizeChannelId(fallback.channel);
    const plugin = normalized ? getChannelPlugin(normalized) : null;
    if (!plugin?.meta?.preferSessionLookupForAnnounceTarget) {
      return fallback;
    }
  }

  try {
    const list = await callGateway<{ sessions: Array<SessionListRow> }>({
      method: "sessions.list",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const match =
      sessions.find((entry) => entry?.key === params.sessionKey) ??
      sessions.find((entry) => entry?.key === params.displayKey);

    const deliveryContext =
      match?.deliveryContext && typeof match.deliveryContext === "object"
        ? (match.deliveryContext as Record<string, unknown>)
        : undefined;
    const origin =
      match?.origin && typeof match.origin === "object"
        ? (match.origin as Record<string, unknown>)
        : undefined;
    const channel =
      (typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined) ??
      (typeof match?.lastChannel === "string" ? match.lastChannel : undefined) ??
      (typeof origin?.provider === "string" ? origin.provider : undefined);
    const to =
      (typeof deliveryContext?.to === "string" ? deliveryContext.to : undefined) ??
      (typeof match?.lastTo === "string" ? match.lastTo : undefined);
    const accountId =
      (typeof deliveryContext?.accountId === "string" ? deliveryContext.accountId : undefined) ??
      (typeof match?.lastAccountId === "string" ? match.lastAccountId : undefined) ??
      (typeof origin?.accountId === "string" ? origin.accountId : undefined);
    const threadId =
      (typeof deliveryContext?.threadId === "string" ||
      typeof deliveryContext?.threadId === "number"
        ? String(deliveryContext.threadId)
        : undefined) ??
      (typeof match?.lastThreadId === "string" || typeof match?.lastThreadId === "number"
        ? String(match.lastThreadId)
        : undefined) ??
      (typeof origin?.threadId === "string" || typeof origin?.threadId === "number"
        ? String(origin.threadId)
        : undefined);
    if (channel && to) {
      const effectiveAccountId = fallback
        ? accountId
        : resolveBoundAnnounceAccountId({
            sessionKey: match?.key ?? params.sessionKey,
            displayKey: params.displayKey,
            channel,
            accountId,
          });
      const directTarget = normalizeTelegramAnnounceTarget({
        target: { channel, to, accountId: effectiveAccountId, ...(threadId ? { threadId } : {}) },
        fallbackThreadId: threadId,
      });
      if (directTarget) {
        const inferredTarget = inferAnnounceTargetFromSessionRow({
          row: match,
          sessionKey: params.sessionKey,
          displayKey: params.displayKey,
          channel,
          accountId: effectiveAccountId,
        });
        if (
          normalizeChannelId(directTarget.channel) === "telegram" &&
          !normalizeOptionalString(directTarget.threadId) &&
          inferredTarget?.threadId &&
          inferredTarget.to === directTarget.to
        ) {
          return {
            ...directTarget,
            threadId: inferredTarget.threadId,
            accountId: directTarget.accountId ?? inferredTarget.accountId,
          };
        }
        return directTarget;
      }
      return { channel, to, accountId: effectiveAccountId, ...(threadId ? { threadId } : {}) };
    }
    const inferredTarget = inferAnnounceTargetFromSessionRow({
      row: match,
      sessionKey: params.sessionKey,
      displayKey: params.displayKey,
      channel,
      accountId,
    });
    if (inferredTarget) {
      return inferredTarget;
    }
  } catch {
    // ignore
  }

  return fallback;
}
