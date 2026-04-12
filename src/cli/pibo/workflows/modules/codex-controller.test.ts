import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTraceRuntime } from "../tracing/runtime.js";
import type { WorkflowTraceSummary } from "../tracing/types.js";
import type { WorkflowRunRecord } from "../types.js";

const ensureWorkflowSessions = vi.fn();
const runWorkflowAgentOnSession = vi.fn();
const writeWorkflowArtifact = vi.fn();
const existsSync = vi.fn();
const readFileSync = vi.fn();
const initializeSession = vi.fn();
const runTurn = vi.fn();
const loadConfig = vi.fn(() => ({ ok: true }));
const ensureCliPluginRegistryLoaded = vi.fn(async () => {});
const getActivePluginRegistry = vi.fn(() => ({ services: [] }));
const startPluginServices = vi.fn(async () => ({ stop: async () => {} }));
const getAcpRuntimeBackend = vi.fn();
const requireAcpRuntimeBackend = vi.fn();
const emitTracedWorkflowReportEvent = vi.fn(async () => ({
  attempted: true,
  delivered: true,
}));
const traceEmit = vi.fn();

function createTraceMock(runId: string): WorkflowTraceRuntime {
  return {
    runId,
    moduleId: "codex_controller",
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
        moduleId: "codex_controller",
        traceLevel: 1,
        eventCount: 0,
        stepCount: 0,
        roundCount: 0,
        rolesSeen: [],
        artifactCount: 0,
      }) satisfies WorkflowTraceSummary,
  };
}

vi.mock("node:fs", () => ({
  existsSync,
  readFileSync,
}));

vi.mock("../workflow-session-helper.js", () => ({
  ensureWorkflowSessions,
  buildAcpWorkflowSessionKey: (params: {
    agentId: string;
    runId: string;
    role: string;
    name?: string;
  }) =>
    `agent:${params.agentId}:acp:workflow:${params.runId}:${params.role}:${params.name ?? "main"}`,
}));

vi.mock("../agent-runtime.js", () => ({
  runWorkflowAgentOnSession,
}));

vi.mock("../store.js", () => ({
  writeWorkflowArtifact,
}));

vi.mock("../../../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../../../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded,
}));

vi.mock("../../../../plugins/runtime.js", () => ({
  getActivePluginRegistry,
}));

vi.mock("../../../../plugins/services.js", () => ({
  startPluginServices,
}));

vi.mock("../../../../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
}));

vi.mock("../../../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    initializeSession,
    runTurn,
  }),
}));

vi.mock("../workflow-reporting.js", () => ({
  emitTracedWorkflowReportEvent,
}));

