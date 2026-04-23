import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../config/types.js";
import { createWorkflowAbortError } from "../abort.js";
import type { WorkflowTraceRuntime } from "../tracing/runtime.js";
import type { WorkflowTraceSummary } from "../tracing/types.js";
import type { WorkflowRunRecord } from "../types.js";

const execFileSync = vi.fn();
const ensureWorkflowSessions = vi.fn();
const runWorkflowAgentOnSession = vi.fn();
const writeWorkflowArtifact = vi.fn();
const workflowArtifactPath = vi.fn((runId: string, name: string) => `${runId}/${name}`);
const workflowOwnedWorktreesDir = vi.fn(() => "/workflow-owned-worktrees");
const existsSync = vi.fn();
const mkdirSync = vi.fn();
const readFileSync = vi.fn();
const loadConfig = vi.fn<() => OpenClawConfig>(() => ({}));
const resolveCodexWorkerDefaultOptions = vi.fn(() => ({}));
const createCodexSdkWorkerRuntime = vi.fn();
const workerRunTurn = vi.fn();
const workerCompactThread = vi.fn();
const workerPrepareForRetry = vi.fn(
  () => "Codex SDK will resume thread thread-1 with a fresh CLI exec process on retry.",
);
const workerGetThreadId = vi.fn(() => "thread-1");
const workerGetTracePath = vi.fn(() => "/home/pibo/.codex/sessions/2026/04/17/thread-1.jsonl");
const emitTracedWorkflowReportEvent = vi.fn(async () => ({
  attempted: true,
  delivered: true,
}));
const traceEmit = vi.fn();
const artifactContents = new Map<string, string>();
const gitCommandCalls: string[] = [];

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

type CloseoutGitScenario = {
  head?: string;
  mergeBase?: string;
  statusPorcelain?: string;
  worktreeList?: string;
  refs?: string;
  absoluteGitDir?: string;
  commonGitDir?: string;
};

function mockCloseoutGitScenario(scenario: CloseoutGitScenario = {}) {
  execFileSync.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe("git");
    const cwd = args[1];
    const gitArgs = args.slice(2);
    const joined = gitArgs.join(" ");
    gitCommandCalls.push(`git -C ${cwd} ${joined}`);
    const head = scenario.head ?? "1111111111111111111111111111111111111111";
    const mergeBase = scenario.mergeBase ?? head;
    if (joined === "rev-parse --show-toplevel") {
      return `${cwd}\n`;
    }
    if (joined === "rev-parse --absolute-git-dir") {
      return `${scenario.absoluteGitDir ?? `${cwd}/.git`}\n`;
    }
    if (joined === "rev-parse --path-format=absolute --git-common-dir") {
      return `${scenario.commonGitDir ?? `${cwd}/.git`}\n`;
    }
    if (joined === "rev-parse --git-common-dir") {
      return `${scenario.commonGitDir ?? `${cwd}/.git`}\n`;
    }
    if (joined === "rev-parse HEAD") {
      return `${head}\n`;
    }
    if (joined === "status --porcelain=1") {
      return scenario.statusPorcelain ?? "";
    }
    if (joined === "worktree list --porcelain") {
      return scenario.worktreeList ?? `worktree ${cwd}\nHEAD ${head}\nbranch refs/heads/main\n`;
    }
    if (joined === "for-each-ref --format=%(refname:short) refs/heads refs/remotes") {
      return scenario.refs ?? "main\norigin/main\n";
    }
    if (joined === "merge-base HEAD origin/main") {
      return `${mergeBase}\n`;
    }
    if (
      joined.startsWith("worktree add --detach /workflow-owned-worktrees/") &&
      joined.endsWith(" HEAD")
    ) {
      return `HEAD is now at ${head}\n`;
    }
    if (joined.startsWith("worktree remove --force /workflow-owned-worktrees/")) {
      return "";
    }
    if (joined === "worktree prune") {
      return "";
    }
    throw new Error(`Unexpected git command: ${joined}`);
  });
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

function recordInput(record: WorkflowRunRecord): { agentId?: string } {
  return record.input as { agentId?: string };
}

function createModuleContext(runId: string, controller?: AbortController) {
  const abortController = controller ?? new AbortController();
  return {
    runId,
    nowIso: () => "2026-04-10T00:00:00.000Z",
    persist: () => {},
    abortSignal: abortController.signal,
    throwIfAbortRequested: () => {
      if (abortController.signal.aborted) {
        throw createWorkflowAbortError(abortController.signal.reason);
      }
    },
    trace: createTraceMock(runId),
  };
}

function workflowReportCalls(): Array<{ phase?: string; messageText?: string }> {
  return (emitTracedWorkflowReportEvent.mock.calls as unknown as Array<[unknown]>).map(
    ([call]) => call as { phase?: string; messageText?: string },
  );
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync,
    mkdirSync,
    readFileSync,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync,
  };
});

vi.mock("../workflow-session-helper.js", () => ({
  ensureWorkflowSessions,
}));

vi.mock("../agent-runtime.js", () => ({
  runWorkflowAgentOnSession,
}));

vi.mock("../store.js", () => ({
  writeWorkflowArtifact,
  workflowArtifactPath,
  workflowOwnedWorktreesDir,
}));

vi.mock("../../../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("./codex-sdk-runtime.js", () => ({
  resolveCodexWorkerDefaultOptions,
  createCodexSdkWorkerRuntime,
}));

vi.mock("../workflow-reporting.js", () => ({
  emitTracedWorkflowReportEvent,
}));

