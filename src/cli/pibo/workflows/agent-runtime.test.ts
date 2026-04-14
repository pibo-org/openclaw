import { beforeEach, describe, expect, it, vi } from "vitest";

const callWorkflowGatewayMethod = vi.fn();
const agentCommand = vi.fn();
const readLatestAssistantReplySnapshot = vi.fn();

vi.mock("../../../agents/agent-command.js", () => ({
  agentCommand: (params: unknown) => agentCommand(params),
}));

vi.mock("./workflow-gateway.js", () => ({
  callWorkflowGatewayMethod: (method: string, params?: Record<string, unknown>) =>
    callWorkflowGatewayMethod(method, params),
}));

vi.mock("../../../agents/run-wait.js", () => ({
  readLatestAssistantReplySnapshot: (params: unknown) => readLatestAssistantReplySnapshot(params),
}));

describe("runWorkflowAgentOnSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the updated assistant reply via chat.history helpers", async () => {
    readLatestAssistantReplySnapshot.mockResolvedValueOnce({}).mockResolvedValueOnce({
      text: "DECISION: DONE\nMODULE_REASON: probe ok",
      fingerprint: "reply-1",
    });
    callWorkflowGatewayMethod.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });

    const { runWorkflowAgentOnSession } = await import("./agent-runtime.js");
    const result = await runWorkflowAgentOnSession({
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      message: "test",
      idempotencyKey: "idem-1",
      timeoutMs: 60_000,
    });

    expect(agentCommand).toHaveBeenCalledWith({
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      message: "test",
      deliver: false,
      suppressRuntimeOutput: true,
      runId: "idem-1",
      timeout: "60",
    });
    expect(callWorkflowGatewayMethod).toHaveBeenNthCalledWith(1, "chat.history", {
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      limit: 100,
    });
    expect(result).toEqual({
      runId: "idem-1",
      text: "DECISION: DONE\nMODULE_REASON: probe ok",
      wait: { status: "ok" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });
  });

  it("passes an explicit workspaceDir override through to agentCommand only when provided", async () => {
    readLatestAssistantReplySnapshot.mockResolvedValueOnce({}).mockResolvedValueOnce({
      text: "DECISION: DONE\nMODULE_REASON: probe ok",
      fingerprint: "reply-2",
    });
    callWorkflowGatewayMethod.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });

    const { runWorkflowAgentOnSession } = await import("./agent-runtime.js");
    await runWorkflowAgentOnSession({
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      message: "test",
      idempotencyKey: "idem-override",
      workspaceDir: "/workspace/context",
    });

    expect(agentCommand).toHaveBeenCalledWith({
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      message: "test",
      deliver: false,
      suppressRuntimeOutput: true,
      workspaceDir: "/workspace/context",
      runId: "idem-override",
    });
  });

  it("uses the global agent timeout logic when no explicit timeout override is provided", async () => {
    readLatestAssistantReplySnapshot.mockResolvedValueOnce({}).mockResolvedValueOnce({
      text: "DECISION: DONE\nMODULE_REASON: probe ok",
      fingerprint: "reply-3",
    });
    callWorkflowGatewayMethod.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });

    const { runWorkflowAgentOnSession } = await import("./agent-runtime.js");
    await runWorkflowAgentOnSession({
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      message: "test",
      idempotencyKey: "idem-global-timeout",
    });

    expect(agentCommand).toHaveBeenCalledWith({
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      message: "test",
      deliver: false,
      suppressRuntimeOutput: true,
      runId: "idem-global-timeout",
    });
    expect(agentCommand.mock.calls[0]?.[0]).not.toHaveProperty("timeout");
  });

  it("throws when no assistant output appears after the turn completes", async () => {
    readLatestAssistantReplySnapshot.mockResolvedValue({});
    callWorkflowGatewayMethod.mockResolvedValueOnce({ messages: [] });

    const { runWorkflowAgentOnSession } = await import("./agent-runtime.js");

    await expect(
      runWorkflowAgentOnSession({
        sessionKey: "agent:langgraph:workflow:test:orchestrator:main",
        message: "test",
        idempotencyKey: "idem-2",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      "No assistant output found in session agent:langgraph:workflow:test:orchestrator:main.",
    );
  });
});
