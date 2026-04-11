import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { runAgentStep } from "./agent-step.js";
import { runSessionsSendA2AFlow, __testing } from "./sessions-send-tool.a2a.js";

const gatewayCallMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: CallGatewayOptions) => gatewayCallMock(opts),
}));

const loadConfigMock = vi.fn(() => ({
  bindings: [{ agentId: "langgraph", match: { channel: "telegram", accountId: "langgraph" } }],
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
}));

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    loadConfigMock.mockClear();
    vi.mocked(runAgentStep).mockClear();
    gatewayCallMock.mockReset();
    gatewayCallMock.mockImplementation(
      async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        if (opts.method === "sessions.list") {
          return {
            sessions: [
              {
                key: "agent:langgraph:subagent:abc123",
                deliveryContext: {
                  channel: "telegram",
                  to: "-100123",
                  accountId: "default",
                },
              },
            ],
          } as T;
        }
        return {} as T;
      },
    );
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) =>
        gatewayCallMock(opts) as Promise<T>,
    });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    // Find the gateway send call (not the waitForAgentRun call)
    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });

  it("uses the bound Telegram agent account for internal target sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:langgraph:subagent:abc123",
      displayKey: "agent:langgraph:subagent:abc123",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.accountId).toBe("langgraph");
    expect(sendParams.message).toBe("Worker completed successfully");
    expect(runAgentStep).not.toHaveBeenCalled();
  });

  it("does not run announce-step ping-pong for internal subagent sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:langgraph:subagent:abc123",
      displayKey: "agent:langgraph:subagent:abc123",
      message: "Test continuation",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Visible child reply",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.message).toBe("Visible child reply");
    expect(sendParams.accountId).toBe("langgraph");
    expect(runAgentStep).not.toHaveBeenCalled();
  });

  it("reconstructs Telegram topic announce targets from groupId when the child session has no explicit to", async () => {
    gatewayCallMock.mockImplementation(
      async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        if (opts.method === "sessions.list") {
          return {
            sessions: [
              {
                key: "agent:langgraph:subagent:abc123",
                deliveryContext: {
                  channel: "telegram",
                },
                groupId: "-100123:topic:554",
                spawnedBy: "agent:main:telegram:group:-100123:topic:554",
                lastAccountId: "default",
              },
            ],
          } as T;
        }
        return {} as T;
      },
    );

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:langgraph:subagent:abc123",
      displayKey: "agent:langgraph:subagent:abc123",
      message: "Continuation",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Visible child reply",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.threadId).toBe("554");
    expect(sendParams.accountId).toBe("langgraph");
    expect(sendParams.message).toBe("Visible child reply");
    expect(runAgentStep).not.toHaveBeenCalled();
  });

  it("fills missing Telegram topic threadId from groupId even when the child session already has a chat target", async () => {
    gatewayCallMock.mockImplementation(
      async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        if (opts.method === "sessions.list") {
          return {
            sessions: [
              {
                key: "agent:langgraph:subagent:abc123",
                deliveryContext: {
                  channel: "telegram",
                  to: "-100123",
                  accountId: "default",
                },
                groupId: "-100123:topic:554",
                spawnedBy: "agent:main:telegram:group:-100123:topic:554",
                lastAccountId: "default",
              },
            ],
          } as T;
        }
        return {} as T;
      },
    );

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:langgraph:subagent:abc123",
      displayKey: "agent:langgraph:subagent:abc123",
      message: "Continuation",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Visible child reply",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.threadId).toBe("554");
    expect(sendParams.accountId).toBe("langgraph");
    expect(sendParams.message).toBe("Visible child reply");
    expect(runAgentStep).not.toHaveBeenCalled();
  });

  it("normalizes raw Telegram group fallback targets derived from spawnedBy when groupId is missing", async () => {
    gatewayCallMock.mockImplementation(
      async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        if (opts.method === "sessions.list") {
          return {
            sessions: [
              {
                key: "agent:langgraph:subagent:abc123",
                deliveryContext: {
                  channel: "telegram",
                },
                spawnedBy: "agent:main:telegram:group:-100123:topic:554",
                lastAccountId: "default",
              },
            ],
          } as T;
        }
        return {} as T;
      },
    );

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:langgraph:subagent:abc123",
      displayKey: "agent:langgraph:subagent:abc123",
      message: "Continuation",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Visible child reply",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.threadId).toBe("554");
    expect(sendParams.accountId).toBe("langgraph");
    expect(sendParams.message).toBe("Visible child reply");
    expect(runAgentStep).not.toHaveBeenCalled();
  });

  it("still uses the announce-step flow for non-agent session keys", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "discord:group:target",
      displayKey: "discord:group:target",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
      requesterSessionKey: "discord:group:req",
      requesterChannel: "discord",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.message).toBe("Test announce reply");
    expect(runAgentStep).toHaveBeenCalledOnce();
  });
});