describe("codex_controller module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("controller prompt template");
    ensureWorkflowSessions.mockResolvedValue({
      orchestrator: "agent:langgraph:workflow:run-1:orchestrator:main",
    });
    const backend = {
      id: "acpx",
      runtime: {
        probeAvailability: vi.fn(async () => {}),
      },
      healthy: () => true,
    };
    getAcpRuntimeBackend.mockReturnValue(backend);
    requireAcpRuntimeBackend.mockReturnValue(backend);
    writeWorkflowArtifact.mockImplementation((runId: string, name: string) => `${runId}/${name}`);
    initializeSession.mockResolvedValue(undefined);
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
  });

  it("is registered in the native workflow runtime manifest list", async () => {
    const { listWorkflowModuleManifests, describeWorkflowModule } = await import("../index.js");

    const moduleIds = listWorkflowModuleManifests().map((entry) => entry.moduleId);
    expect(moduleIds).toContain("codex_controller");

    const manifest = describeWorkflowModule("codex_controller");
    expect(manifest.moduleId).toBe("codex_controller");
    expect(manifest.description).toContain("Codex");
    expect(manifest.requiredAgents).toEqual(["codex", "langgraph"]);
  });

  it("maps normalized controller DONE output to a done terminal state", async () => {
    runWorkflowAgentOnSession.mockResolvedValueOnce({
      runId: "controller-run-1",
      text: [
        "MODULE_DECISION: DONE",
        "MODULE_REASON:",
        "- Requested implementation is complete and verified.",
        "NEXT_INSTRUCTION:",
        "- none",
        "BLOCKER:",
        "- none",
      ].join("\n"),
      wait: { status: "ok" },
      messages: [],
    });

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(record.status).toBe("done");
    expect(record.terminalReason).toContain("complete and verified");
    expect(record.sessions.worker).toBe("agent:codex:acp:workflow:run-1:worker:codex");
    expect(record.sessions.orchestrator).toBe("agent:langgraph:workflow:run-1:orchestrator:main");
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("FINISH_QUALITY:"),
      }),
    );
    expect(ensureCliPluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "all",
    });
    expect(startPluginServices).toHaveBeenCalledTimes(1);
    expect(emitTracedWorkflowReportEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventType: "completed",
        messageText: [
          "Final result:",
          "codex worker result",
          "",
          "Controller approved completion.",
          "Round: 1/6",
          "",
          "Reason:",
          "- Requested implementation is complete and verified.",
        ].join("\n"),
      }),
    );
    expect(traceEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "run_completed",
        status: "done",
      }),
    );
  });

  it("maps legacy ASK_USER controller output to blocked without silent format break", async () => {
    runWorkflowAgentOnSession.mockResolvedValueOnce({
      runId: "controller-run-1",
      text: [
        "DECISION: ASK_USER",
        "RATIONALE:",
        "- A real product choice is required.",
        "CONTROLLER_MESSAGE:",
        "- Please choose between architecture A and B before I continue.",
        "CONFIDENCE: high",
      ].join("\n"),
      wait: { status: "ok" },
      messages: [],
    });

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(record.status).toBe("blocked");
    expect(record.terminalReason).toContain("product choice");
    expect(record.terminalReason).toContain("architecture A and B");
  });

  it("keeps manual ACP compaction off by default", async () => {
    runWorkflowAgentOnSession
      .mockResolvedValueOnce({
        runId: "controller-run-1",
        text: [
          "DECISION: GUIDE",
          "RATIONALE:",
          "- Continue with tighter verification.",
          "CONTROLLER_MESSAGE:",
          "- Proceed with the implementation, then verify end-to-end.",
          "CONFIDENCE: high",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      })
      .mockResolvedValueOnce({
        runId: "controller-run-2",
        text: [
          "MODULE_DECISION: DONE",
          "MODULE_REASON:",
          "- Task is complete.",
          "NEXT_INSTRUCTION:",
          "- none",
          "BLOCKER:",
          "- none",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      });

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workerCompactionAfterRound: 2,
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(record.status).toBe("done");
    const compactCalls = runTurn.mock.calls.filter(
      ([params]: Array<{ text?: string }>) =>
        typeof params.text === "string" && params.text.startsWith("/compact"),
    );
    expect(compactCalls).toHaveLength(0);
    expect(startPluginServices).toHaveBeenCalledTimes(1);
  });

  it("continues on legacy GUIDE output and triggers ACP compaction only after the configured round when explicitly enabled", async () => {
    runWorkflowAgentOnSession
      .mockResolvedValueOnce({
        runId: "controller-run-1",
        text: [
          "DECISION: GUIDE",
          "RATIONALE:",
          "- Continue with tighter verification.",
          "CONTROLLER_MESSAGE:",
          "- Proceed with the implementation, then verify end-to-end.",
          "CONFIDENCE: high",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      })
      .mockResolvedValueOnce({
        runId: "controller-run-2",
        text: [
          "MODULE_DECISION: DONE",
          "MODULE_REASON:",
          "- Task is complete.",
          "NEXT_INSTRUCTION:",
          "- none",
          "BLOCKER:",
          "- none",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      });

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workerCompactionMode: "acp_control_command",
          workerCompactionAfterRound: 2,
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(record.status).toBe("done");
    const compactCalls = runTurn.mock.calls.filter(
      ([params]: Array<{ text?: string }>) =>
        typeof params.text === "string" && params.text.startsWith("/compact"),
    );
    expect(compactCalls).toHaveLength(1);
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:codex:acp:workflow:run-1:worker:codex",
        mode: "prompt",
      }),
    );
    expect(startPluginServices).toHaveBeenCalledTimes(1);
  });

  it("passes compact visible history, controller history, and drift signals into round-2 controller input", async () => {
    runTurn.mockImplementationOnce(
      async (params: { text?: string; onEvent?: (event: unknown) => void }) => {
        params.onEvent?.({
          type: "text_delta",
          stream: "output",
          text: "Implemented parser changes in src/foo.ts and ran pnpm vitest.",
        });
      },
    );
    runTurn.mockImplementationOnce(
      async (params: { text?: string; onEvent?: (event: unknown) => void }) => {
        params.onEvent?.({
          type: "text_delta",
          stream: "output",
          text: "Progress update: implementation is complete. Progress update: implementation is complete.",
        });
      },
    );
    runWorkflowAgentOnSession
      .mockResolvedValueOnce({
        runId: "controller-run-1",
        text: [
          "MODULE_DECISION: CONTINUE",
          "MODULE_REASON:",
          "- First round made concrete repo changes.",
          "NEXT_INSTRUCTION:",
          "- Continue, verify the changed files, and summarize the diff.",
          "BLOCKER:",
          "- none",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      })
      .mockResolvedValueOnce({
        runId: "controller-run-2",
        text: [
          "MODULE_DECISION: DONE",
          "MODULE_REASON:",
          "- Enough context for prompt-shape verification.",
          "NEXT_INSTRUCTION:",
          "- none",
          "BLOCKER:",
          "- none",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      });

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          maxRetries: 2,
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(2);
    expect(runWorkflowAgentOnSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining("RECENT_VISIBLE_WORKER_HISTORY:"),
      }),
    );
    const secondPrompt = runWorkflowAgentOnSession.mock.calls[1][0].message as string;
    expect(secondPrompt).toContain("round 1: status=working_with_evidence");
    expect(secondPrompt).toContain("round 2: status=claims_done");
    expect(secondPrompt).toContain("CONTROLLER_HISTORY:");
    expect(secondPrompt).toContain("decision=CONTINUE");
    expect(secondPrompt).toContain("CURRENT_PROGRESS_EVIDENCE:");
    expect(secondPrompt).toContain("- none visible in worker output");
    expect(secondPrompt).toContain("CURRENT_DRIFT_SIGNALS:");
    expect(secondPrompt).toContain(
      "visible output lacks concrete implementation or verification evidence",
    );
    expect(secondPrompt).not.toContain("stream: thought");
  });

  it("rejects blind CONTINUE when drift warnings exist but next instruction is not corrective", async () => {
    runTurn.mockImplementationOnce(
      async (params: { text?: string; onEvent?: (event: unknown) => void }) => {
        params.onEvent?.({
          type: "text_delta",
          stream: "output",
          text: "Progress update: implementation is complete.",
        });
      },
    );
    runTurn.mockImplementationOnce(
      async (params: { text?: string; onEvent?: (event: unknown) => void }) => {
        params.onEvent?.({
          type: "text_delta",
          stream: "output",
          text: "Progress update: implementation is complete.",
        });
      },
    );
    runWorkflowAgentOnSession
      .mockResolvedValueOnce({
        runId: "controller-run-1",
        text: [
          "MODULE_DECISION: CONTINUE",
          "MODULE_REASON:",
          "- Keep going.",
          "NEXT_INSTRUCTION:",
          "- Continue.",
          "BLOCKER:",
          "- none",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      })
      .mockResolvedValueOnce({
        runId: "controller-run-2",
        text: [
          "MODULE_DECISION: CONTINUE",
          "MODULE_REASON:",
          "- Keep going.",
          "NEXT_INSTRUCTION:",
          "- Continue.",
          "BLOCKER:",
          "- none",
        ].join("\n"),
        wait: { status: "ok" },
        messages: [],
      });

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
    await expect(
      codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            maxRetries: 2,
          },
        },
        {
          runId: "run-1",
          nowIso: () => "2026-04-10T00:00:00.000Z",
          persist: () => {},
          trace: createTraceMock("run-1"),
        },
      ),
    ).rejects.toThrow(
      "Controller returned CONTINUE without corrective guidance despite drift/evidence warnings in round 1.",
    );
  });
});
