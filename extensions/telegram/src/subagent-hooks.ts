import {
  formatThreadBindingDisabledError,
  getSessionBindingService,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { parseTelegramTarget } from "./targets.js";
import {
  createTelegramThreadBindingManager,
  getTelegramThreadBindingManager,
} from "./thread-bindings.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveTelegramRequesterConversation(params: {
  to?: string;
  threadId?: string | number;
}): {
  conversationId: string;
  parentConversationId?: string;
  deliveryTo: string;
  deliveryThreadId?: string;
} | null {
  const rawTo = normalizeOptionalString(params.to) ?? "";
  if (!rawTo) {
    return null;
  }
  const parsedTarget = parseTelegramTarget(rawTo);
  const chatId = normalizeOptionalString(parsedTarget.chatId) ?? "";
  if (!chatId) {
    return null;
  }

  const rawThreadId =
    params.threadId != null && params.threadId !== ""
      ? normalizeOptionalString(String(params.threadId))
      : parsedTarget.messageThreadId != null
        ? normalizeOptionalString(String(parsedTarget.messageThreadId))
        : undefined;
  if (rawThreadId) {
    const parsedTopic = parseTelegramTopicConversation({
      conversationId: rawThreadId,
      parentConversationId: chatId,
    });
    if (!parsedTopic) {
      return null;
    }
    return {
      conversationId: parsedTopic.canonicalConversationId,
      parentConversationId: parsedTopic.chatId,
      deliveryTo: parsedTopic.chatId,
      deliveryThreadId: parsedTopic.topicId,
    };
  }

  return {
    conversationId: chatId,
    parentConversationId: chatId,
    deliveryTo: chatId,
  };
}

function normalizeBindingMetadataValue(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const raw = (metadata as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function resolveTelegramBindingOrigin(binding: {
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
}) {
  const storedDeliveryTo = normalizeBindingMetadataValue(binding.metadata, "deliveryTo");
  const storedDeliveryThreadId = normalizeBindingMetadataValue(
    binding.metadata,
    "deliveryThreadId",
  );
  const parsedTopic = parseTelegramTopicConversation({
    conversationId: binding.conversationId,
  });
  if (parsedTopic) {
    return {
      channel: "telegram" as const,
      accountId: binding.accountId,
      to:
        normalizeOptionalString(parseTelegramTarget(storedDeliveryTo ?? "").chatId) ??
        parsedTopic.chatId,
      threadId: storedDeliveryThreadId ?? parsedTopic.topicId,
    };
  }

  const parsedTarget = parseTelegramTarget(storedDeliveryTo ?? binding.conversationId);
  const to = normalizeOptionalString(parsedTarget.chatId) ?? "";
  if (!to) {
    return null;
  }
  return {
    channel: "telegram" as const,
    accountId: binding.accountId,
    to,
    ...(storedDeliveryThreadId
      ? { threadId: storedDeliveryThreadId }
      : parsedTarget.messageThreadId != null
        ? { threadId: String(parsedTarget.messageThreadId) }
        : {}),
  };
}

function resolveMatchingTelegramChildBinding(params: {
  accountId?: string;
  childSessionKey: string;
  requesterOrigin?: {
    to?: string;
    threadId?: string | number;
  };
}) {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const bindings = manager.listBySessionKey(params.childSessionKey.trim());
  if (bindings.length === 0) {
    return null;
  }

  const requesterConversation = resolveTelegramRequesterConversation({
    to: params.requesterOrigin?.to,
    threadId: params.requesterOrigin?.threadId,
  });
  if (requesterConversation) {
    const matched = bindings.find(
      (entry) => entry.conversationId === requesterConversation.conversationId,
    );
    if (matched) {
      return matched;
    }
  }

  return bindings.length === 1 ? bindings[0] : null;
}

type TelegramSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId?: string;
  label?: string;
};

type TelegramSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

type TelegramSubagentEndedEvent = {
  accountId?: string;
  targetSessionKey: string;
};

export async function handleTelegramSubagentSpawning(
  api: OpenClawPluginApi,
  event: TelegramSubagentSpawningEvent,
) {
  if (!event.threadRequested) {
    return;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (requesterChannel !== "telegram") {
    return;
  }

  const spawnPolicy = resolveThreadBindingSpawnPolicy({
    cfg: api.config,
    channel: "telegram",
    accountId: event.requester?.accountId,
    kind: "subagent",
  });
  if (!spawnPolicy.enabled) {
    return {
      status: "error" as const,
      error: formatThreadBindingDisabledError({
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        kind: "subagent",
      }),
    };
  }
  if (!spawnPolicy.spawnEnabled) {
    return {
      status: "error" as const,
      error:
        "Telegram thread-bound subagent spawns are disabled for this account (set channels.telegram.threadBindings.spawnSubagentSessions=true to enable).",
    };
  }

  const conversation = resolveTelegramRequesterConversation({
    to: event.requester?.to,
    threadId: event.requester?.threadId,
  });
  if (!conversation) {
    return {
      status: "error" as const,
      error: "Telegram current-conversation binding requires a Telegram chat or topic target.",
    };
  }

  createTelegramThreadBindingManager({
    accountId: event.requester?.accountId,
  });
  try {
    const binding = await getSessionBindingService().bind({
      targetSessionKey: event.childSessionKey,
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: spawnPolicy.accountId,
        conversationId: conversation.conversationId,
        ...(conversation.parentConversationId &&
        conversation.parentConversationId !== conversation.conversationId
          ? { parentConversationId: conversation.parentConversationId }
          : {}),
      },
      placement: "current",
      metadata: {
        agentId: event.agentId,
        label: event.label,
        boundBy: "system",
        deliveryTo: conversation.deliveryTo,
        deliveryThreadId: conversation.deliveryThreadId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg: api.config,
          channel: "telegram",
          accountId: spawnPolicy.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg: api.config,
          channel: "telegram",
          accountId: spawnPolicy.accountId,
        }),
      },
    });
    if (!binding) {
      return {
        status: "error" as const,
        error:
          "Unable to bind this Telegram conversation to the spawned subagent session. Session mode is unavailable for this target.",
      };
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  } catch (err) {
    return {
      status: "error" as const,
      error: `Telegram conversation bind failed: ${summarizeError(err)}`,
    };
  }
}

export function handleTelegramSubagentDeliveryTarget(event: TelegramSubagentDeliveryTargetEvent) {
  if (!event.expectsCompletionMessage) {
    return;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "telegram") {
    return;
  }

  const binding = resolveMatchingTelegramChildBinding({
    accountId: event.requesterOrigin?.accountId,
    childSessionKey: event.childSessionKey,
    requesterOrigin: {
      to: event.requesterOrigin?.to,
      threadId: event.requesterOrigin?.threadId,
    },
  });
  if (!binding) {
    return;
  }

  const origin = resolveTelegramBindingOrigin(binding);
  return origin ? { origin } : undefined;
}

export function handleTelegramSubagentEnded(event: TelegramSubagentEndedEvent) {
  const manager = getTelegramThreadBindingManager(event.accountId);
  manager?.unbindBySessionKey({
    targetSessionKey: event.targetSessionKey,
    reason: "subagent-ended",
    sendFarewell: false,
  });
}

export function registerTelegramSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", (event) => handleTelegramSubagentSpawning(api, event));
  api.on("subagent_delivery_target", (event) => handleTelegramSubagentDeliveryTarget(event));
  api.on("subagent_ended", (event) => handleTelegramSubagentEnded(event));
}
