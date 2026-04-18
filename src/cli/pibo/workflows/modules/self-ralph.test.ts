import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowAbortError } from "../abort.js";
import type { WorkflowTraceRuntime } from "../tracing/runtime.js";
import type { WorkflowTraceSummary } from "../tracing/types.js";
import type { WorkflowRunRecord } from "../types.js";

const execFileSync = vi.fn();
const statSync = vi.fn();
const accessSync = vi.fn();
const mkdirSync = vi.fn();
const writeFileSync = vi.fn();
const ensureWorkflowSessions = vi.fn();
const runWorkflowAgentOnSession = vi.fn();
const writeWorkflowArtifact = vi.fn();
const emitTracedWorkflowReportEvent = vi.fn(async () => ({ attempted: true, delivered: true }));
const traceEmit = vi.fn();

function createTraceMock(runId: string): WorkflowTraceRuntime {
  return {
    runId,
    moduleId: "self_ralph",
    level: 1,
    emit: traceEmit,
    attachToRunRecord: (record: WorkflowRunRecord) => record,
    getRef: () => ({
      version: "v1",
      level: 1,
      eventLogPath: `/tmp/${runId}.trace.jsonl`,
      summaryPath: `/tmp/${runId}.trace.summary.json`,
      eventCount: 0,
      updatedAt: "2026-04-18T00:00:00.000Z",
    }),
    getSummary: () =>
      ({
        runId,
        moduleId: "self_ralph",
        traceLevel: 1,
        eventCount: 0,
        stepCount: 0,
        roundCount: 0,
        rolesSeen: [],
        artifactCount: 0,
      }) satisfies WorkflowTraceSummary,
  };
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      statSync,
      accessSync,
      mkdirSync,
      writeFileSync,
    },
    statSync,
    accessSync,
    mkdirSync,
    writeFileSync,
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
}));

vi.mock("../workflow-reporting.js", () => ({
  emitTracedWorkflowReportEvent,
}));

