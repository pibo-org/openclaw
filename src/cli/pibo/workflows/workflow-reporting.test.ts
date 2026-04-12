import { beforeEach, describe, expect, it, vi } from "vitest";

const deliverOutboundPayloads = vi.fn(async () => [{ messageId: "msg-1", channel: "telegram" }]);
const resolveOutboundTarget = vi.fn(() => ({ ok: true as const, to: "-100123" }));
const resolveOutboundChannelPlugin = vi.fn(() => ({
  config: {
    listAccountIds: () => ["default", "critic"],
    resolveAccount: () => ({}),
    isConfigured: async () => true,
  },
}));

vi.mock("../../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads,
}));

vi.mock("../../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget,
}));

vi.mock("../../../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelPlugin,
}));

describe("workflow reporting", () => {
  beforeEach(() => {
    deliverOutboundPayloads.mockClear();
    resolveOutboundTarget.mockClear();
    resolveOutboundChannelPlugin.mockClear();
    resolveOutboundChannelPlugin.mockReturnValue({
      config: {
        listAccountIds: () => ["default", "critic"],
        resolveAccount: () => ({}),
        isConfigured: async () => true,
      },
    });
  });

  it("delivers a workflow report with runtime header and agent account fallback override", async () => {
    const { emitWorkflowReportEvent } = await import("./workflow-reporting.js");

    const result = await emitWorkflowReportEvent({
      cfg: { agents: { list: [] } } as never,
      moduleId: "langgraph_worker_critic",
      runId: "abcd1234-1234-1234-1234-1234567890ab",
      phase: "workflow_done",
      eventType: "completed",
      messageText: "VERDICT: APPROVE",
      emittingAgentId: "critic",
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
        accountId: "default",
        threadId: "333",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["completed"],
      },
      role: "critic",
      status: "done",
      round: 2,
      targetSessionKey: "agent:critic:workflow:run-1:critic:main",
    });

    expect(result).toMatchObject({ attempted: true, delivered: true, accountId: "critic" });
    expect(resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "group:-100123",
        accountId: "critic",
        mode: "explicit",
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "-100123",
        accountId: "critic",
        threadId: "333",
        payloads: [
          {
            text: expect.stringContaining(
              "[Workflow: langgraph_worker_critic | Phase: workflow_done | Run: abcd1234 | Round: 2 | Role: critic | Status: done]",
            ),
          },
        ],
        mirror: expect.objectContaining({
          sessionKey: "agent:critic:workflow:run-1:critic:main",
          agentId: "critic",
        }),
      }),
    );
    const firstDeliverCall = deliverOutboundPayloads.mock.calls.at(0) as unknown[] | undefined;
    const firstDeliverRequest = (firstDeliverCall?.at(0) ?? null) as unknown as {
      payloads?: Array<{ text?: string }>;
    } | null;
    expect(String(firstDeliverRequest?.payloads?.[0]?.text ?? "")).toContain("VERDICT: APPROVE");
  });

  it("falls back to origin account when emitting agent account is not configured", async () => {
    resolveOutboundChannelPlugin.mockReturnValueOnce({
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
        isConfigured: async () => true,
      },
    });
    const { emitWorkflowReportEvent } = await import("./workflow-reporting.js");

    const result = await emitWorkflowReportEvent({
      cfg: { agents: { list: [] } } as never,
      moduleId: "codex_controller",
      runId: "run-2",
      phase: "workflow_done",
      eventType: "completed",
      messageText: "Controller approved completion.",
      emittingAgentId: "langgraph",
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
        accountId: "default",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["completed"],
      },
    });

    expect(result).toMatchObject({ attempted: true, delivered: true, accountId: "default" });
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("skips disabled events without attempting delivery", async () => {
    const { emitWorkflowReportEvent } = await import("./workflow-reporting.js");

    const result = await emitWorkflowReportEvent({
      cfg: { agents: { list: [] } } as never,
      moduleId: "noop",
      runId: "run-3",
      phase: "run_started",
      eventType: "started",
      messageText: "Started.",
      emittingAgentId: "main",
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["completed"],
      },
    });

    expect(result).toEqual({
      attempted: false,
      delivered: false,
      skipped: "event-disabled",
    });
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
