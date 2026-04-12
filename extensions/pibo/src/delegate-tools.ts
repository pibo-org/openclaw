import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createSessionsSendTool } from "../../../src/agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../../src/agents/tools/sessions-spawn-tool.js";
import {
  readPiboDelegateRecord,
  writePiboDelegateRecord,
  type PiboDelegateOrigin,
  type PiboDelegateRecord,
} from "./delegate-store.js";

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function normalizeOrigin(ctx: OpenClawPluginToolContext): PiboDelegateOrigin | undefined {
  const delivery = ctx.deliveryContext;
  if (!delivery) {
    return undefined;
  }
  const origin: PiboDelegateOrigin = {
    ...(typeof delivery.channel === "string" && delivery.channel
      ? { channel: delivery.channel }
      : {}),
    ...(typeof delivery.accountId === "string" && delivery.accountId
      ? { accountId: delivery.accountId }
      : typeof ctx.agentAccountId === "string" && ctx.agentAccountId
        ? { accountId: ctx.agentAccountId }
        : {}),
    ...(typeof delivery.to === "string" && delivery.to ? { to: delivery.to } : {}),
    ...(delivery.threadId != null && delivery.threadId !== ""
      ? { threadId: String(delivery.threadId) }
      : {}),
  };
  return Object.keys(origin).length > 0 ? origin : undefined;
}

function requireTrustedSessionContext(ctx: OpenClawPluginToolContext) {
  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  if (!sessionKey) {
    throw new Error(
      "PIBO delegate tools require a trusted sessionKey from an active agent session.",
    );
  }
  const origin = normalizeOrigin(ctx);
  if (!origin?.channel || !origin.to) {
    throw new Error(
      "PIBO delegate tools require a trusted delivery origin from an active chat session.",
    );
  }
  return { sessionKey, origin };
}

function extractLatestAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | null | undefined;
    if (message?.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .map((entry) => {
          if (typeof entry === "string") {
            return entry.trim();
          }
          if (!entry || typeof entry !== "object") {
            return "";
          }
          return typeof (entry as { text?: unknown }).text === "string"
            ? (entry as { text: string }).text.trim()
            : typeof (entry as { content?: unknown }).content === "string"
              ? ((entry as { content: string }).content ?? "").trim()
              : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

const DelegateStartSchema = Type.Object(
  {
    agentId: Type.String({ description: "Target agent id, e.g. langgraph" }),
    task: Type.String({ description: "Delegated task specification" }),
    label: Type.Optional(Type.String({ description: "Optional delegate label" })),
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const DelegateContinueSchema = Type.Object(
  {
    delegateId: Type.String({ description: "PIBO delegate id returned by pibo_delegate_start" }),
    message: Type.String({ description: "Continuation message for the existing child session" }),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const DelegateStatusSchema = Type.Object(
  {
    delegateId: Type.String({ description: "PIBO delegate id returned by pibo_delegate_start" }),
  },
  { additionalProperties: false },
);

function createToolContextBackedSpawnTool(ctx: OpenClawPluginToolContext) {
  return createSessionsSpawnTool({
    agentSessionKey: ctx.sessionKey,
    agentChannel: ctx.deliveryContext?.channel,
    agentAccountId: ctx.deliveryContext?.accountId ?? ctx.agentAccountId,
    agentTo: ctx.deliveryContext?.to,
    agentThreadId: ctx.deliveryContext?.threadId,
    sandboxed: ctx.sandboxed,
    requesterAgentIdOverride: ctx.agentId,
    workspaceDir: ctx.workspaceDir,
  });
}

function createToolContextBackedSendTool(ctx: OpenClawPluginToolContext) {
  return createSessionsSendTool({
    agentSessionKey: ctx.sessionKey,
    agentChannel: ctx.deliveryContext?.channel,
    sandboxed: ctx.sandboxed,
    config: ctx.config,
  });
}

export function createPiboDelegateStartTool(api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
    name: "pibo_delegate_start",
    label: "PIBo Delegate Start",
    description:
      "Start a PIBO-controlled delegate run with fixed topic-bound delivery semantics and persist the delegate relationship.",
    parameters: DelegateStartSchema,
    async execute(_toolCallId, params) {
      try {
        const { sessionKey, origin } = requireTrustedSessionContext(ctx);
        const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
        const task = typeof params.task === "string" ? params.task.trim() : "";
        const label = typeof params.label === "string" ? params.label.trim() : "";
        const runTimeoutSeconds =
          typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
            ? Math.max(0, Math.floor(params.runTimeoutSeconds))
            : undefined;

        if (!agentId) {
          return json({ ok: false, error: "agentId required" });
        }
        if (!task) {
          return json({ ok: false, error: "task required" });
        }

        const spawnResult = await createToolContextBackedSpawnTool(ctx).execute(
          crypto.randomUUID(),
          {
            agentId,
            task,
            ...(label ? { label } : {}),
            thread: true,
            mode: "run",
            cleanup: "keep",
            ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
          },
        );

        const details = (spawnResult as { details?: Record<string, unknown> }).details ?? {};
        const status = typeof details.status === "string" ? details.status : "error";
        if (status !== "accepted") {
          return json({
            ok: false,
            error: typeof details.error === "string" ? details.error : "delegate spawn failed",
            result: details,
          });
        }

        const childSessionKey =
          typeof details.childSessionKey === "string" ? details.childSessionKey.trim() : "";
        if (!childSessionKey) {
          return json({
            ok: false,
            error: "delegate spawn returned no childSessionKey",
            result: details,
          });
        }

        const delegateId = crypto.randomUUID();
        const now = new Date().toISOString();
        const record: PiboDelegateRecord = {
          delegateId,
          ownerAgentId: ctx.agentId,
          ownerSessionKey: sessionKey,
          targetAgentId: agentId,
          childSessionKey,
          ...(label ? { label } : {}),
          originalTask: task,
          origin,
          createdAt: now,
          updatedAt: now,
          start: {
            ...(typeof details.runId === "string" && details.runId ? { runId: details.runId } : {}),
            status,
          },
        };

        await writePiboDelegateRecord(api.runtime.state.resolveStateDir(), record);

        return json({
          ok: true,
          delegateId,
          childSessionKey,
          targetAgentId: agentId,
          ownerSessionKey: sessionKey,
          start: record.start,
        });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

export function createPiboDelegateContinueTool(api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
    name: "pibo_delegate_continue",
    label: "PIBo Delegate Continue",
    description:
      "Continue a persisted PIBO delegate session using the stored child-session binding instead of raw sessions_send.",
    parameters: DelegateContinueSchema,
    async execute(_toolCallId, params) {
      try {
        const { sessionKey } = requireTrustedSessionContext(ctx);
        const delegateId = typeof params.delegateId === "string" ? params.delegateId.trim() : "";
        const message = typeof params.message === "string" ? params.message.trim() : "";
        const timeoutSeconds =
          typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
            ? Math.max(0, Math.floor(params.timeoutSeconds))
            : undefined;

        if (!delegateId) {
          return json({ ok: false, error: "delegateId required" });
        }
        if (!message) {
          return json({ ok: false, error: "message required" });
        }

        const stateDir = api.runtime.state.resolveStateDir();
        const record = await readPiboDelegateRecord(stateDir, delegateId);
        if (!record) {
          return json({ ok: false, error: `Delegate not found: ${delegateId}` });
        }
        if (record.ownerSessionKey !== sessionKey) {
          return json({
            ok: false,
            error:
              "Delegate belongs to a different owner session. Continue it from the original orchestration topic/session.",
          });
        }

        const sendResult = await createToolContextBackedSendTool(ctx).execute(crypto.randomUUID(), {
          sessionKey: record.childSessionKey,
          message,
          ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        });
        const details = (sendResult as { details?: Record<string, unknown> }).details ?? {};
        const status = typeof details.status === "string" ? details.status : "error";
        if (status !== "ok" && status !== "accepted" && status !== "timeout") {
          return json({
            ok: false,
            error:
              typeof details.error === "string" ? details.error : "delegate continuation failed",
            result: details,
          });
        }

        const updated: PiboDelegateRecord = {
          ...record,
          updatedAt: new Date().toISOString(),
          lastContinue: {
            ...(typeof details.runId === "string" && details.runId ? { runId: details.runId } : {}),
            status,
            message,
            updatedAt: new Date().toISOString(),
          },
        };
        await writePiboDelegateRecord(stateDir, updated);

        return json({
          ok: true,
          delegateId,
          childSessionKey: record.childSessionKey,
          status,
          ...(typeof details.reply === "string" ? { reply: details.reply } : {}),
          ...(typeof details.runId === "string" ? { runId: details.runId } : {}),
        });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

export function createPiboDelegateStatusTool(api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
    name: "pibo_delegate_status",
    label: "PIBo Delegate Status",
    description:
      "Inspect a persisted PIBO delegate record and return the latest assistant snapshot from the child session when available.",
    parameters: DelegateStatusSchema,
    async execute(_toolCallId, params) {
      try {
        const { sessionKey } = requireTrustedSessionContext(ctx);
        const delegateId = typeof params.delegateId === "string" ? params.delegateId.trim() : "";
        if (!delegateId) {
          return json({ ok: false, error: "delegateId required" });
        }

        const stateDir = api.runtime.state.resolveStateDir();
        const record = await readPiboDelegateRecord(stateDir, delegateId);
        if (!record) {
          return json({ ok: false, error: `Delegate not found: ${delegateId}` });
        }
        if (record.ownerSessionKey !== sessionKey) {
          return json({
            ok: false,
            error:
              "Delegate belongs to a different owner session. Read it from the original orchestration topic/session.",
          });
        }

        const { messages } = await api.runtime.subagent.getSessionMessages({
          sessionKey: record.childSessionKey,
          limit: 50,
        });

        return json({
          ok: true,
          delegate: record,
          latestAssistantReply: extractLatestAssistantText(messages),
        });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