function createModuleContext(runId: string, controller?: AbortController) {
  const abortController = controller ?? new AbortController();
  return {
    runId,
    nowIso: () => "2026-04-18T00:00:00.000Z",
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

function workflowRun(text: string, runId: string) {
  return {
    runId,
    text,
    wait: { status: "ok" as const },
    messages: [],
  };
}

function approvedBrainstormingDraft() {
  return [
    "# Brainstorming",
    "",
    "## Direction",
    "Erstelle eine Social Media App",
    "",
    "## Concept Options",
    "### Concept 1: Orbit Stream",
    "- Target users: Gen Z creator circles",
    "- Core problem: Private group sharing feels fragmented",
    "- Core loop: Capture, post, react, remix",
    "- Differentiation: Prompted challenge loops",
    "- MVP fit: Strong",
    "",
    "### Concept 2: Signal Clubs",
    "- Target users: Hobby communities",
    "- Core problem: Group momentum dies fast",
    "- Core loop: Join clubs, complete weekly prompts, compare streaks",
    "- Differentiation: Club leaderboards",
    "- MVP fit: Medium",
    "",
    "### Concept 3: Studio Pulse",
    "- Target users: Micro creators",
    "- Core problem: Feedback arrives too late",
    "- Core loop: Post drafts, get time-boxed reactions, iterate",
    "- Differentiation: Draft-first feedback windows",
    "- MVP fit: Strong",
    "",
    "## Selected Concept",
    "- Title: Orbit Stream",
    "- Why selected: Strongest MVP loop with immediate social pull",
    "- MVP thesis: Ship tight private-group posting and challenge loops first",
  ].join("\n");
}

function queueApprovedPlanningAndBacklog(backlogText: string) {
  runWorkflowAgentOnSession
    .mockResolvedValueOnce(workflowRun(approvedBrainstormingDraft(), "brainstorm-draft"))
    .mockResolvedValueOnce(
      workflowRun(
        "VERDICT: APPROVE\nREASON:\n- Good enough\nGAPS:\n- none\nREVISION_REQUEST:\n- none",
        "brainstorm-review",
      ),
    )
    .mockResolvedValueOnce(workflowRun("# Specs\n\nConcrete product spec", "specs-draft"))
    .mockResolvedValueOnce(
      workflowRun(
        "VERDICT: APPROVE\nREASON:\n- Ready for PRD\nGAPS:\n- none\nREVISION_REQUEST:\n- none",
        "specs-review",
      ),
    )
    .mockResolvedValueOnce(workflowRun("# PRD\n\nConcrete product requirements", "prd-draft"))
    .mockResolvedValueOnce(
      workflowRun(
        "VERDICT: APPROVE\nREASON:\n- Ready for execution\nGAPS:\n- none\nREVISION_REQUEST:\n- none",
        "prd-review",
      ),
    )
    .mockResolvedValueOnce(workflowRun(backlogText, "story-backlog"));
}

type SingleGitScenario = {
  repoRoot?: string | null;
  absoluteGitDir?: string | null;
  gitCommonDir?: string | null;
  isInsideWorkTree?: string | null;
  status?: string;
  stagedDiffStat?: string;
  workingTreeDiffStat?: string;
  stagedNameOnly?: string;
  workingTreeNameOnly?: string;
};

function mockGitEvidence(
  params: {
    byCwd?: Record<string, SingleGitScenario>;
    defaultScenario?: SingleGitScenario;
    initFailureTargets?: string[];
  } = {},
) {
  execFileSync.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe("git");
    if (args[0] === "init") {
      const target = String(args[1]);
      if (params.initFailureTargets?.includes(target)) {
        throw new Error("git init failed");
      }
      return `Initialized empty Git repository in ${target}/.git/`;
    }
    expect(args[0]).toBe("-C");
    const cwd = String(args[1]);
    const joined = args.slice(2).join(" ");
    const scenario = params.byCwd?.[cwd] ?? params.defaultScenario ?? {};
    if (joined === "rev-parse --show-toplevel") {
      if (scenario.repoRoot === null) {
        throw new Error("fatal: not a git repository");
      }
      return scenario.repoRoot ?? cwd;
    }
    if (joined === "rev-parse --is-inside-work-tree") {
      if (scenario.isInsideWorkTree === null) {
        throw new Error("fatal: not a git repository");
      }
      return scenario.isInsideWorkTree ?? "true";
    }
    if (joined === "rev-parse --absolute-git-dir") {
      if (scenario.absoluteGitDir === null) {
        throw new Error("fatal: not a git repository");
      }
      return scenario.absoluteGitDir ?? `${cwd}/.git`;
    }
    if (joined === "rev-parse --path-format=absolute --git-common-dir") {
      if (scenario.gitCommonDir === null) {
        throw new Error("fatal: no common dir");
      }
      return scenario.gitCommonDir ?? `${cwd}/.git`;
    }
    if (joined === "rev-parse --git-common-dir") {
      if (scenario.gitCommonDir === null) {
        throw new Error("fatal: no common dir");
      }
      return scenario.gitCommonDir ?? ".git";
    }
    if (joined === "status --short") {
      return scenario.status ?? "";
    }
    if (joined === "diff --stat --cached --find-renames") {
      return scenario.stagedDiffStat ?? "";
    }
    if (joined === "diff --stat --find-renames") {
      return scenario.workingTreeDiffStat ?? "";
    }
    if (joined === "diff --name-only --cached --find-renames") {
      return scenario.stagedNameOnly ?? "";
    }
    if (joined === "diff --name-only --find-renames") {
      return scenario.workingTreeNameOnly ?? "";
    }
    throw new Error(`Unexpected git command: ${joined}`);
  });
}

function getArtifactContents(name: string): string[] {
  return writeWorkflowArtifact.mock.calls
    .filter((call) => String(call[1]) === name)
    .map((call) => String(call[2]));
}

function getLastArtifactContent(name: string): string {
  const contents = getArtifactContents(name);
  expect(contents.length).toBeGreaterThan(0);
  return contents.at(-1) ?? "";
}

