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

function mockSingleRoundDoneLoop(reason = "Requested implementation is complete and verified.") {
  runWorkflowAgentOnSession
    .mockResolvedValueOnce(controllerInitReady())
    .mockResolvedValueOnce(
      controllerRun(
        [
          "MODULE_DECISION: DONE",
          "MODULE_REASON:",
          `- ${reason}`,
          "NEXT_INSTRUCTION:",
          "- none",
          "BLOCKER:",
          "- none",
        ].join("\n"),
        "controller-run-1",
      ),
    );
}

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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync,
      readFileSync,
    },
    existsSync,
    readFileSync,
  };
});

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
    expect(manifest.requiredAgents).toEqual(["codex", "codex-controller"]);
    expect(manifest.inputSchemaSummary).toContain(
      "agentId (string, optional): agent workspace used for bootstrap/context/system-prompt resolution; does not change workingDirectory or worker cwd.",
    );
  });

  it("rejects missing workingDirectory with repoPath-specific guidance", async () => {
    const { codexControllerWorkflowModule } = await import("./codex-controller.js");

    await expect(
      codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            repoPath: "/repo",
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
      "codex_controller benötigt `input.workingDirectory`. Falls `repoPath` übergeben wurde, bitte in `workingDirectory` umbenennen.",
    );
  });

  it("keeps the default behavior unchanged when agentId is omitted", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          workspace: "/workspace/default",
        },
      },
    });
    mockSingleRoundDoneLoop();

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
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

    expect(record.input.agentId).toBeUndefined();
    expect(record.sessions.extras).not.toHaveProperty("contextAgentId");
    expect(record.sessions.extras).not.toHaveProperty("contextWorkspaceDir");
    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(2);
    expect(runWorkflowAgentOnSession.mock.calls.every(([call]) => !("workspaceDir" in call))).toBe(
      true,
    );
    expect(startPluginServices).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/default",
      }),
    );
    expect(initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
      }),
    );
  });

  it("uses the selected agent workspace as workflow context when agentId is provided", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          workspace: "/workspace/default",
        },
        list: [
          { id: "writer", workspace: "/workspace/writer" },
          { id: "codex-controller", workspace: "/workspace/controller" },
        ],
      },
    });
    mockSingleRoundDoneLoop();

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          agentId: "writer",
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(record.input.agentId).toBe("writer");
    expect(record.sessions.extras?.contextAgentId).toBe("writer");
    expect(record.sessions.extras?.contextWorkspaceDir).toBe("/workspace/writer");
    expect(runWorkflowAgentOnSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceDir: "/workspace/writer",
      }),
    );
    expect(runWorkflowAgentOnSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceDir: "/workspace/writer",
      }),
    );
    expect(startPluginServices).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/writer",
      }),
    );
  });

  it("keeps the worker cwd on workingDirectory when agentId selects a different context workspace", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          workspace: "/workspace/default",
        },
        list: [{ id: "writer", workspace: "/workspace/writer" }],
      },
    });
    mockSingleRoundDoneLoop();

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          agentId: "writer",
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    expect(initializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        sessionKey: "agent:codex:acp:workflow:run-1:worker:codex",
      }),
    );
    expect(initializeSession).not.toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace/writer",
      }),
    );
  });

  it("restarts plugin services when the workflow context workspace changes between runs", async () => {
    const firstHandle = { stop: vi.fn(async () => {}) };
    const secondHandle = { stop: vi.fn(async () => {}) };
    startPluginServices.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);
    let cfg = {
      agents: {
        defaults: {
          workspace: "/workspace/default",
        },
      },
    };
    loadConfig.mockImplementation(() => cfg);
    mockSingleRoundDoneLoop("First run complete.");
    mockSingleRoundDoneLoop("Second run complete.");

    const mod = await import("./codex-controller.js");
    mod.__testing.resetCliPluginServicesHandleForTests();
    const { codexControllerWorkflowModule } = mod;
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo-a",
        },
      },
      {
        runId: "run-1",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-1"),
      },
    );

    cfg = {
      agents: {
        defaults: {
          workspace: "/workspace/default",
        },
        list: [{ id: "writer", workspace: "/workspace/writer" }],
      },
    };
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix again",
          workingDirectory: "/repo-b",
          agentId: "writer",
        },
      },
      {
        runId: "run-2",
        nowIso: () => "2026-04-10T00:00:00.000Z",
        persist: () => {},
        trace: createTraceMock("run-2"),
      },
    );

    expect(startPluginServices).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceDir: "/workspace/default",
      }),
    );
    expect(startPluginServices).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceDir: "/workspace/writer",
      }),
    );
    expect(firstHandle.stop).toHaveBeenCalledTimes(1);
    expect(secondHandle.stop).not.toHaveBeenCalled();
  });

  it("maps normalized controller DONE output to a done terminal state", async () => {
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: DONE",
            "MODULE_REASON:",
            "- Requested implementation is complete and verified.",
            "NEXT_INSTRUCTION:",
            "- none",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-1",
        ),
      );

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
          "Round: 1/10",
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
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "DECISION: ASK_USER",
            "RATIONALE:",
            "- A real product choice is required.",
            "CONTROLLER_MESSAGE:",
            "- Please choose between architecture A and B before I continue.",
            "CONFIDENCE: high",
          ].join("\n"),
          "controller-run-1",
        ),
      );

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
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "DECISION: GUIDE",
            "RATIONALE:",
            "- Continue with tighter verification.",
            "CONTROLLER_MESSAGE:",
            "- Proceed with the implementation, then verify end-to-end.",
            "CONFIDENCE: high",
          ].join("\n"),
          "controller-run-1",
        ),
      )
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: DONE",
            "MODULE_REASON:",
            "- Task is complete.",
            "NEXT_INSTRUCTION:",
            "- none",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-2",
        ),
      );

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
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "DECISION: GUIDE",
            "RATIONALE:",
            "- Continue with tighter verification.",
            "CONTROLLER_MESSAGE:",
            "- Proceed with the implementation, then verify end-to-end.",
            "CONFIDENCE: high",
          ].join("\n"),
          "controller-run-1",
        ),
      )
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: DONE",
            "MODULE_REASON:",
            "- Task is complete.",
            "NEXT_INSTRUCTION:",
            "- none",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-2",
        ),
      );

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

  it("sends stable controller context once at init and keeps later controller turns delta-only", async () => {
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
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: CONTINUE",
            "MODULE_REASON:",
            "- First round made concrete repo changes.",
            "NEXT_INSTRUCTION:",
            "- Continue, verify the changed files, and summarize the diff.",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-1",
        ),
      )
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: DONE",
            "MODULE_REASON:",
            "- Enough context for prompt-shape verification.",
            "NEXT_INSTRUCTION:",
            "- none",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-2",
        ),
      );

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

    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(3);
    const initPrompt = runWorkflowAgentOnSession.mock.calls[0][0].message as string;
    expect(initPrompt).toContain("controller prompt template");
    expect(initPrompt).toContain(
      "This controller session is persistent for the whole workflow run.",
    );
    expect(initPrompt).toContain("NORMALIZED WORKFLOW CONTRACT:");
    expect(initPrompt).toContain("ORIGINAL_TASK:");
    expect(initPrompt).toContain("SUCCESS_CRITERIA:");
    expect(initPrompt).toContain("CONSTRAINTS:");
    expect(initPrompt).not.toContain("RECENT_VISIBLE_WORKER_HISTORY:");
    expect(initPrompt).not.toContain("WORKER_OUTPUT:");

    expect(runWorkflowAgentOnSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "run-1:controller:1",
        message: expect.stringContaining("RECENT_VISIBLE_WORKER_HISTORY:"),
      }),
    );
    const roundOneDelta = runWorkflowAgentOnSession.mock.calls[1][0].message as string;
    expect(roundOneDelta).toContain("ROUND_CONTEXT: 1/2");
    expect(roundOneDelta).toContain("RECENT_VISIBLE_WORKER_HISTORY:");
    expect(roundOneDelta).toContain("CURRENT_WORKER_STATUS_HINTS:");
    expect(roundOneDelta).toContain("CURRENT_PROGRESS_EVIDENCE:");
    expect(roundOneDelta).toContain("CURRENT_DRIFT_SIGNALS:");
    expect(roundOneDelta).toContain("WORKER_OUTPUT:");
    expect(roundOneDelta).not.toContain("controller prompt template");
    expect(roundOneDelta).not.toContain("NORMALIZED WORKFLOW CONTRACT:");
    expect(roundOneDelta).not.toContain("ORIGINAL_TASK:");
    expect(roundOneDelta).not.toContain("SUCCESS_CRITERIA:");
    expect(roundOneDelta).not.toContain("CONSTRAINTS:");

    const secondPrompt = runWorkflowAgentOnSession.mock.calls[2][0].message as string;
    expect(secondPrompt).toContain("ROUND_CONTEXT: 2/2");
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
    expect(secondPrompt).toContain("WORKER_OUTPUT:");
    expect(secondPrompt).not.toContain("controller prompt template");
    expect(secondPrompt).not.toContain("NORMALIZED WORKFLOW CONTRACT:");
    expect(secondPrompt).not.toContain("ORIGINAL_TASK:");
    expect(secondPrompt).not.toContain("SUCCESS_CRITERIA:");
    expect(secondPrompt).not.toContain("CONSTRAINTS:");
    expect(secondPrompt).not.toContain("stream: thought");
  });

  it("filters hidden thinking and generic tool-call placeholders from visible worker output but keeps named tool calls", async () => {
    runTurn.mockImplementationOnce(
      async (params: { text?: string; onEvent?: (event: unknown) => void }) => {
        params.onEvent?.({
          type: "text_delta",
          stream: "thought",
          text: "hidden reasoning",
        });
        params.onEvent?.({
          type: "tool_call",
          text: "tool call",
        });
        params.onEvent?.({
          type: "tool_call",
          text: "tool call (completed)",
        });
        params.onEvent?.({
          type: "tool_call",
          text: "Run pnpm vitest run src/foo.test.ts (completed)",
        });
        params.onEvent?.({
          type: "text_delta",
          stream: "output",
          text: "Implemented the fix and verified it.",
        });
      },
    );
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: DONE",
            "MODULE_REASON:",
            "- Requested implementation is complete and verified.",
            "NEXT_INSTRUCTION:",
            "- none",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-1",
        ),
      );

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

    expect(record.latestWorkerOutput).toContain(
      "[tool] Run pnpm vitest run src/foo.test.ts (completed)",
    );
    expect(record.latestWorkerOutput).toContain("Implemented the fix and verified it.");
    expect(record.latestWorkerOutput).not.toContain("hidden reasoning");
    expect(record.latestWorkerOutput).not.toContain("[tool] tool call");
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
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: CONTINUE",
            "MODULE_REASON:",
            "- Keep going.",
            "NEXT_INSTRUCTION:",
            "- Continue.",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-1",
        ),
      )
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: CONTINUE",
            "MODULE_REASON:",
            "- Keep going.",
            "NEXT_INSTRUCTION:",
            "- Continue.",
            "BLOCKER:",
            "- none",
          ].join("\n"),
          "controller-run-2",
        ),
      );

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
