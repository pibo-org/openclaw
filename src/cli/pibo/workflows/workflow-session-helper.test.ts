import { beforeEach, describe, expect, it, vi } from "vitest";

const loadSessionEntry = vi.fn();
const callWorkflowGatewayMethod = vi.fn();

vi.mock("../../../gateway/session-utils.js", () => ({
  loadSessionEntry,
}));

vi.mock("./workflow-gateway.js", () => ({
  callWorkflowGatewayMethod,
}));

describe("workflow session helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSessionEntry.mockReturnValue({ entry: undefined });
    callWorkflowGatewayMethod.mockResolvedValue({ ok: true });
  });

  it("builds native workflow session keys without the legacy pibo segment", async () => {
    const { buildAcpWorkflowSessionKey, buildWorkflowSessionKey } =
      await import("./workflow-session-helper.js");

    expect(
      buildWorkflowSessionKey({
        agentId: "LangGraph",
        runId: "Run-1",
        role: "worker",
        name: "main",
      }),
    ).toBe("agent:langgraph:workflow:run-1:worker:main");
    expect(
      buildAcpWorkflowSessionKey({
        agentId: "Codex",
        runId: "Run-1",
        role: "worker",
        name: "codex",
      }),
    ).toBe("agent:codex:acp:workflow:run-1:worker:codex");
  });

  it("creates deterministic workflow sessions through native session primitives", async () => {
    const { ensureWorkflowSessions } = await import("./workflow-session-helper.js");

    const sessions = await ensureWorkflowSessions({
      runId: "run-1",
      specs: [
        {
          role: "worker",
          agentId: "langgraph",
          label: "Workflow run-1 Worker",
          name: "main",
          policy: "reset-on-reuse",
        },
        {
          role: "critic",
          agentId: "critic",
          label: "Workflow run-1 Critic",
          name: "main",
          policy: "reset-on-reuse",
        },
      ],
    });

    expect(sessions).toEqual({
      worker: "agent:langgraph:workflow:run-1:worker:main",
      critic: "agent:critic:workflow:run-1:critic:main",
    });
    expect(callWorkflowGatewayMethod).toHaveBeenNthCalledWith(1, "sessions.create", {
      key: "agent:langgraph:workflow:run-1:worker:main",
      agentId: "langgraph",
      label: "Workflow run-1 Worker",
    });
    expect(callWorkflowGatewayMethod).toHaveBeenNthCalledWith(2, "sessions.create", {
      key: "agent:critic:workflow:run-1:critic:main",
      agentId: "critic",
      label: "Workflow run-1 Critic",
    });
  });

  it("resets an existing workflow session when policy is reset-on-reuse", async () => {
    loadSessionEntry.mockReturnValue({
      entry: { sessionId: "session-1" },
    });
    const { ensureWorkflowSessions } = await import("./workflow-session-helper.js");

    const sessions = await ensureWorkflowSessions({
      runId: "run-1",
      specs: [
        {
          role: "worker",
          agentId: "langgraph",
          label: "Workflow run-1 Worker",
          name: "main",
          policy: "reset-on-reuse",
        },
      ],
    });

    expect(sessions).toEqual({
      worker: "agent:langgraph:workflow:run-1:worker:main",
    });
    expect(callWorkflowGatewayMethod).toHaveBeenCalledTimes(1);
    expect(callWorkflowGatewayMethod).toHaveBeenCalledWith("sessions.reset", {
      key: "agent:langgraph:workflow:run-1:worker:main",
      reason: "reset",
    });
  });
});