describe("codex_controller module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    artifactContents.clear();
    gitCommandCalls.length = 0;
    existsSync.mockImplementation((filePath: string) => {
      const normalizedPath = String(filePath);
      return artifactContents.has(normalizedPath) || !normalizedPath.endsWith(".json");
    });
    mkdirSync.mockImplementation(() => undefined);
    readFileSync.mockImplementation((filePath: string) => {
      const normalizedPath = String(filePath);
      return artifactContents.get(normalizedPath) ?? "controller prompt template";
    });
    loadConfig.mockReturnValue({});
    resolveCodexWorkerDefaultOptions.mockImplementation(
      (params?: { model?: string; reasoningEffort?: string }) => ({
        ...(params?.model ? { model: params.model } : {}),
        ...(params?.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      }),
    );
    mockCloseoutGitScenario();
    ensureWorkflowSessions.mockResolvedValue({
      orchestrator: "agent:langgraph:workflow:run-1:orchestrator:main",
    });
    workflowArtifactPath.mockImplementation((runId: string, name: string) => `${runId}/${name}`);
    writeWorkflowArtifact.mockImplementation((runId: string, name: string, content: string) => {
      const artifactPath = `${runId}/${name}`;
      artifactContents.set(artifactPath, content);
      return artifactPath;
    });
    workerRunTurn.mockResolvedValue({
      text: "codex worker result",
      threadId: "thread-1",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 2,
      },
      eventSummaries: ["turn.started", "turn.completed input=10 output=5 cached=2"],
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
      "agentId (string, optional): selects agent-workspace bootstrap for the controller (skills/system prompt) and adds that workspace as extra readable Codex context; does not change worker cwd or import full Main/session chat, memory, or docs.",
    );
    expect(manifest.inputSchemaSummary).toContain(
      'workingDirectoryMode ("workflow_owned_worktree"|"existing", optional): defaults to workflow-owned linked-worktree isolation when the requested path is inside a git checkout; use `existing` only when the operator intentionally wants the worker to run in the provided directory.',
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
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "codex_controller benötigt `input.workingDirectory`. Falls `repoPath` übergeben wurde, bitte in `workingDirectory` umbenennen.",
    );
  });

  it("stops after an abort request and does not start controller follow-up or later rounds", async () => {
    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const abortController = new AbortController();
    runWorkflowAgentOnSession.mockReset();
    runWorkflowAgentOnSession.mockResolvedValueOnce(controllerInitReady());
    workerRunTurn.mockImplementationOnce(async () => {
      abortController.abort(new Error("Abort requested by operator."));
      return {
        text: "codex worker result",
        threadId: "thread-1",
        usage: null,
        eventSummaries: [],
        tracePath: null,
      };
    });

    await expect(
      codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            workingDirectoryMode: "existing",
          },
        },
        createModuleContext("run-1", abortController),
      ),
    ).rejects.toThrow("Abort requested by operator.");

    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(1);
    expect(runWorkflowAgentOnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:langgraph:workflow:run-1:orchestrator:main",
        abortSignal: abortController.signal,
      }),
    );
    expect(workerRunTurn).toHaveBeenCalledTimes(1);
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "round-1-codex.txt",
      expect.any(String),
    );
    expect(writeWorkflowArtifact).not.toHaveBeenCalledWith(
      "run-1",
      "round-1-controller.txt",
      expect.any(String),
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

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(recordInput(record).agentId).toBeUndefined();
    expect(record.sessions.extras).not.toHaveProperty("contextAgentId");
    expect(record.sessions.extras).not.toHaveProperty("contextWorkspaceDir");
    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(2);
    expect(runWorkflowAgentOnSession.mock.calls.every(([call]) => !("workspaceDir" in call))).toBe(
      true,
    );
    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
      }),
    );
  });

  it("provisions a workflow-owned linked worktree by default for git checkouts and removes it after success", async () => {
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(record.input).toEqual(
      expect.objectContaining({
        workingDirectory: "/workflow-owned-worktrees/run-1",
        requestedWorkingDirectory: "/repo",
        repoRoot: "/repo",
        workingDirectoryMode: "workflow_owned_worktree",
        workspaceOwnership: "workflow_owned",
        workflowOwnedWorktree: {
          kind: "linked_worktree",
          rootPath: "/workflow-owned-worktrees/run-1",
          sourceRepoRoot: "/repo",
        },
      }),
    );
    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/workflow-owned-worktrees/run-1",
      }),
    );
    expect(record.sessions.extras?.workingDirectoryMode).toBe("workflow_owned_worktree");
    expect(record.sessions.extras?.workspaceOwnership).toBe("workflow_owned");
    expect(record.sessions.extras?.workflowOwnedWorktreeRoot).toBe(
      "/workflow-owned-worktrees/run-1",
    );
    expect(gitCommandCalls).toContain(
      "git -C /repo worktree add --detach /workflow-owned-worktrees/run-1 HEAD",
    );
    expect(gitCommandCalls).toContain(
      "git -C /repo worktree remove --force /workflow-owned-worktrees/run-1",
    );
    expect(gitCommandCalls).toContain("git -C /repo worktree prune");
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "run-summary.txt",
      expect.stringContaining("closeout-mode: workflow_owned_worktree_local"),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "run-summary.txt",
      expect.stringContaining("workspace-cleanup-status: passed"),
    );
  });

  it("keeps an explicit existing workingDirectory without provisioning or auto-cleanup", async () => {
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-existing"),
    );

    expect(record.status).toBe("done");
    expect(record.input).toEqual(
      expect.objectContaining({
        workingDirectory: "/repo",
        requestedWorkingDirectory: "/repo",
        repoRoot: "/repo",
        workingDirectoryMode: "existing",
        workspaceOwnership: "operator_owned",
      }),
    );
    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
      }),
    );
    expect(gitCommandCalls).not.toContain(
      "git -C /repo worktree add --detach /workflow-owned-worktrees/run-existing HEAD",
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-existing",
      "run-summary.txt",
      expect.stringContaining("workspace-cleanup-status: not_applicable"),
    );
  });

  it("accepts maxRounds as the preferred input budget alias", async () => {
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          maxRounds: 1,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-max-rounds"),
    );

    expect(record.status).toBe("done");
    expect(record.maxRounds).toBe(1);
    expect((record.input as { maxRetries?: number }).maxRetries).toBe(1);
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

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          agentId: "writer",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(recordInput(record).agentId).toBe("writer");
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
    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
        contextWorkspaceDir: "/workspace/writer",
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

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          agentId: "writer",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
        contextWorkspaceDir: "/workspace/writer",
      }),
    );
    expect(createCodexSdkWorkerRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/workspace/writer",
      }),
    );
  });

  it("rebuilds worker runtime options when the workflow context workspace changes between runs", async () => {
    let cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/workspace/default",
        },
      },
    };
    loadConfig.mockImplementation(() => cfg);
    mockSingleRoundDoneLoop("First run complete.");
    mockSingleRoundDoneLoop("Second run complete.");

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo-a",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
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
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-2"),
    );

    expect(createCodexSdkWorkerRuntime).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workingDirectory: "/repo-a",
      }),
    );
    expect(createCodexSdkWorkerRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workingDirectory: "/repo-b",
        contextWorkspaceDir: "/workspace/writer",
      }),
    );
  });

  it("persists a run-local contract artifact and injects worker developer instructions from it", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          workspace: "/workspace/default",
        },
        list: [{ id: "writer", workspace: "/workspace/writer" }],
      },
    });
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          agentId: "writer",
          successCriteria: ["Tests pass"],
          constraints: ["Do not touch unrelated files"],
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    const runContractPath = "run-1/codex-controller-run-contract.json";
    expect(record.artifacts).toContain(runContractPath);
    expect(record.sessions.extras?.runContractArtifact).toBe(runContractPath);
    expect(record.sessions.extras?.runContractVersion).toBe("1");
    expect(record.sessions.extras?.workerInstructionMode).toBe("developer_instructions");
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "codex-controller-run-contract.json",
      expect.stringContaining('"runId": "run-1"'),
    );
    expect(artifactContents.get(runContractPath)).toContain(
      '"controllerPrompt": "controller prompt template"',
    );
    expect(artifactContents.get(runContractPath)).toContain(
      '"contextWorkspaceDir": "/workspace/writer"',
    );
    expect(artifactContents.get(runContractPath)).toContain(
      "Treat this persisted run contract as the stable source of truth",
    );
    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
        contextWorkspaceDir: "/workspace/writer",
        developerInstructions: expect.stringContaining("ORIGINAL_TASK:\nShip the fix"),
      }),
    );
  });

  it("rehydrates an existing run contract instead of reloading prompt/config state for the same run", async () => {
    artifactContents.set(
      "run-1/codex-controller-run-contract.json",
      JSON.stringify(
        {
          version: 1,
          moduleId: "codex_controller",
          runId: "run-1",
          createdAt: "2026-04-10T00:00:00.000Z",
          input: {
            task: "Persisted task",
            workingDirectory: "/repo-persisted",
            repoRoot: "/repo-persisted",
            agentId: "writer",
            maxRetries: 1,
            successCriteria: ["Persisted criterion"],
            constraints: ["Persisted constraint"],
            codexAgentId: "codex",
            controllerAgentId: "codex-controller",
            controllerPromptPath: "/persisted/prompt.md",
            workerCompactionMode: "off",
            workerCompactionAfterRound: 3,
            closeoutContextSource: "workingDirectory",
          },
          controllerPrompt: "persisted controller prompt",
          workerDeveloperInstructions:
            "Persisted worker developer instructions\n\nORIGINAL_TASK:\nPersisted task",
          contextWorkspaceDir: "/workspace/original",
        },
        null,
        2,
      ),
    );
    existsSync.mockImplementation((filePath: string) => artifactContents.has(String(filePath)));
    loadConfig.mockImplementation(() => {
      throw new Error("loadConfig should not be called when a persisted run contract exists.");
    });
    mockSingleRoundDoneLoop("Persisted run contract completed.");

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "New task that should be ignored",
          workingDirectory: "/repo-new",
          agentId: "other",
          controllerPromptPath: "/new/prompt.md",
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.originalTask).toBe("Persisted task");
    expect(recordInput(record).agentId).toBe("writer");
    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo-persisted",
        contextWorkspaceDir: "/workspace/original",
        developerInstructions:
          "Persisted worker developer instructions\n\nORIGINAL_TASK:\nPersisted task",
      }),
    );
    expect(runWorkflowAgentOnSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceDir: "/workspace/original",
        message: expect.stringContaining("persisted controller prompt"),
      }),
    );
    const runContractWrites = writeWorkflowArtifact.mock.calls.filter(
      ([, name]) => name === "codex-controller-run-contract.json",
    );
    expect(runContractWrites).toHaveLength(0);
  });

  it("keeps run contracts isolated across separate run ids", async () => {
    mockSingleRoundDoneLoop("First isolated run complete.");
    mockSingleRoundDoneLoop("Second isolated run complete.");

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Task for run one",
          workingDirectory: "/repo-one",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Task for run two",
          workingDirectory: "/repo-two",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-2"),
    );

    expect(artifactContents.get("run-1/codex-controller-run-contract.json")).toContain(
      '"task": "Task for run one"',
    );
    expect(artifactContents.get("run-2/codex-controller-run-contract.json")).toContain(
      '"task": "Task for run two"',
    );
    expect(createCodexSdkWorkerRuntime).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        developerInstructions: expect.stringContaining("Task for run one"),
      }),
    );
    expect(createCodexSdkWorkerRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        developerInstructions: expect.stringContaining("Task for run two"),
      }),
    );
  });

  it("maps normalized controller DONE output to done only after clean closeout success", async () => {
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
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(record.terminalReason).toContain("complete and verified");
    expect(record.input).toEqual(
      expect.objectContaining({
        workingDirectory: "/repo",
        repoRoot: "/repo",
        closeoutContextSource: "workingDirectory",
      }),
    );
    expect(record.sessions.worker).toBe("codex-thread:thread-1");
    expect(record.sessions.orchestrator).toBe("agent:langgraph:workflow:run-1:orchestrator:main");
    expect(record.sessions.extras?.codexThreadId).toBe("thread-1");
    expect(record.sessions.extras?.codexTracePath).toBe(
      "/home/pibo/.codex/sessions/2026/04/17/thread-1.jsonl",
    );
    expect(record.sessions.extras?.runContractArtifact).toBe(
      "run-1/codex-controller-run-contract.json",
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "codex-controller-run-contract.json",
      expect.any(String),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "closeout-assessment.json",
      expect.stringContaining('"status": "pass"'),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "run-summary.txt",
      expect.stringContaining("closeout-status: pass"),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-1",
      "run-summary.txt",
      expect.stringContaining(
        "closeout-reason: Closeout passed: repo clean, no extra worktrees, HEAD integrated into origin/main.",
      ),
    );
    expect(workerRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        hardTimeoutSeconds: 7_200,
        idleTimeoutSeconds: 480,
      }),
    );
    const workerPrompt = workerRunTurn.mock.calls[0]?.[0]?.text as string;
    expect(workerPrompt).toContain("SUCCESS_CRITERIA:");
    expect(workerPrompt).toContain("FINISH_QUALITY:");
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

  it("uses the module-scoped worker timeout and succeeds on the first worker attempt without retry events", async () => {
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-timeout-default"),
    );

    expect(record.status).toBe("done");
    expect(record.sessions.extras?.workerPromptTimeoutSeconds).toBe("7200");
    expect(record.sessions.extras?.workerIdleTimeoutSeconds).toBe("480");
    expect(workerRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        hardTimeoutSeconds: 7_200,
        idleTimeoutSeconds: 480,
      }),
    );
    const retryPhases = workflowReportCalls()
      .map((call) => call.phase)
      .filter(
        (phase): phase is string => typeof phase === "string" && phase.startsWith("worker_retry_"),
      );
    expect(retryPhases).toEqual([]);
  });

  it("retries a retryable Codex worker timeout once, emits retry lifecycle events, and succeeds", async () => {
    let promptAttempts = 0;
    workerRunTurn.mockImplementation(async () => {
      promptAttempts += 1;
      if (promptAttempts === 1) {
        throw Object.assign(new Error("Timed out after 120000ms"), {
          code: "CODEX_TIMEOUT",
        });
      }
      return {
        text: "codex worker result after retry",
        threadId: "thread-1",
        usage: null,
        eventSummaries: [],
        tracePath: null,
      };
    });
    mockSingleRoundDoneLoop("Retry completed successfully.");

    vi.useFakeTimers();
    try {
      const { codexControllerWorkflowModule } = await import("./codex-controller.js");
      const runPromise = codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            workingDirectoryMode: "existing",
          },
        },
        createModuleContext("run-retry-success"),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      const record = await runPromise;

      expect(record.status).toBe("done");
      expect(promptAttempts).toBe(2);
      expect(workerPrepareForRetry).toHaveBeenCalledTimes(1);
      const retryCalls = workflowReportCalls().filter((call) =>
        call.phase?.startsWith("worker_retry_"),
      );
      expect(retryCalls.map((call) => call.phase)).toEqual([
        "worker_retry_scheduled",
        "worker_retry_started",
        "worker_retry_succeeded",
      ]);
      expect(retryCalls[0]?.messageText).toContain("Worker hard timeout: 7200s");
      expect(retryCalls[0]?.messageText).toContain("Worker idle timeout: 480s");
      expect(retryCalls[0]?.messageText).toContain("Worker error code: CODEX_TIMEOUT");
      expect(retryCalls[1]?.messageText).toContain("Cleanup:");
      expect(retryCalls[2]?.messageText).toContain("Attempt: 2/2");
      expect(traceEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "custom",
          summary: "Worker retry scheduled.",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries when a worker turn reports a transport fallback interruption", async () => {
    let promptAttempts = 0;
    workerRunTurn.mockImplementation(async () => {
      promptAttempts += 1;
      if (promptAttempts === 1) {
        throw new Error(
          "Codex worker transport fallback interrupted the turn before concrete output was produced. Notices: Falling back from WebSockets to HTTPS transport. timeout waiting for child process to exit. Remaining output: none.",
        );
      }
      return {
        text: "Updated `src/cli/pibo-cli.ts` and ran `pnpm vitest run src/cli/pibo-cli.test.ts`.",
        threadId: "thread-1",
        usage: null,
        eventSummaries: [],
        tracePath: null,
      };
    });
    mockSingleRoundDoneLoop("Retry completed after transport fallback cleanup.");

    vi.useFakeTimers();
    try {
      const { codexControllerWorkflowModule } = await import("./codex-controller.js");
      const runPromise = codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            workingDirectoryMode: "existing",
          },
        },
        createModuleContext("run-transport-retry"),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      const record = await runPromise;

      expect(record.status).toBe("done");
      expect(promptAttempts).toBe(2);
      expect(workerPrepareForRetry).toHaveBeenCalledTimes(1);
      expect(writeWorkflowArtifact).toHaveBeenCalledWith(
        "run-transport-retry",
        "round-1-codex.txt",
        expect.stringContaining("Updated `src/cli/pibo-cli.ts`"),
      );
      expect(writeWorkflowArtifact).not.toHaveBeenCalledWith(
        "run-transport-retry",
        "round-1-codex.txt",
        expect.stringContaining("Falling back from WebSockets"),
      );
      const retryCalls = workflowReportCalls().filter((call) =>
        call.phase?.startsWith("worker_retry_"),
      );
      expect(retryCalls.map((call) => call.phase)).toEqual([
        "worker_retry_scheduled",
        "worker_retry_started",
        "worker_retry_succeeded",
      ]);
      expect(retryCalls[0]?.messageText).toContain(
        "Codex worker transport fallback interrupted the turn before concrete output was produced.",
      );
      expect(retryCalls[1]?.messageText).toContain("Cleanup:");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps transport fallback notices in trace payloads without exposing them in worker output", async () => {
    workerRunTurn.mockResolvedValue({
      text: "Updated `src/cli/pibo-cli.ts` and verified the change with `pnpm vitest run src/cli/pibo-cli.test.ts`.",
      threadId: "thread-1",
      usage: null,
      eventSummaries: [
        "turn.started",
        "connection transitioned from WebSockets to HTTPS transport",
        "turn.completed input=10 output=10 cached=0",
      ],
      tracePath: null,
    });
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-transport-evidence"),
    );

    expect(record.status).toBe("done");
    const retryPhases = workflowReportCalls()
      .map((call) => call.phase)
      .filter(
        (phase): phase is string => typeof phase === "string" && phase.startsWith("worker_retry_"),
      );
    expect(retryPhases).toEqual([]);
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-transport-evidence",
      "round-1-codex.txt",
      expect.stringContaining("Updated `src/cli/pibo-cli.ts`"),
    );
    expect(writeWorkflowArtifact).not.toHaveBeenCalledWith(
      "run-transport-evidence",
      "round-1-codex.txt",
      expect.stringContaining("WebSockets"),
    );
  });

  it("emits retry exhaustion after the bounded retry also hits a retryable Codex worker timeout", async () => {
    workerRunTurn.mockImplementation(async () => {
      throw Object.assign(new Error("Timed out after 120000ms"), {
        code: "CODEX_TIMEOUT",
      });
    });
    runWorkflowAgentOnSession.mockResolvedValueOnce(controllerInitReady());

    vi.useFakeTimers();
    try {
      const { codexControllerWorkflowModule } = await import("./codex-controller.js");
      const runPromise = codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            workingDirectoryMode: "existing",
          },
        },
        createModuleContext("run-retry-exhausted"),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(runPromise).rejects.toThrow("worker retry exhausted after 2 attempts");
      expect(workerPrepareForRetry).toHaveBeenCalledTimes(1);
      const retryPhases = workflowReportCalls()
        .map((call) => call.phase)
        .filter(
          (phase): phase is string =>
            typeof phase === "string" && phase.startsWith("worker_retry_"),
        );
      expect(retryPhases).toEqual([
        "worker_retry_scheduled",
        "worker_retry_started",
        "worker_retry_exhausted",
      ]);
      expect(traceEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "warning",
          summary: "Worker retry exhausted.",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-retryable worker failures", async () => {
    workerRunTurn.mockImplementation(async () => {
      throw Object.assign(new Error("Permission denied writing /repo/src/foo.ts"), {
        code: "CODEX_ERROR",
      });
    });
    runWorkflowAgentOnSession.mockResolvedValueOnce(controllerInitReady());

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await expect(
      codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            workingDirectoryMode: "existing",
          },
        },
        createModuleContext("run-no-retry"),
      ),
    ).rejects.toThrow("Permission denied writing /repo/src/foo.ts");

    expect(workerPrepareForRetry).not.toHaveBeenCalled();
    const retryPhases = workflowReportCalls()
      .map((call) => call.phase)
      .filter(
        (phase): phase is string => typeof phase === "string" && phase.startsWith("worker_retry_"),
      );
    expect(retryPhases).toEqual([]);
  });

  it("remaps DONE on dirty repo preflight failure to continue instead of terminal closeout", async () => {
    mockCloseoutGitScenario({
      statusPorcelain: " M src/dirty.ts\n?? scratch.txt\n",
    });
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          maxRetries: 1,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-dirty"),
    );

    expect(record.status).toBe("max_rounds_reached");
    expect(record.terminalReason).toBe("Controller retry budget exhausted.");
    expect(record.currentTask).toContain("Clean the repo/worktree before DONE.");
    expect(record.currentTask).toContain("src/dirty.ts, scratch.txt");
    expect(record.latestCriticVerdict).toContain("MODULE_DECISION: DONE");
    expect(writeWorkflowArtifact).not.toHaveBeenCalledWith(
      "run-dirty",
      "closeout-assessment.json",
      expect.any(String),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-dirty",
      "run-summary.txt",
      expect.stringContaining("status: max_rounds_reached"),
    );
    expect(traceEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "run_blocked",
        status: "max_rounds_reached",
        summary: "Controller retry budget exhausted.",
      }),
    );
  });

  it("remaps DONE on ambient open worktree preflight failure to blocked escalation", async () => {
    mockCloseoutGitScenario({
      worktreeList: [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "worktree /repo-linked",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/feature",
      ].join("\n"),
    });
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          maxRetries: 1,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-worktree"),
    );

    expect(record.status).toBe("blocked");
    expect(record.terminalReason).toContain(
      "Controller DONE rejected because closeout preflight failed",
    );
    expect(record.terminalReason).toContain("open linked worktrees");
    expect(record.terminalReason).not.toContain("Closeout mismatch after controller DONE");
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-worktree",
      "closeout-assessment.json",
      expect.stringContaining('"code": "open_worktree"'),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-worktree",
      "run-summary.txt",
      expect.stringContaining("closeout-status: blocked"),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-worktree",
      "run-summary.txt",
      expect.stringContaining("open_worktrees=/repo,/repo-linked"),
    );
    expect(traceEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "run_blocked",
        status: "blocked",
        summary: expect.stringContaining(
          "Controller DONE rejected because closeout preflight failed",
        ),
      }),
    );
  });

  it("treats a linked workingDirectory without explicit repoRoot as worktree-local closeout", async () => {
    mockCloseoutGitScenario({
      head: "2222222222222222222222222222222222222222",
      mergeBase: "1111111111111111111111111111111111111111",
      absoluteGitDir: "/repo/.git/worktrees/task",
      commonGitDir: "/repo/.git",
      worktreeList: [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "worktree /repo/slices/task",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/codex/task",
      ].join("\n"),
    });
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo/slices/task",
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-linked-worktree-done"),
    );

    expect(record.status).toBe("done");
    expect(record.input).toEqual(
      expect.objectContaining({
        workingDirectory: "/repo/slices/task",
        repoRoot: "/repo/slices/task",
        closeoutContextSource: "workingDirectory",
      }),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-linked-worktree-done",
      "closeout-assessment.json",
      expect.stringContaining('"closeoutMode": "linked_worktree_local"'),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-linked-worktree-done",
      "run-summary.txt",
      expect.stringContaining("closeout-mode: linked_worktree_local"),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-linked-worktree-done",
      "run-summary.txt",
      expect.stringContaining(
        "closeout-reason: Closeout passed: linked worktree is clean; sibling worktrees and mainline integration are deferred until an explicit repoRoot closeout.",
      ),
    );
    const controllerPrompt = runWorkflowAgentOnSession.mock.calls[1][0].message as string;
    expect(controllerPrompt).toContain("mode=linked_worktree_local");
    expect(controllerPrompt).toContain("status=pass");
    expect(controllerPrompt).toContain("open_worktrees=none");
    expect(controllerPrompt).toContain("head_integrated_into_base=true");
  });

  it("does not block a workflow-owned worktree DONE just because the shared repo has sibling worktrees or integration drift", async () => {
    mockCloseoutGitScenario({
      head: "2222222222222222222222222222222222222222",
      mergeBase: "1111111111111111111111111111111111111111",
      worktreeList: [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "worktree /workflow-owned-worktrees/run-owned-shared-noise",
        "HEAD 2222222222222222222222222222222222222222",
        "detached",
        "worktree /repo-linked",
        "HEAD 3333333333333333333333333333333333333333",
        "branch refs/heads/feature",
      ].join("\n"),
    });
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          repoRoot: "/repo",
        },
      },
      createModuleContext("run-owned-shared-noise"),
    );

    expect(record.status).toBe("done");
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-owned-shared-noise",
      "closeout-assessment.json",
      expect.stringContaining('"closeoutMode": "workflow_owned_worktree_local"'),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-owned-shared-noise",
      "run-summary.txt",
      expect.stringContaining(
        "closeout-reason: Closeout passed: workflow-owned linked worktree is clean; shared-repo integration and sibling worktrees are outside this run.",
      ),
    );
  });

  it("remaps DONE on not-integrated preflight failure to continue instead of terminal closeout", async () => {
    mockCloseoutGitScenario({
      head: "2222222222222222222222222222222222222222",
      mergeBase: "1111111111111111111111111111111111111111",
    });
    mockSingleRoundDoneLoop();

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          repoRoot: "/repo",
          maxRetries: 1,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-integration"),
    );

    expect(record.status).toBe("max_rounds_reached");
    expect(record.terminalReason).toBe("Controller retry budget exhausted.");
    expect(record.currentTask).toContain("Integrate the current HEAD into origin/main before DONE");
    expect(record.latestCriticVerdict).toContain("MODULE_DECISION: DONE");
    expect(writeWorkflowArtifact).not.toHaveBeenCalledWith(
      "run-integration",
      "closeout-assessment.json",
      expect.any(String),
    );
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-integration",
      "run-summary.txt",
      expect.stringContaining("status: max_rounds_reached"),
    );
  });

  it("blocks terminal success when workflow-owned worktree cleanup fails", async () => {
    mockCloseoutGitScenario({
      worktreeList: [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "worktree /workflow-owned-worktrees/run-cleanup-failed",
        "HEAD 1111111111111111111111111111111111111111",
        "detached",
      ].join("\n"),
    });
    mockSingleRoundDoneLoop();
    const previousImplementation = execFileSync.getMockImplementation();
    execFileSync.mockImplementation((command: string, args: string[]) => {
      const cwd = args[1];
      const joined = args.slice(2).join(" ");
      if (
        cwd === "/repo" &&
        joined === "worktree remove --force /workflow-owned-worktrees/run-cleanup-failed"
      ) {
        throw new Error("cleanup remove failed");
      }
      return previousImplementation?.(command, args);
    });

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
        },
      },
      createModuleContext("run-cleanup-failed"),
    );

    expect(record.status).toBe("blocked");
    expect(record.terminalReason).toContain("workspace cleanup failed");
    expect(record.terminalReason).toContain("cleanup remove failed");
    expect(writeWorkflowArtifact).toHaveBeenCalledWith(
      "run-cleanup-failed",
      "run-summary.txt",
      expect.stringContaining("workspace-cleanup-status: blocked"),
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
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("blocked");
    expect(record.terminalReason).toContain("product choice");
    expect(record.terminalReason).toContain("architecture A and B");
  });

  it("keeps manual Codex app-server compaction off by default", async () => {
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

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workerCompactionAfterRound: 2,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(workerCompactThread).not.toHaveBeenCalled();
  });

  it("continues on legacy GUIDE output and triggers app-server compaction only after the configured round when explicitly enabled", async () => {
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

    workerCompactThread.mockResolvedValueOnce({
      threadId: "thread-1",
      compactionTurnId: "compact-1",
      notificationSummaries: ["thread/compacted thread_id=thread-1 turn_id=compact-1"],
      tracePath: "/home/pibo/.codex/sessions/2026/04/17/thread-1.jsonl",
    });
    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    const record = await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          workerCompactionMode: "acp_control_command",
          workerCompactionAfterRound: 2,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(workerCompactThread).toHaveBeenCalledTimes(1);
    expect(createCodexSdkWorkerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
      }),
    );
  });

  it("sends stable controller context once at init and keeps later controller turns delta-only", async () => {
    workerRunTurn
      .mockResolvedValueOnce({
        text: "Implemented parser changes in src/foo.ts and ran pnpm vitest.",
        threadId: "thread-1",
        usage: null,
        eventSummaries: [],
        tracePath: null,
      })
      .mockResolvedValueOnce({
        text: "Progress update: implementation is complete. Progress update: implementation is complete.",
        threadId: "thread-1",
        usage: null,
        eventSummaries: [],
        tracePath: null,
      });
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

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo",
          maxRetries: 2,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(3);
    const initPrompt = runWorkflowAgentOnSession.mock.calls[0][0].message as string;
    expect(initPrompt).toContain("controller prompt template");
    expect(initPrompt).toContain(
      "This controller session is persistent for the whole workflow run.",
    );
    expect(initPrompt).toContain(
      "Treat the persisted run contract in this message as the stable source of truth for this run.",
    );
    expect(initPrompt).toContain("NORMALIZED WORKFLOW CONTRACT:");
    expect(initPrompt).toContain("RUN_CONTRACT:");
    expect(initPrompt).toContain("ORIGINAL_TASK:");
    expect(initPrompt).toContain("SUCCESS_CRITERIA:");
    expect(initPrompt).toContain("CONSTRAINTS:");
    expect(initPrompt).toContain(
      "If CLOSEOUT_PREFLIGHT.status=fail, MODULE_DECISION must not be DONE.",
    );
    expect(initPrompt).toContain("If CLOSEOUT_PREFLIGHT.failure_class=worker_fixable");
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
    expect(roundOneDelta).toContain("RUN_CONTRACT:");
    expect(roundOneDelta).toContain(
      "normalized_decision_block=MODULE_DECISION|MODULE_REASON|NEXT_INSTRUCTION|BLOCKER",
    );
    expect(roundOneDelta).toContain("original_task=Ship the fix");
    expect(roundOneDelta).toContain("RECENT_VISIBLE_WORKER_HISTORY:");
    expect(roundOneDelta).toContain("CURRENT_WORKER_STATUS_HINTS:");
    expect(roundOneDelta).toContain("CLOSEOUT_PREFLIGHT:");
    expect(roundOneDelta).toContain("status=pass");
    expect(roundOneDelta).toContain("failure_class=unknown");
    expect(roundOneDelta).toContain("repo_clean=true");
    expect(roundOneDelta).toContain("open_worktrees=none");
    expect(roundOneDelta).toContain("CURRENT_PROGRESS_EVIDENCE:");
    expect(roundOneDelta).toContain("CURRENT_DRIFT_SIGNALS:");
    expect(roundOneDelta).toContain("WORKER_OUTPUT:");
    expect(roundOneDelta).not.toContain("controller prompt template");
    expect(roundOneDelta).not.toContain("NORMALIZED WORKFLOW CONTRACT:");
    expect(roundOneDelta).not.toContain("ORIGINAL_TASK:");
    expect(roundOneDelta).not.toContain("SUCCESS_CRITERIA:\n- none");
    expect(roundOneDelta).not.toContain("CONSTRAINTS:\n- none");

    const secondPrompt = runWorkflowAgentOnSession.mock.calls[2][0].message as string;
    expect(secondPrompt).toContain("ROUND_CONTEXT: 2/2");
    expect(secondPrompt).toContain("RUN_CONTRACT:");
    expect(secondPrompt).toContain("original_task=Ship the fix");
    expect(secondPrompt).toContain("round 1: status=working_with_evidence");
    expect(secondPrompt).toContain("round 2: status=claims_done");
    expect(secondPrompt).toContain("CONTROLLER_HISTORY:");
    expect(secondPrompt).toContain("decision=CONTINUE");
    expect(secondPrompt).toContain("CLOSEOUT_PREFLIGHT:");
    expect(secondPrompt).toContain("status=pass");
    expect(secondPrompt).toContain("head_integrated_into_base=true");
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

  it("surfaces ambient dirty repo state in the controller preflight instead of framing it as worker-fixable", async () => {
    mockCloseoutGitScenario({
      statusPorcelain: " M pnpm-lock.yaml\n",
    });
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: ESCALATE_BLOCKED",
            "MODULE_REASON:",
            "- Ambient repo state blocks clean closeout.",
            "NEXT_INSTRUCTION:",
            "- none",
            "BLOCKER:",
            "- Clean repo root first.",
          ].join("\n"),
          "controller-run-1",
        ),
      );

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo/slices/task",
          repoRoot: "/repo",
          maxRetries: 1,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-ambient-preflight"),
    );

    const controllerPrompt = runWorkflowAgentOnSession.mock.calls[1][0].message as string;
    expect(controllerPrompt).toContain("CLOSEOUT_PREFLIGHT:");
    expect(controllerPrompt).toContain("status=fail");
    expect(controllerPrompt).toContain("failure_class=ambient_repo_state");
    expect(controllerPrompt).toContain("dirty_paths=pnpm-lock.yaml");
    expect(controllerPrompt).toContain("repo_root=/repo");
    expect(controllerPrompt).toContain("working_directory=/repo/slices/task");
  });

  it("flags an open current linked worktree as an operator_blocker in the controller preflight", async () => {
    mockCloseoutGitScenario({
      worktreeList: [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "worktree /repo/slices/task",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/codex/task",
      ].join("\n"),
    });
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(controllerInitReady())
      .mockResolvedValueOnce(
        controllerRun(
          [
            "MODULE_DECISION: ESCALATE_BLOCKED",
            "MODULE_REASON:",
            "- Current linked worktree cannot be closed out from inside this active session.",
            "NEXT_INSTRUCTION:",
            "- none",
            "BLOCKER:",
            "- External closeout step required.",
          ].join("\n"),
          "controller-run-1",
        ),
      );

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await codexControllerWorkflowModule.start(
      {
        input: {
          task: "Ship the fix",
          workingDirectory: "/repo/slices/task",
          repoRoot: "/repo",
          maxRetries: 1,
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-worktree-preflight"),
    );

    const controllerPrompt = runWorkflowAgentOnSession.mock.calls[1][0].message as string;
    expect(controllerPrompt).toContain("CLOSEOUT_PREFLIGHT:");
    expect(controllerPrompt).toContain("status=fail");
    expect(controllerPrompt).toContain("failure_class=operator_blocker");
    expect(controllerPrompt).toContain("open_worktrees=/repo/slices/task");
    expect(controllerPrompt).toContain("no_open_linked_worktrees=false");
  });

  it("keeps visible worker output limited to assistant messages while trace payloads retain event summaries", async () => {
    workerRunTurn.mockResolvedValueOnce({
      text: "Implemented the fix and verified it.",
      threadId: "thread-1",
      usage: null,
      eventSummaries: [
        "turn.started",
        "item.completed command_execution status=completed exit_code=0 command=pnpm vitest run src/foo.test.ts",
        "turn.completed input=10 output=10 cached=0",
      ],
      tracePath: null,
    });
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
          workingDirectoryMode: "existing",
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.latestWorkerOutput).toContain("Implemented the fix and verified it.");
    expect(record.latestWorkerOutput).not.toContain("pnpm vitest");
    expect(traceEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "role_turn_completed",
        payload: expect.objectContaining({
          eventSummaries: expect.arrayContaining([
            "item.completed command_execution status=completed exit_code=0 command=pnpm vitest run src/foo.test.ts",
          ]),
        }),
      }),
    );
  });

  it("surfaces codex worker disconnects with round and session context", async () => {
    workerRunTurn.mockRejectedValueOnce(
      new Error("Codex worker disconnected before completion. reason: connection_close."),
    );
    runWorkflowAgentOnSession.mockResolvedValueOnce(controllerInitReady());

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await expect(
      codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            workingDirectoryMode: "existing",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "Codex worker turn failed in round 1/10 on session codex-thread:thread-1: Codex worker disconnected before completion. reason: connection_close.",
    );
  });

  it("rejects blind CONTINUE when drift warnings exist but next instruction is not corrective", async () => {
    workerRunTurn
      .mockResolvedValueOnce({
        text: "Progress update: implementation is complete.",
        threadId: "thread-1",
        usage: null,
        eventSummaries: [],
        tracePath: null,
      })
      .mockResolvedValueOnce({
        text: "Progress update: implementation is complete.",
        threadId: "thread-1",
        usage: null,
        eventSummaries: [],
        tracePath: null,
      });
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

    const { codexControllerWorkflowModule } = await import("./codex-controller.js");
    await expect(
      codexControllerWorkflowModule.start(
        {
          input: {
            task: "Ship the fix",
            workingDirectory: "/repo",
            maxRetries: 2,
            workingDirectoryMode: "existing",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "Controller returned CONTINUE without corrective guidance despite drift/evidence warnings in round 1.",
    );
  });
});