describe("self_ralph module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statSync.mockImplementation((target: string) => {
      if (
        target === "/repo" ||
        target === "/workspace" ||
        target === "/repo-file" ||
        target === "/repo-existing"
      ) {
        return {
          isDirectory: () => target !== "/repo-file",
        };
      }
      if (target.startsWith("/repo/")) {
        return {
          isDirectory: () => true,
        };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${target}'`);
    });
    accessSync.mockImplementation(() => {});
    mkdirSync.mockImplementation(() => undefined);
    writeFileSync.mockImplementation(() => undefined);
    ensureWorkflowSessions.mockImplementation(
      async (params: {
        runId: string;
        specs: Array<{
          role: "worker" | "critic" | "orchestrator";
          agentId: string;
          name?: string;
        }>;
      }) => {
        const sessions: Record<string, string> = {};
        for (const spec of params.specs) {
          sessions[spec.role] =
            `agent:${spec.agentId}:workflow:${params.runId}:${spec.role}:${spec.name ?? "main"}`;
        }
        return sessions;
      },
    );
    writeWorkflowArtifact.mockImplementation((runId: string, name: string) => `${runId}/${name}`);
    mockGitEvidence();
  });

  it("is registered with the ideation-first manifest contract", async () => {
    const { listWorkflowModuleManifests, describeWorkflowModule } = await import("../index.js");

    const moduleIds = listWorkflowModuleManifests().map((entry) => entry.moduleId);
    expect(moduleIds).toContain("self_ralph");

    const manifest = describeWorkflowModule("self_ralph");
    expect(manifest.moduleId).toBe("self_ralph");
    expect(manifest.requiredAgents).toEqual(["codex", "codex-controller"]);
    expect(manifest.terminalStates).toContain("planning_done");
    expect(manifest.description).toContain("ideation-first");
  });

  it("rejects missing direction", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            workingDirectory: "/workspace",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow("self_ralph benötigt ein nicht-leeres Feld `direction`.");
  });

  it("rejects invalid executionMode", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
            workingDirectory: "/workspace",
            executionMode: "invalid_mode",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "self_ralph benötigt für `input.executionMode` einen der Werte `plan_only`, `existing_repo` oder `bootstrap_project`.",
    );
  });

  it("rejects missing workingDirectory", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow("self_ralph benötigt `input.workingDirectory` als Workspace-Root.");
  });

  it("rejects a non-existent workingDirectory before normal workflow execution", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
            workingDirectory: "/missing",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "self_ralph benötigt für `input.workingDirectory` ein existierendes Verzeichnis.",
    );
    expect(ensureWorkflowSessions).not.toHaveBeenCalled();
    expect(runWorkflowAgentOnSession).not.toHaveBeenCalled();
  });

  it("rejects a file workingDirectory before normal workflow execution", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
            workingDirectory: "/repo-file",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "self_ralph benötigt für `input.workingDirectory` ein Verzeichnis statt einer Datei.",
    );
    expect(ensureWorkflowSessions).not.toHaveBeenCalled();
  });

  it("completes plan_only without requiring a git repo and persists planning state", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    queueApprovedPlanningAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "Bootstrap the MVP shell",
              task: "Create the initial project shell.",
              acceptanceCriteria: ["Project shell exists"],
            },
          ],
        },
        null,
        2,
      ),
    );

    const record = await selfRalphWorkflowModule.start(
      {
        input: {
          direction: "Erstelle eine Social Media App",
          workingDirectory: "/workspace",
          executionMode: "plan_only",
          maxBrainstormingRounds: 1,
          maxSpecsRounds: 1,
          maxPRDRounds: 1,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("planning_done");
    expect(record.terminalReason).toBe("Planning completed without execution.");
    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(7);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(getLastArtifactContent("brainstorming-round-1-prompt.md")).toContain(
      "Develop 3 to 5 distinct product concepts from the broad direction before narrowing.",
    );
    expect(getLastArtifactContent("brainstorming-options.json")).toContain(
      '"selectedConcept": "Orbit Stream"',
    );
    const executionState = JSON.parse(getLastArtifactContent("execution-state.json")) as {
      status: string;
      planningStatus: string;
      selectedConcept: string | null;
      executionMode: string;
      activeStoryId: string | null;
    };
    expect(executionState).toMatchObject({
      status: "planning_done",
      planningStatus: "planning_done",
      selectedConcept: "Orbit Stream",
      executionMode: "plan_only",
      activeStoryId: "story-1",
    });
  });

  it("defers existing_repo validation until after planning and then fails cleanly without repoRoot", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    queueApprovedPlanningAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "Implement the feed",
              task: "Build the first feed slice.",
              acceptanceCriteria: ["Feed exists"],
            },
          ],
        },
        null,
        2,
      ),
    );

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
            workingDirectory: "/workspace",
            executionMode: "existing_repo",
            maxBrainstormingRounds: 1,
            maxSpecsRounds: 1,
            maxPRDRounds: 1,
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "self_ralph benötigt `input.repoRoot` bei `executionMode=existing_repo` vor Execution-Beginn.",
    );
    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(7);
  });

  it("uses existing_repo execution against repoRoot while keeping workingDirectory as workspace root", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    mockGitEvidence({
      byCwd: {
        "/repo-existing": {
          repoRoot: "/repo-existing",
          status: " M src/module.ts\n?? src/module.test.ts\n",
          stagedDiffStat: " src/module.ts | 4 ++--\n",
          workingTreeDiffStat: " src/module.test.ts | 12 ++++++++++++\n",
          stagedNameOnly: "src/module.ts\n",
          workingTreeNameOnly: "src/module.test.ts\n",
        },
      },
    });
    queueApprovedPlanningAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "Implement workflow registration",
              task: "Add the module and wire it into the registry.",
              acceptanceCriteria: ["Module is registered", "CLI surfaces list it"],
            },
          ],
        },
        null,
        2,
      ),
    );
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(
        workflowRun(
          [
            "Changed `src/module.ts` and added tests.",
            "- Ran vitest self-ralph",
            "- Verification is still missing around registry wiring",
          ].join("\n"),
          "exec-1-worker",
        ),
      )
      .mockResolvedValueOnce(
        workflowRun(
          [
            "DECISION: CONTINUE",
            "REASON:",
            "- Wiring exists but verification is still missing.",
            "LEARNINGS:",
            "- Keep the first story narrow and verifiable.",
            "NEXT_TASK:",
            "- Run the focused verification and tighten any failing wiring.",
          ].join("\n"),
          "exec-1-review",
        ),
      )
      .mockResolvedValueOnce(
        workflowRun(
          [
            "Updated registry wiring and ran focused verification successfully.",
            "- Ran vitest self-ralph",
          ].join("\n"),
          "exec-2-worker",
        ),
      )
      .mockResolvedValueOnce(
        workflowRun(
          [
            "DECISION: DONE",
            "REASON:",
            "- The story is complete and verified.",
            "LEARNINGS:",
            "- Fresh workers kept the loop focused.",
            "NEXT_TASK:",
            "- none",
          ].join("\n"),
          "exec-2-review",
        ),
      );

    const record = await selfRalphWorkflowModule.start(
      {
        input: {
          direction: "Erstelle eine Social Media App",
          workingDirectory: "/workspace",
          executionMode: "existing_repo",
          repoRoot: "/repo-existing",
          maxBrainstormingRounds: 1,
          maxSpecsRounds: 1,
          maxPRDRounds: 1,
          maxExecutionRounds: 2,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(record.terminalReason).toBe("All stories completed.");
    expect(record.currentRound).toBe(5);
    expect(runWorkflowAgentOnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:codex:workflow:run-1:worker:execution-worker-story-1-attempt-1",
        workspaceDir: "/repo-existing",
      }),
    );
    expect(runWorkflowAgentOnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:codex:workflow:run-1:worker:execution-worker-story-1-attempt-2",
        workspaceDir: "/repo-existing",
      }),
    );
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).toContain(
      "workspace_root=/workspace",
    );
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).toContain(
      "execution_workspace=/repo-existing",
    );
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).toContain(
      "linked_worktree=no",
    );
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).toContain(
      "working_tree: src/module.test.ts | 12 ++++++++++++",
    );
    const executionState = JSON.parse(getLastArtifactContent("execution-state.json")) as {
      status: string;
      repoRoot?: string;
      selectedConcept: string | null;
      stories: Array<{ status: string; lastDecision: string | null; lastRound: number | null }>;
    };
    expect(executionState).toMatchObject({
      status: "done",
      repoRoot: "/repo-existing",
      selectedConcept: "Orbit Stream",
    });
    expect(executionState.stories).toEqual([
      expect.objectContaining({
        status: "done",
        lastDecision: "DONE",
        lastRound: 2,
      }),
    ]);
  });

  it("persists and reuses long worker outputs without injecting truncation markers", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    mockGitEvidence({
      byCwd: {
        "/repo-existing": {
          repoRoot: "/repo-existing",
        },
      },
    });
    queueApprovedPlanningAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "Long output story",
              task: "Produce a large evidence-heavy update.",
              acceptanceCriteria: ["Full evidence is preserved"],
            },
          ],
        },
        null,
        2,
      ),
    );
    const longWorkerOutput = ["ROUND 10", "TAIL_MARKER", "A".repeat(20_000)].join("\n");
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(workflowRun(longWorkerOutput, "exec-1-worker"))
      .mockResolvedValueOnce(
        workflowRun(
          [
            "DECISION: DONE",
            "REASON:",
            "- The full worker evidence is available.",
            "LEARNINGS:",
            "- Preserve machine-faithful worker outputs across rounds.",
            "NEXT_TASK:",
            "- none",
          ].join("\n"),
          "exec-1-review",
        ),
      );

    const record = await selfRalphWorkflowModule.start(
      {
        input: {
          direction: "Erstelle eine Social Media App",
          workingDirectory: "/workspace",
          executionMode: "existing_repo",
          repoRoot: "/repo-existing",
          maxBrainstormingRounds: 1,
          maxSpecsRounds: 1,
          maxPRDRounds: 1,
          maxExecutionRounds: 1,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(getLastArtifactContent("execution-round-1-worker.txt")).toBe(longWorkerOutput);
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).toContain("TAIL_MARKER");
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).not.toContain(
      "...(truncated)...",
    );
  });

  it("bootstraps a fresh project repo under workingDirectory before execution", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    mockGitEvidence({
      byCwd: {
        "/repo/orbit-stream": {
          repoRoot: "/repo/orbit-stream",
        },
      },
    });
    queueApprovedPlanningAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "Create the first app shell",
              task: "Scaffold the first app shell.",
              acceptanceCriteria: ["Shell exists"],
            },
          ],
        },
        null,
        2,
      ),
    );
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(
        workflowRun("Created the app shell.\n- Ran smoke check", "exec-1-worker"),
      )
      .mockResolvedValueOnce(
        workflowRun(
          [
            "DECISION: DONE",
            "REASON:",
            "- The first story is complete.",
            "LEARNINGS:",
            "- Fresh bootstrap repos keep the workspace organized.",
            "NEXT_TASK:",
            "- none",
          ].join("\n"),
          "exec-1-review",
        ),
      );

    const record = await selfRalphWorkflowModule.start(
      {
        input: {
          direction: "Erstelle eine Social Media App",
          workingDirectory: "/repo",
          executionMode: "bootstrap_project",
          bootstrapTemplate: "tanstack-start",
          maxBrainstormingRounds: 1,
          maxSpecsRounds: 1,
          maxPRDRounds: 1,
          maxExecutionRounds: 1,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["init", "/repo/orbit-stream"],
      expect.objectContaining({
        encoding: "utf8",
      }),
    );
    expect(runWorkflowAgentOnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/repo/orbit-stream",
      }),
    );
    expect(getLastArtifactContent("project-bootstrap.json")).toContain(
      '"projectSlug": "orbit-stream"',
    );
    expect(getLastArtifactContent("project-bootstrap.json")).toContain(
      '"bootstrapTemplate": "tanstack-start"',
    );
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).toContain(
      "bootstrap_target_path=/repo/orbit-stream",
    );
  });

  it("returns blocked when a planning review blocks the workflow", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    runWorkflowAgentOnSession
      .mockResolvedValueOnce(workflowRun(approvedBrainstormingDraft(), "brainstorm-draft"))
      .mockResolvedValueOnce(
        workflowRun(
          [
            "VERDICT: BLOCK",
            "REASON:",
            "- The direction conflicts with a hard constraint.",
            "GAPS:",
            "- none",
            "REVISION_REQUEST:",
            "- none",
          ].join("\n"),
          "brainstorm-review",
        ),
      );

    const record = await selfRalphWorkflowModule.start(
      {
        input: {
          direction: "Erstelle eine Social Media App",
          workingDirectory: "/workspace",
          maxBrainstormingRounds: 1,
          maxSpecsRounds: 1,
          maxPRDRounds: 1,
          maxExecutionRounds: 1,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("blocked");
    expect(record.terminalReason).toBe(
      "brainstorming blocked: The direction conflicts with a hard constraint.",
    );
    expect(getArtifactContents("story-backlog.json")).toEqual([]);
  });

  it("decouples backlog scope from execution rounds and supports explicit maxStories", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    mockGitEvidence({
      byCwd: {
        "/repo-existing": {
          repoRoot: "/repo-existing",
        },
      },
    });
    queueApprovedPlanningAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "First story",
              task: "Finish the first story.",
              acceptanceCriteria: ["Story one is complete"],
            },
            {
              id: "story-2",
              title: "Second story",
              task: "Finish the second story.",
              acceptanceCriteria: ["Story two is complete"],
            },
          ],
        },
        null,
        2,
      ),
    );
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(workflowRun("Finished the first story.", "exec-1-worker"))
      .mockResolvedValueOnce(
        workflowRun(
          [
            "DECISION: DONE",
            "REASON:",
            "- Story one is complete.",
            "LEARNINGS:",
            "- Keep stories ordered.",
            "NEXT_TASK:",
            "- none",
          ].join("\n"),
          "exec-1-review",
        ),
      );

    const record = await selfRalphWorkflowModule.start(
      {
        input: {
          direction: "Erstelle eine Social Media App",
          workingDirectory: "/workspace",
          executionMode: "existing_repo",
          repoRoot: "/repo-existing",
          maxBrainstormingRounds: 1,
          maxSpecsRounds: 1,
          maxPRDRounds: 1,
          maxExecutionRounds: 1,
          maxStories: 2,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("max_rounds_reached");
    expect(record.terminalReason).toBe("Execution budget exhausted with remaining story story-2.");
    expect(getLastArtifactContent("story-backlog-prompt.md")).toContain(
      "Return JSON only with at most 2 stories.",
    );
    const executionState = JSON.parse(getLastArtifactContent("execution-state.json")) as {
      status: string;
      activeStoryId: string | null;
      nextTask: string | null;
      stories: Array<{ id: string; status: string }>;
    };
    expect(executionState).toMatchObject({
      status: "max_rounds_reached",
      activeStoryId: "story-2",
      nextTask: "Finish the second story.",
    });
    expect(executionState.stories).toEqual([
      expect.objectContaining({ id: "story-1", status: "done" }),
      expect.objectContaining({ id: "story-2", status: "open" }),
    ]);
  });

  it("fails fast on malformed execution reviewer output", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    mockGitEvidence({
      byCwd: {
        "/repo-existing": {
          repoRoot: "/repo-existing",
        },
      },
    });
    queueApprovedPlanningAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "Only story",
              task: "Do the work.",
              acceptanceCriteria: ["Done"],
            },
          ],
        },
        null,
        2,
      ),
    );
    runWorkflowAgentOnSession
      .mockResolvedValueOnce(workflowRun("Worker summary", "exec-1-worker"))
      .mockResolvedValueOnce(workflowRun("Maybe done?", "exec-1-review"));

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
            workingDirectory: "/workspace",
            executionMode: "existing_repo",
            repoRoot: "/repo-existing",
            maxBrainstormingRounds: 1,
            maxSpecsRounds: 1,
            maxPRDRounds: 1,
            maxExecutionRounds: 1,
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow(
      "self_ralph execution review unparsbar. Erwartet wurde 'DECISION: DONE|CONTINUE|BLOCKED'.",
    );
  });

  it("fails fast on malformed backlog output", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    queueApprovedPlanningAndBacklog("not json at all");

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
            workingDirectory: "/workspace",
            executionMode: "plan_only",
            maxBrainstormingRounds: 1,
            maxSpecsRounds: 1,
            maxPRDRounds: 1,
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow("self_ralph story backlog unparsbar. JSON fehlt.");
  });

  it("stops after an abort request before starting review follow-up work", async () => {
    const { selfRalphWorkflowModule } = await import("./self-ralph.js");

    const abortController = new AbortController();
    runWorkflowAgentOnSession.mockImplementationOnce(async () => {
      abortController.abort(new Error("Abort requested by operator."));
      return workflowRun(approvedBrainstormingDraft(), "brainstorm-draft");
    });

    await expect(
      selfRalphWorkflowModule.start(
        {
          input: {
            direction: "Erstelle eine Social Media App",
            workingDirectory: "/workspace",
            executionMode: "plan_only",
            maxBrainstormingRounds: 1,
            maxSpecsRounds: 1,
            maxPRDRounds: 1,
          },
        },
        createModuleContext("run-1", abortController),
      ),
    ).rejects.toThrow("Abort requested by operator.");
    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(1);
    expect(runWorkflowAgentOnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });
});
