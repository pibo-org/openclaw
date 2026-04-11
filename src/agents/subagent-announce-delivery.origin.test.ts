import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDestinationMock = vi.fn();
const hasHooksMock = vi.fn();
const runSubagentDeliveryTargetMock = vi.fn();

vi.mock("./subagent-announce-delivery.runtime.js", () => ({
  callGateway: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  resolveQueueSettings: vi.fn(() => ({ mode: "none" })),
  resolveExternalBestEffortDeliveryTarget: vi.fn(),
  resolveConversationIdFromTargets: vi.fn(() => ""),
  isEmbeddedPiRunActive: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  createBoundDeliveryRouter: () => ({
    resolveDestination: resolveDestinationMock,
  }),
  getGlobalHookRunner: () => ({
    hasHooks: hasHooksMock,
    runSubagentDeliveryTarget: runSubagentDeliveryTargetMock,
  }),
}));

import { resolveSubagentCompletionOrigin } from "./subagent-announce-delivery.js";

describe("resolveSubagentCompletionOrigin", () => {
  beforeEach(() => {
    resolveDestinationMock.mockReset().mockReturnValue({
      mode: "bound",
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "1609",
          parentConversationId: "-1003736645971",
        },
      },
    });
    hasHooksMock.mockReset().mockReturnValue(true);
    runSubagentDeliveryTargetMock.mockReset().mockResolvedValue({
      origin: {
        channel: "telegram",
        accountId: "langgraph",
      },
    });
  });

  it("lets channel completion hooks override the bound delivery account", async () => {
    const origin = await resolveSubagentCompletionOrigin({
      childSessionKey: "agent:langgraph:subagent:child",
      requesterSessionKey: "agent:main:telegram:group:-1003736645971:topic:1609",
      requesterOrigin: {
        channel: "telegram",
        accountId: "default",
        to: "telegram:-1003736645971",
        threadId: "1609",
      },
      childRunId: "run-1",
      spawnMode: "run",
      expectsCompletionMessage: true,
    });

    expect(origin).toEqual({
      channel: "telegram",
      accountId: "langgraph",
      to: "channel:1609",
      threadId: "1609",
    });
  });

  it("falls back to the bound origin when the hook returns nothing", async () => {
    runSubagentDeliveryTargetMock.mockResolvedValue(undefined);

    const origin = await resolveSubagentCompletionOrigin({
      childSessionKey: "agent:langgraph:subagent:child",
      requesterSessionKey: "agent:main:telegram:group:-1003736645971:topic:1609",
      requesterOrigin: {
        channel: "telegram",
        accountId: "default",
        to: "telegram:-1003736645971",
        threadId: "1609",
      },
      childRunId: "run-1",
      spawnMode: "run",
      expectsCompletionMessage: true,
    });

    expect(origin).toEqual({
      channel: "telegram",
      accountId: "default",
      to: "channel:1609",
      threadId: "1609",
    });
  });
});
