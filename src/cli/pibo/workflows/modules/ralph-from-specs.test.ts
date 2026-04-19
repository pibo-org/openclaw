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
    moduleId: "ralph_from_specs",
    level: 1,
    emit: traceEmit,
    attachToRunRecord: (record: WorkflowRunRecord) => record,
    getRef: () => ({
      version: "v1",
      level: 1,
      eventLogPath: `/tmp/${runId}.trace.jsonl`,
      summaryPath: `/tmp/${runId}.trace.summary.json`,
      eventCount: 0,
      updatedAt: "2026-04-19T00:00:00.000Z",
    }),
    getSummary: () =>
      ({
        runId,
        moduleId: "ralph_from_specs",
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
    nowIso: () => "2026-04-19T00:00:00.000Z",
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

function queueApprovedPRDAndBacklog(backlogText: string) {
  runWorkflowAgentOnSession
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

describe("ralph_from_specs module", () => {
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

  it("is registered with the specs-first manifest contract", async () => {
    const { listWorkflowModuleManifests, describeWorkflowModule } = await import("../index.js");

    const moduleIds = listWorkflowModuleManifests().map((entry) => entry.moduleId);
    expect(moduleIds).toContain("ralph_from_specs");

    const manifest = describeWorkflowModule("ralph_from_specs");
    expect(manifest.moduleId).toBe("ralph_from_specs");
    expect(manifest.requiredAgents).toEqual(["codex", "codex-controller"]);
    expect(manifest.terminalStates).toContain("planning_done");
    expect(manifest.description).toContain("trusted approved specs");
  });

  it("rejects missing specs", async () => {
    const { ralphFromSpecsWorkflowModule } = await import("./ralph-from-specs.js");

    await expect(
      ralphFromSpecsWorkflowModule.start(
        {
          input: {
            workingDirectory: "/workspace",
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow("ralph_from_specs benötigt ein nicht-leeres Feld `specs`.");
  });

  it("goes straight from trusted specs into the shared planning core without a specs review gate", async () => {
    const { ralphFromSpecsWorkflowModule } = await import("./ralph-from-specs.js");

    queueApprovedPRDAndBacklog(
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

    const record = await ralphFromSpecsWorkflowModule.start(
      {
        input: {
          specs: "# Specs\n\nTrusted approved product spec",
          selectedConcept: "Orbit Stream",
          workingDirectory: "/workspace",
          executionMode: "plan_only",
          maxPRDRounds: 1,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("planning_done");
    expect(record.terminalReason).toBe("Planning completed without execution.");
    expect(runWorkflowAgentOnSession).toHaveBeenCalledTimes(3);
    expect(getArtifactContents("brainstorming-final.md")).toEqual([]);
    expect(getLastArtifactContent("specs-final.md")).toBe(
      "# Specs\n\nTrusted approved product spec",
    );
    expect(getLastArtifactContent("prd-round-1-prompt.md")).toContain(
      "APPROVED_BRAINSTORMING:\nnone",
    );
    expect(getLastArtifactContent("prd-round-1-prompt.md")).toContain(
      "APPROVED_SPECS:\n# Specs\n\nTrusted approved product spec",
    );
    const executionState = JSON.parse(getLastArtifactContent("execution-state.json")) as {
      status: string;
      planningStatus: string;
      selectedConcept: string | null;
      brainstormingOptions: string[];
    };
    expect(executionState).toMatchObject({
      status: "planning_done",
      planningStatus: "planning_done",
      selectedConcept: "Orbit Stream",
    });
    expect(executionState.brainstormingOptions).toEqual([]);
  });

  it("runs the shared execution path against existing_repo without requiring brainstorming context", async () => {
    const { ralphFromSpecsWorkflowModule } = await import("./ralph-from-specs.js");

    mockGitEvidence({
      byCwd: {
        "/repo-existing": {
          repoRoot: "/repo-existing",
          status: " M src/module.ts\n",
          stagedDiffStat: " src/module.ts | 4 ++--\n",
          stagedNameOnly: "src/module.ts\n",
        },
      },
    });
    queueApprovedPRDAndBacklog(
      JSON.stringify(
        {
          stories: [
            {
              id: "story-1",
              title: "Implement workflow registration",
              task: "Add the module and wire it into the registry.",
              acceptanceCriteria: ["Module is registered"],
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
            "Updated the workflow registration.",
            "- Ran `pnpm vitest src/cli/pibo/workflows/modules/ralph-from-specs.test.ts`",
          ].join("\n"),
          "exec-1-worker",
        ),
      )
      .mockResolvedValueOnce(
        workflowRun(
          [
            "DECISION: DONE",
            "REASON:",
            "- The story is complete enough to move on.",
            "LEARNINGS:",
            "- Shared execution should tolerate absent brainstorming context.",
            "NEXT_TASK:",
            "- none",
          ].join("\n"),
          "exec-1-review",
        ),
      );

    const record = await ralphFromSpecsWorkflowModule.start(
      {
        input: {
          specs: "# Specs\n\nTrusted approved product spec",
          direction: "Social media app",
          workingDirectory: "/workspace",
          executionMode: "existing_repo",
          repoRoot: "/repo-existing",
          maxPRDRounds: 1,
          maxExecutionRounds: 1,
        },
      },
      createModuleContext("run-1"),
    );

    expect(record.status).toBe("done");
    expect(getLastArtifactContent("execution-round-1-worker-prompt.md")).toContain(
      "APPROVED_BRAINSTORMING:\nnone",
    );
    expect(getLastArtifactContent("execution-round-1-review-prompt.md")).toContain(
      "execution_workspace=/repo-existing",
    );
    expect(getLastArtifactContent("execution-state.json")).toContain(
      '"repoRoot": "/repo-existing"',
    );
  });

  it("fails fast on malformed backlog output", async () => {
    const { ralphFromSpecsWorkflowModule } = await import("./ralph-from-specs.js");

    queueApprovedPRDAndBacklog("not json at all");

    await expect(
      ralphFromSpecsWorkflowModule.start(
        {
          input: {
            specs: "# Specs\n\nTrusted approved product spec",
            workingDirectory: "/workspace",
            executionMode: "plan_only",
            maxPRDRounds: 1,
          },
        },
        createModuleContext("run-1"),
      ),
    ).rejects.toThrow("ralph_from_specs story backlog unparsbar. JSON fehlt.");
  });
});
