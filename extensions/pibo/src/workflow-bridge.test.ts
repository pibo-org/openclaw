import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  WorkflowTraceEvent,
  WorkflowTraceEventQuery,
} from "../../../src/cli/pibo/workflows/tracing/types.js";
import type {
  WorkflowArtifactContent,
  WorkflowProgressSnapshot,
} from "../../../src/cli/pibo/workflows/types.js";

const runPiboWorkflows = vi.fn(async (_api: unknown, _args: string[]) => "");
const runtimeStart = vi.fn(async (_moduleId: string, _request: unknown) => ({}));
const runtimeStartAsync = vi.fn(async (_moduleId: string, _request: unknown) => ({}));
const runtimeWait = vi.fn(async (_runId: string, _timeoutMs?: number) => ({}));
const runtimeProgress = vi.fn(
  async (_runId: string): Promise<WorkflowProgressSnapshot> => ({}) as WorkflowProgressSnapshot,
);
const runtimeTraceEvents = vi.fn(
  async (_runId: string, _query?: WorkflowTraceEventQuery): Promise<WorkflowTraceEvent[]> => [],
);
const runtimeReadArtifact = vi.fn(
  async (
    _runId: string,
    _name: string,
    _opts?: { headLines?: number; tailLines?: number },
  ): Promise<WorkflowArtifactContent> => ({}) as WorkflowArtifactContent,
);

vi.mock("./workflow-runtime.js", () => ({
  runPiboWorkflows,
}));

