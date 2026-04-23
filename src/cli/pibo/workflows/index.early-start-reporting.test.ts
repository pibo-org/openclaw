import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  spawn,
  emitTracedWorkflowReportEvent,
  ensureWorkflowSessions,
  runWorkflowAgentOnSession,
  resolveCodexWorkerDefaultOptions,
  createCodexSdkWorkerRuntime,
  workerRunTurn,
  workerCompactThread,
  workerPrepareForRetry,
  workerGetThreadId,
  workerGetTracePath,
  initializeSession,
  updateSessionRuntimeOptions,
  runTurn,
  closeSession,
  cancelSession,
  loadConfig,
  ensureCliPluginRegistryLoaded,
  getActivePluginRegistry,
  startPluginServices,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  existsSync,
  readFileSync,
} = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  emitTracedWorkflowReportEvent: vi.fn(
    async (params: {
      trace?: { emit: (event: unknown) => void };
      stepId?: string;
      round?: number;
      role?: string;
      status?: string;
      traceSummary?: string;
      eventType: string;
      phase: string;
      origin?: { channel?: string; to?: string; accountId?: string };
    }) => {
      params.trace?.emit({
        kind: "report_delivery_attempted",
        stepId: params.stepId,
        round: params.round,
        role: params.role,
        status: params.status,
        summary:
          params.traceSummary ?? `report ${params.eventType} for phase ${params.phase} attempted`,
        payload: {
          eventType: params.eventType,
          phase: params.phase,
          channel: params.origin?.channel,
          to: params.origin?.to,
          accountId: params.origin?.accountId,
        },
      });
      params.trace?.emit({
        kind: "report_delivered",
        stepId: params.stepId,
        round: params.round,
        role: params.role,
        status: params.status,
        summary: params.traceSummary ?? `report ${params.eventType} delivered`,
        payload: {
          eventType: params.eventType,
          phase: params.phase,
          attempted: true,
          delivered: true,
          channel: params.origin?.channel,
          to: params.origin?.to,
          accountId: params.origin?.accountId,
        },
      });
      return {
        attempted: true,
        delivered: true,
      };
    },
  ),
  ensureWorkflowSessions: vi.fn(),
  runWorkflowAgentOnSession: vi.fn(),
  resolveCodexWorkerDefaultOptions: vi.fn(() => ({})),
  createCodexSdkWorkerRuntime: vi.fn(),
  workerRunTurn: vi.fn(),
  workerCompactThread: vi.fn(),
  workerPrepareForRetry: vi.fn(
    () => "Codex SDK will resume thread thread-1 with a fresh CLI exec process on retry.",
  ),
  workerGetThreadId: vi.fn(() => "thread-1"),
  workerGetTracePath: vi.fn(() => "/home/pibo/.codex/sessions/2026/04/17/thread-1.jsonl"),
  initializeSession: vi.fn(),
  updateSessionRuntimeOptions: vi.fn(),
  runTurn: vi.fn(),
  closeSession: vi.fn(),
  cancelSession: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  ensureCliPluginRegistryLoaded: vi.fn(async () => {}),
  getActivePluginRegistry: vi.fn(() => ({ services: [] })),
  startPluginServices: vi.fn(async () => ({ stop: async () => {} })),
  getAcpRuntimeBackend: vi.fn(),
  requireAcpRuntimeBackend: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync,
    readFileSync,
  };
});

vi.mock("./workflow-reporting.js", () => ({
  emitTracedWorkflowReportEvent,
}));

vi.mock("./workflow-session-helper.js", () => ({
  ensureWorkflowSessions,
  buildAcpWorkflowSessionKey: (params: {
    agentId: string;
    runId: string;
    role: string;
    name?: string;
  }) =>
    `agent:${params.agentId}:acp:workflow:${params.runId}:${params.role}:${params.name ?? "main"}`,
}));

vi.mock("./agent-runtime.js", () => ({
  runWorkflowAgentOnSession,
}));

vi.mock("./modules/codex-sdk-runtime.js", () => ({
  resolveCodexWorkerDefaultOptions,
  createCodexSdkWorkerRuntime,
}));

vi.mock("../../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded,
}));

vi.mock("../../../plugins/runtime.js", () => ({
  getActivePluginRegistry,
}));

vi.mock("../../../plugins/services.js", () => ({
  startPluginServices,
}));

vi.mock("../../../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
}));

vi.mock("../../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    initializeSession,
    updateSessionRuntimeOptions,
    runTurn,
    closeSession,
    cancelSession,
  }),
}));

import {
  getWorkflowTraceEvents,
  getWorkflowRunStatus,
  runPendingWorkflowRun,
  startWorkflowRun,
  startWorkflowRunAsync,
  waitForWorkflowRun,
} from "./index.js";

