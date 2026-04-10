import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("node:fs", () => ({
  existsSync,
  readFileSync,
}));

vi.mock("../managed-session-adapter.js", () => ({
  ensureWorkflowSessions,
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

describe("codex_controller module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("controller prompt template");
    ensureWorkflowSessions.mockResolvedValue({
      orchestrator: "agent:langgraph:pibo:workflow:run-1:orchestrator:main",
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
        params.onEvent?.({ type: "text_delta", stream: "output", text: "codex worker result" });
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
      },
    );

    expect(record.status).toBe("done");
    expect(record.terminalReason).toContain("complete and verified");
    expect(record.sessions.worker).toBe("agent:codex:acp:pibo:workflow:run-1:worker:codex");
    expect(ensureCliPluginRegistryLoaded).toHaveBeenCalledWith({ scope: "all" });
    expect(startPluginServices).toHaveBeenCalledTimes(1);
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
      },
    );

    expect(record.status).toBe("blocked");
    expect(record.terminalReason).toContain("product choice");
    expect(record.terminalReason).toContain("architecture A and B");
  });

  it("continues on legacy GUIDE output and triggers ACP compaction only after the configured round", async () => {
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
        sessionKey: "agent:codex:acp:pibo:workflow:run-1:worker:codex",
        mode: "prompt",
      }),
    );
    expect(startPluginServices).toHaveBeenCalledTimes(1);
  });
});
