import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTraceRuntime } from "../tracing/runtime.js";
import type { WorkflowTraceSummary } from "../tracing/types.js";
import type { WorkflowRunRecord } from "../types.js";

const ensureWorkflowSessions = vi.fn();
const runWorkflowAgentOnSession = vi.fn();
const writeWorkflowArtifact = vi.fn();
const emitTracedWorkflowReportEvent = vi.fn(async () => ({ attempted: true, delivered: true }));
const traceEmit = vi.fn();

function createTraceMock(runId: string): WorkflowTraceRuntime {
  return {
    runId,
    moduleId: "langgraph_worker_critic",
    level: 1,
    emit: traceEmit,
    attachToRunRecord: (record: WorkflowRunRecord) => record,
    getRef: () => ({
      version: "v1",
      level: 1,
      eventLogPath: `/tmp/${runId}.trace.jsonl`,
      summaryPath: `/tmp/${runId}.trace.summary.json`,
      eventCount: 0,
      updatedAt: "2026-04-10T00:00:00.000Z",
    }),
    getSummary: () =>
      ({
        runId,
        moduleId: "langgraph_worker_critic",
        traceLevel: 1,
        eventCount: 0,
        stepCount: 0,
        roundCount: 0,
        rolesSeen: [],
        artifactCount: 0,
      }) satisfies WorkflowTraceSummary,
  };
}

vi.mock("../workflow-session-helper.js", () => ({
  ensureWorkflowSessions,
}));

vi.mock("../agent-runtime.js", () => ({
  runWorkflowAgentOnSession,
}));

vi.mock("../store.js", () => ({
  writeWorkflowArtifact,
}));

vi.mock("../workflow-reporting.js", () => ({
  emitTracedWorkflowReportEvent,
}));

describe("langgraph_worker_critic module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureWorkflowSessions.mockResolvedValue({
      worker: "agent:langgraph:workflow:run-1:worker:main",
      critic: "agent:critic:workflow:run-1:critic:main",
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
        trace: createTraceMock("run-1"),
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
        trace: createTraceMock("run-1"),
      },
    );

    expect(runWorkflowAgentOnSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: "agent:critic:workflow:run-1:critic:main",
        message: expect.stringContaining(
          "ADDITIONAL_CRITIC_INSTRUCTIONS:\nBe extra strict about hidden assumptions.",
        ),
      }),
    );
  });

  it("reports completed runs with the final worker result first", async () => {
    const { langgraphWorkerCriticModule } = await import("./langgraph-worker-critic.js");

    await langgraphWorkerCriticModule.start(
      {
        input: {
          task: "Return the final answer",
          successCriteria: ["exact answer"],
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(emitTracedWorkflowReportEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventType: "completed",
        messageText: [
          "Final result:",
          "worker result",
          "",
          "Critic verdict: APPROVE",
          "Round: 1/2",
          "",
          "Approval reason:",
          "- Looks good",
        ].join("\n"),
        emittingAgentId: "critic",
      }),
    );
    expect(traceEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "run_completed",
        status: "done",
      }),
    );
  });
});