type WorkflowReportEventCall = {
  eventType?: string;
};

type FailureWorkflowReportCall = WorkflowReportEventCall & {
  runId?: string;
  moduleId?: string;
  phase?: string;
  status?: string;
  messageText?: string;
  reporting?: { events?: string[] };
};

function controllerRun(text: string, runId = "controller-run") {
  return {
    runId,
    text,
    wait: { status: "ok" as const },
    messages: [],
  };
}

function controllerInitReady(runId = "controller-init") {
  return controllerRun("CONTROLLER_READY", runId);
}

describe("workflow early-start reporting", () => {
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pibo-early-start-"));
    process.env.HOME = tempHome;
    existsSync.mockImplementation(
      (filePath: string) => !String(filePath).endsWith("codex-controller-run-contract.json"),
    );
    readFileSync.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith("codex-controller-run-contract.json")) {
        throw new Error("run contract should not be read in this fresh-run test setup");
      }
      return "controller prompt template";
    });
    ensureWorkflowSessions.mockResolvedValue({
      orchestrator: "agent:langgraph:workflow:run-1:orchestrator:main",
    });
    runWorkflowAgentOnSession.mockResolvedValue(controllerInitReady());
    resolveCodexWorkerDefaultOptions.mockImplementation(
      (params?: { model?: string; reasoningEffort?: string }) => ({
        model: params?.model,
        reasoningEffort: params?.reasoningEffort,
      }),
    );
    workerRunTurn.mockResolvedValue({
      text: "codex worker result",
      threadId: "thread-1",
      usage: null,
      eventSummaries: ["turn.started", "turn.completed"],
      tracePath: "/home/pibo/.codex/sessions/2026/04/17/thread-1.jsonl",
    });
    workerCompactThread.mockResolvedValue(null);
    createCodexSdkWorkerRuntime.mockImplementation(() => ({
      runTurn: workerRunTurn,
      compactThread: workerCompactThread,
      prepareForRetry: workerPrepareForRetry,
      getThreadId: workerGetThreadId,
      getTracePath: workerGetTracePath,
    }));
    initializeSession.mockResolvedValue(undefined);
    updateSessionRuntimeOptions.mockResolvedValue({
      cwd: "/repo",
      timeoutSeconds: 300,
    });
    runTurn.mockImplementation(
      async (params: { text?: string; onEvent?: (event: unknown) => void }) => {
        if (typeof params.text === "string" && params.text.startsWith("/compact")) {
          return;
        }
        params.onEvent?.({
          type: "text_delta",
          stream: "output",
          text: "codex worker result",
        });
      },
    );
    closeSession.mockResolvedValue({
      runtimeClosed: true,
      metaCleared: false,
    });
    cancelSession.mockResolvedValue(undefined);
    loadConfig.mockReturnValue({});
    ensureCliPluginRegistryLoaded.mockResolvedValue(undefined);
    getActivePluginRegistry.mockReturnValue({ services: [] });
    startPluginServices.mockResolvedValue({ stop: async () => {} });
    const backend = {
      id: "acpx",
      runtime: {
        probeAvailability: vi.fn(async () => {}),
      },
      healthy: () => true,
    };
    getAcpRuntimeBackend.mockReturnValue(backend);
    requireAcpRuntimeBackend.mockReturnValue(backend);
    const mod = await import("./modules/codex-controller.js");
    (
      mod.__testing as {
        resetCliPluginServicesHandleForTests?: () => void;
      }
    ).resetCliPluginServicesHandleForTests?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps the normal noop started/completed reporting path unchanged", async () => {
    const record = await startWorkflowRun("noop", {
      input: { prompt: "demo" },
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
        accountId: "telegram-default",
        threadId: "333",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["started", "completed"],
      },
    });

    expect(record.status).toBe("done");
    expect(emitTracedWorkflowReportEvent).toHaveBeenCalledTimes(2);
    const reportCalls = emitTracedWorkflowReportEvent.mock.calls as unknown as Array<[unknown]>;
    expect(reportCalls.map(([call]) => (call as WorkflowReportEventCall).eventType)).toEqual([
      "started",
      "completed",
    ]);
  });

  it("preserves the synchronous start failure behavior when no run record exists yet", async () => {
    await expect(
      startWorkflowRun("codex_controller", {
        input: {
          task: "Ship the fix",
          repoPath: "/repo",
        },
        origin: {
          ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
          channel: "telegram",
          to: "group:-100123",
          accountId: "telegram-default",
          threadId: "333",
        },
        reporting: {
          deliveryMode: "topic_origin",
          senderPolicy: "emitting_agent",
          headerMode: "runtime_header",
          events: ["started", "completed"],
        },
      }),
    ).rejects.toThrow(
      "codex_controller benötigt `input.workingDirectory`. Falls `repoPath` übergeben wurde, bitte in `workingDirectory` umbenennen.",
    );

    expect(emitTracedWorkflowReportEvent).not.toHaveBeenCalled();
  });

  it("announces early codex_controller start failures visibly without a duplicate started report", async () => {
    const initial = await startWorkflowRunAsync("codex_controller", {
      input: {
        task: "Ship the fix",
        repoPath: "/repo",
      },
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
        accountId: "telegram-default",
        threadId: "333",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["started", "completed"],
      },
    });

    await runPendingWorkflowRun(initial.runId);

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("failed");

    expect(emitTracedWorkflowReportEvent).toHaveBeenCalledTimes(1);
    const reportCalls = emitTracedWorkflowReportEvent.mock.calls as unknown as Array<[unknown]>;
    const failureReport = reportCalls[0]?.[0] as FailureWorkflowReportCall | undefined;
    expect(failureReport).toMatchObject({
      runId: initial.runId,
      moduleId: "codex_controller",
      phase: "run_start_failed",
      eventType: "blocked",
      status: "failed",
      reporting: {
        events: expect.arrayContaining(["started", "completed", "blocked"]),
      },
    });
    expect(failureReport?.messageText).toContain(
      "Workflow start failed before the regular workflow start/reporting path began.",
    );
    expect(failureReport?.messageText).toContain("Module: codex_controller");
    expect(failureReport?.messageText).toContain(`Run: ${initial.runId}`);
    expect(failureReport?.messageText).toContain(
      "codex_controller benötigt `input.workingDirectory`",
    );
    expect(
      reportCalls.some(([call]) => (call as WorkflowReportEventCall).eventType === "started"),
    ).toBe(false);
    expect(
      getWorkflowTraceEvents(initial.runId, { kind: "report_delivery_attempted" }).map((event) => {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as { phase?: unknown })
            : null;
        return payload?.phase;
      }),
    ).toEqual(["run_start_failed"]);

    expect(getWorkflowRunStatus(initial.runId).status).toBe("failed");
  });

  it("announces post-start codex_controller worker failures visibly without duplicating the started report", async () => {
    runWorkflowAgentOnSession.mockResolvedValueOnce(controllerInitReady());
    workerRunTurn.mockRejectedValueOnce(
      new Error("Codex worker disconnected before completion. reason: connection_close."),
    );

    const initial = await startWorkflowRunAsync("codex_controller", {
      input: {
        task: "Ship the fix",
        workingDirectory: "/repo",
      },
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
        accountId: "telegram-default",
        threadId: "333",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["started", "completed"],
      },
    });

    await runPendingWorkflowRun(initial.runId);

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("failed");
    expect(wait.run?.terminalReason).toContain("Codex worker turn failed in round 1/10 on session");

    expect(emitTracedWorkflowReportEvent).toHaveBeenCalledTimes(2);
    const reportCalls = emitTracedWorkflowReportEvent.mock.calls as unknown as Array<[unknown]>;
    expect(reportCalls.map(([call]) => (call as WorkflowReportEventCall).eventType)).toEqual([
      "started",
      "blocked",
    ]);
    const failureReport = reportCalls[1]?.[0] as FailureWorkflowReportCall | undefined;
    expect(failureReport).toMatchObject({
      runId: initial.runId,
      moduleId: "codex_controller",
      phase: "workflow_failed",
      eventType: "blocked",
      status: "failed",
      reporting: {
        events: expect.arrayContaining(["started", "completed", "blocked"]),
      },
    });
    expect(failureReport?.messageText).toContain(
      "Workflow failed after the regular start/reporting path and has reached terminal failure state.",
    );
    expect(failureReport?.messageText).toContain(`Run: ${initial.runId}`);
    expect(failureReport?.messageText).toContain(
      "Codex worker disconnected before completion. reason: connection_close.",
    );
    expect(
      reportCalls.filter(([call]) => (call as WorkflowReportEventCall).eventType === "started"),
    ).toHaveLength(1);
    expect(
      reportCalls.filter(([call]) => (call as WorkflowReportEventCall).eventType === "blocked"),
    ).toHaveLength(1);
    expect(
      getWorkflowTraceEvents(initial.runId, { kind: "report_delivery_attempted" }).map((event) => {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as { phase?: unknown })
            : null;
        return payload?.phase;
      }),
    ).toEqual(["run_started", "workflow_failed"]);

    expect(getWorkflowRunStatus(initial.runId).status).toBe("failed");
  });
});
