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
  const workflowHistoryMaxChars = 500_000;

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
      maxChars: workflowHistoryMaxChars,
    });
    expect(result).toEqual({
      runId: "idem-1",
      text: "DECISION: DONE\nMODULE_REASON: probe ok",
      wait: { status: "ok" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });
    expect(readLatestAssistantReplySnapshot).toHaveBeenNthCalledWith(1, {
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      limit: 100,
      maxChars: workflowHistoryMaxChars,
      callGateway: expect.any(Function),
    });
    expect(readLatestAssistantReplySnapshot).toHaveBeenNthCalledWith(2, {
      sessionKey: "agent:codex:workflow:test:orchestrator:main",
      limit: 100,
      maxChars: workflowHistoryMaxChars,
      callGateway: expect.any(Function),
      abortSignal: undefined,
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

  it("aborts the active session turn when the workflow abort signal fires", async () => {
    readLatestAssistantReplySnapshot.mockResolvedValue({});
    const abortController = new AbortController();
    agentCommand.mockImplementationOnce(async (params: { abortSignal?: AbortSignal }) => {
      abortController.abort(new Error("Abort requested by operator."));
      await new Promise<never>((_, reject) => {
        const onAbort = () => {
          const error = new Error("Abort requested by operator.");
          error.name = "AbortError";
          reject(error);
        };
        params.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (params.abortSignal?.aborted) {
          onAbort();
        }
      });
    });
    callWorkflowGatewayMethod.mockResolvedValueOnce({
      status: "aborted",
    });

    const { runWorkflowAgentOnSession } = await import("./agent-runtime.js");
    const runPromise = runWorkflowAgentOnSession({
      sessionKey: "agent:langgraph:workflow:test:worker:main",
      message: "test",
      idempotencyKey: "idem-abort",
      abortSignal: abortController.signal,
    });

    await expect(runPromise).rejects.toThrow("Abort requested by operator.");
    expect(agentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:langgraph:workflow:test:worker:main",
        runId: "idem-abort",
        abortSignal: abortController.signal,
      }),
    );
    expect(callWorkflowGatewayMethod).toHaveBeenCalledWith("sessions.abort", {
      key: "agent:langgraph:workflow:test:worker:main",
      runId: "idem-abort",
    });
  });

  it("returns long workflow replies without inheriting the 12k UI truncation default", async () => {
    const longReply = `ROUND 10\n${"A".repeat(20_000)}`;
    readLatestAssistantReplySnapshot.mockResolvedValueOnce({}).mockResolvedValueOnce({
      text: longReply,
      fingerprint: "reply-long",
    });
    callWorkflowGatewayMethod.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: longReply }] }],
    });

    const { runWorkflowAgentOnSession } = await import("./agent-runtime.js");
    const result = await runWorkflowAgentOnSession({
      sessionKey: "agent:codex:workflow:test:self-ralph:worker",
      message: "produce a full draft",
      idempotencyKey: "idem-long",
    });

    expect(result.text).toBe(longReply);
    expect(result.text).not.toContain("...(truncated)...");
    expect(result.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: longReply }] },
    ]);
    expect(callWorkflowGatewayMethod).toHaveBeenNthCalledWith(1, "chat.history", {
      sessionKey: "agent:codex:workflow:test:self-ralph:worker",
      limit: 100,
      maxChars: workflowHistoryMaxChars,
    });
    expect(readLatestAssistantReplySnapshot).toHaveBeenNthCalledWith(1, {
      sessionKey: "agent:codex:workflow:test:self-ralph:worker",
      limit: 100,
      maxChars: workflowHistoryMaxChars,
      callGateway: expect.any(Function),
    });
    expect(readLatestAssistantReplySnapshot).toHaveBeenNthCalledWith(2, {
      sessionKey: "agent:codex:workflow:test:self-ralph:worker",
      limit: 100,
      maxChars: workflowHistoryMaxChars,
      callGateway: expect.any(Function),
      abortSignal: undefined,
    });
  });
});