describe("pibo workflow bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    runPiboWorkflows.mockClear();
    runtimeStart.mockClear();
    runtimeStartAsync.mockClear();
    runtimeWait.mockClear();
    runtimeProgress.mockClear();
    runtimeTraceEvents.mockClear();
    runtimeReadArtifact.mockClear();
  });

  it("routes /pibo workflows list through the generic pibo-cli workflow bridge", async () => {
    runPiboWorkflows.mockResolvedValueOnce("workflow list output");
    const { handlePiboCommand } = await import("./router.js");

    const text = await handlePiboCommand(
      { logger: { info() {}, warn() {}, error() {}, debug() {} } } as never,
      { args: "workflows list", channel: "telegram", senderId: "tester" } as never,
    );

    expect(text).toBe("workflow list output");
    expect(runPiboWorkflows).toHaveBeenCalledWith(expect.anything(), ["list"]);
  });

  it("exposes pibo_workflow_start as a trusted workflow start tool", async () => {
    runtimeStart.mockResolvedValueOnce({ runId: "run-1", status: "done" });
    const { createPiboWorkflowStartTool } = await import("./workflow-tools.js");

    const tool = createPiboWorkflowStartTool({
      runtime: {
        piboWorkflows: {
          start: runtimeStart,
        },
      },
    } as never)({
      sessionKey: "agent:main:telegram:topic:123",
      deliveryContext: {
        channel: "telegram",
        to: "group:123",
        accountId: "telegram-default",
        threadId: 456,
      },
      agentAccountId: "telegram-default",
    } as never);
    const result = (await tool.execute("call-1", {
      moduleId: "langgraph_worker_critic",
      input: { task: "demo", successCriteria: ["done"] },
      maxRounds: 2,
    })) as {
      details: { ok: boolean; result?: { runId?: string } };
    };

    expect(runtimeStart).toHaveBeenCalledWith("langgraph_worker_critic", {
      input: { task: "demo", successCriteria: ["done"] },
      maxRounds: 2,
      origin: {
        ownerSessionKey: "agent:main:telegram:topic:123",
        channel: "telegram",
        to: "group:123",
        accountId: "telegram-default",
        threadId: "456",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["started", "blocked", "completed"],
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.result?.runId).toBe("run-1");
  });

  it("exposes pibo_workflow_start_async as a trusted async workflow start tool", async () => {
    runtimeStartAsync.mockResolvedValueOnce({ runId: "run-async-1", status: "pending" });
    const { createPiboWorkflowStartAsyncTool } = await import("./workflow-tools.js");

    const tool = createPiboWorkflowStartAsyncTool({
      runtime: {
        piboWorkflows: {
          startAsync: runtimeStartAsync,
        },
      },
    } as never)({
      sessionKey: "agent:main:telegram:topic:123",
      deliveryContext: {
        channel: "telegram",
        to: "group:123",
        accountId: "telegram-default",
        threadId: 456,
      },
      agentAccountId: "telegram-default",
    } as never);
    const result = (await tool.execute("call-async-1", {
      moduleId: "langgraph_worker_critic",
      input: { task: "demo", successCriteria: ["done"] },
      maxRounds: 2,
    })) as {
      details: { ok: boolean; result?: { runId?: string } };
    };

    expect(runtimeStartAsync).toHaveBeenCalledWith("langgraph_worker_critic", {
      input: { task: "demo", successCriteria: ["done"] },
      maxRounds: 2,
      origin: {
        ownerSessionKey: "agent:main:telegram:topic:123",
        channel: "telegram",
        to: "group:123",
        accountId: "telegram-default",
        threadId: "456",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["started", "blocked", "completed"],
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.result?.runId).toBe("run-async-1");
  });

  it("exposes pibo_workflow_wait as a workflow wait tool", async () => {
    runtimeWait.mockResolvedValueOnce({
      status: "ok",
      run: { runId: "run-1", status: "done" },
    });
    const { createPiboWorkflowWaitTool } = await import("./workflow-tools.js");

    const tool = createPiboWorkflowWaitTool({
      runtime: {
        piboWorkflows: {
          wait: runtimeWait,
        },
      },
    } as never);
    const result = (await tool.execute("call-wait-1", {
      runId: "run-1",
      timeoutMs: 2500,
    })) as {
      details: { ok: boolean; result?: { status?: string } };
    };

    expect(runtimeWait).toHaveBeenCalledWith("run-1", 2500);
    expect(result.details.ok).toBe(true);
    expect(result.details.result?.status).toBe("ok");
  });

  it("exposes pibo_workflow_progress as a compact workflow status tool", async () => {
    runtimeProgress.mockResolvedValueOnce({
      runId: "run-1",
      moduleId: "test-workflow",
      status: "running",
      isTerminal: false,
      currentRound: 1,
      maxRounds: 3,
      traceLevel: 1,
      eventCount: 0,
      artifactCount: 0,
      startedAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      terminalReason: null,
      currentStepId: null,
      activeRole: "worker",
      lastCompletedRole: null,
      lastArtifactPath: null,
      lastArtifactName: null,
      lastEventSeq: null,
      lastEventKind: null,
      lastEventAt: null,
      lastEventSummary: null,
      sessions: {},
      humanSummary: "Run laeuft; aktive Rolle: worker.",
    });
    const { createPiboWorkflowProgressTool } = await import("./workflow-tools.js");

    const tool = createPiboWorkflowProgressTool({
      runtime: {
        piboWorkflows: {
          progress: runtimeProgress,
        },
      },
    } as never);
    const result = (await tool.execute("call-progress-1", {
      runId: "run-1",
    })) as {
      details: { ok: boolean; result?: { status?: string; humanSummary?: string } };
    };

    expect(runtimeProgress).toHaveBeenCalledWith("run-1");
    expect(result.details.ok).toBe(true);
    expect(result.details.result?.status).toBe("running");
  });

  it("exposes filtered trace events and artifact reads for workflows", async () => {
    runtimeTraceEvents.mockResolvedValueOnce([
      {
        eventId: "evt-1",
        runId: "run-1",
        moduleId: "test-workflow",
        ts: "2026-04-10T00:00:00.000Z",
        seq: 3,
        kind: "role_turn_started",
        role: "controller",
      },
    ]);
    runtimeReadArtifact.mockResolvedValueOnce({
      name: "round-1-controller.txt",
      path: "/tmp/run-1/round-1-controller.txt",
      sizeBytes: 21,
      updatedAt: "2026-04-10T00:00:00.000Z",
      mode: "full",
      totalLines: 1,
      truncated: false,
      content: "MODULE_DECISION: DONE",
    });
    const { createPiboWorkflowArtifactTool, createPiboWorkflowTraceEventsTool } =
      await import("./workflow-tools.js");

    const traceTool = createPiboWorkflowTraceEventsTool({
      runtime: {
        piboWorkflows: {
          traceEvents: runtimeTraceEvents,
        },
      },
    } as never);
    const traceResult = (await traceTool.execute("call-trace-1", {
      runId: "run-1",
      limit: 5,
      role: "controller",
    })) as {
      details: { ok: boolean; result?: { events?: Array<{ kind?: string }> } };
    };

    expect(runtimeTraceEvents).toHaveBeenCalledWith("run-1", {
      limit: 5,
      sinceSeq: undefined,
      role: "controller",
      kind: undefined,
    });
    expect(traceResult.details.result?.events?.[0]?.kind).toBe("role_turn_started");

    const artifactTool = createPiboWorkflowArtifactTool({
      runtime: {
        piboWorkflows: {
          readArtifact: runtimeReadArtifact,
        },
      },
    } as never);
    const artifactResult = (await artifactTool.execute("call-artifact-1", {
      runId: "run-1",
      name: "round-1-controller.txt",
      tailLines: 20,
    })) as {
      details: { ok: boolean; result?: { content?: string } };
    };

    expect(runtimeReadArtifact).toHaveBeenCalledWith("run-1", "round-1-controller.txt", {
      headLines: undefined,
      tailLines: 20,
    });
    expect(artifactResult.details.result?.content).toContain("MODULE_DECISION");
  });
});
