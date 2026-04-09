import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureWorkflowSessions = vi.fn();
const runWorkflowAgentOnSession = vi.fn();
const writeWorkflowArtifact = vi.fn();

vi.mock("../managed-session-adapter.js", () => ({
  ensureWorkflowSessions,
}));

vi.mock("../agent-runtime.js", () => ({
  runWorkflowAgentOnSession,
}));

vi.mock("../store.js", () => ({
  writeWorkflowArtifact,
}));

describe("langgraph_worker_critic module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureWorkflowSessions.mockResolvedValue({
      worker: "agent:langgraph:pibo:workflow:run-1:worker:main",
      critic: "agent:critic:pibo:workflow:run-1:critic:main",
    });
    runWorkflowAgentOnSession
      .mockResolvedValueOnce({
        runId: "worker-run-1",
        text: "worker result",
        wait: { status: "ok" },
        messages: [],
      })
      .mockResolvedValueOnce({
        runId: "critic-run-1",
        text: "VERDICT: APPROVE\nREASON:\n- Looks good\nGAPS:\n- none\nREVISION_REQUEST:\n- none",
        wait: { status: "ok" },
        messages: [],
      });
    writeWorkflowArtifact.mockImplementation((runId: string, name: string) => `${runId}/${name}`);
  });

  it("passes optional worker/critic models into managed workflow sessions", async () => {
    const { langgraphWorkerCriticModule } = await import("./langgraph-worker-critic.js");

    await langgraphWorkerCriticModule.start(
      {
        input: {
          task: "Do the thing",
          successCriteria: ["done"],
          workerModel: "openai/gpt-5.4",
          criticModel: "anthropic/claude-sonnet-4-6",
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
      },
    );

    expect(ensureWorkflowSessions).toHaveBeenCalledWith({
      runId: "run-1",
      specs: [
        {
          role: "worker",
          agentId: "langgraph",
          label: "Workflow run-1 Worker",
          name: "main",
          model: "openai/gpt-5.4",
          policy: "reset-on-reuse",
        },
        {
          role: "critic",
          agentId: "critic",
          label: "Workflow run-1 Critic",
          name: "main",
          model: "anthropic/claude-sonnet-4-6",
          policy: "reset-on-reuse",
        },
      ],
    });
  });

  it("appends optional critic instructions to the critic prompt", async () => {
    const { langgraphWorkerCriticModule } = await import("./langgraph-worker-critic.js");

    await langgraphWorkerCriticModule.start(
      {
        input: {
          task: "Review this carefully",
          successCriteria: ["strictly reviewed"],
          criticPromptAddendum: "Be extra strict about hidden assumptions.",
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
      },
    );

    expect(runWorkflowAgentOnSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: "agent:critic:pibo:workflow:run-1:critic:main",
        message: expect.stringContaining(
          "ADDITIONAL_CRITIC_INSTRUCTIONS:\nBe extra strict about hidden assumptions.",
        ),
      }),
    );
  });
});
