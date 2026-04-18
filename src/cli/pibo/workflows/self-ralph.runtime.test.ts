import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureWorkflowSessions, runWorkflowAgentOnSession, emitTracedWorkflowReportEvent } =
  vi.hoisted(() => ({
    ensureWorkflowSessions: vi.fn(),
    runWorkflowAgentOnSession: vi.fn(),
    emitTracedWorkflowReportEvent: vi.fn(async () => ({ attempted: true, delivered: true })),
  }));

vi.mock("./workflow-session-helper.js", () => ({
  ensureWorkflowSessions,
}));

vi.mock("./agent-runtime.js", () => ({
  runWorkflowAgentOnSession,
}));

vi.mock("./workflow-reporting.js", () => ({
  emitTracedWorkflowReportEvent,
}));

import {
  describeWorkflowModule,
  getWorkflowProgress,
  listWorkflowArtifacts,
  listWorkflowModuleManifests,
  readWorkflowArtifact,
  startWorkflowRun,
  startWorkflowRunAsync,
  waitForWorkflowRun,
} from "./index.js";

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

describe("self_ralph runtime integration", () => {
  let tempHome = "";
  let repoDir = "";
  let workspaceDir = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-self-ralph-runtime-home-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-self-ralph-runtime-repo-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-self-ralph-runtime-workspace-"));
    process.env.HOME = tempHome;
    execFileSync("git", ["init", repoDir], { stdio: "ignore" });
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
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("describes, starts, and exposes self_ralph lifecycle artifacts through the runtime surface", async () => {
    const moduleIds = listWorkflowModuleManifests().map((entry) => entry.moduleId);
    expect(moduleIds).toContain("self_ralph");

    const manifest = describeWorkflowModule("self_ralph");
    expect(manifest.moduleId).toBe("self_ralph");
    expect(manifest.requiredAgents).toEqual(["codex", "codex-controller"]);
    expect(manifest.terminalStates).toContain("planning_done");

    queueApprovedPlanningAndBacklog(
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
            "- Ran `pnpm vitest src/cli/pibo/workflows/self-ralph.runtime.test.ts`",
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
            "- Preserve runtime-surface coverage for workflow modules.",
            "NEXT_TASK:",
            "- none",
          ].join("\n"),
          "exec-1-review",
        ),
      );

    const record = await startWorkflowRun("self_ralph", {
      input: {
        direction: "Erstelle eine Social Media App",
        workingDirectory: workspaceDir,
        executionMode: "existing_repo",
        repoRoot: repoDir,
        maxBrainstormingRounds: 1,
        maxSpecsRounds: 1,
        maxPRDRounds: 1,
        maxExecutionRounds: 1,
      },
    });

    expect(record.moduleId).toBe("self_ralph");
    expect(record.status).toBe("done");
    expect(record.terminalReason).toBe("All stories completed.");

    const wait = await waitForWorkflowRun(record.runId, 500);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("done");

    const artifacts = listWorkflowArtifacts(record.runId).map((artifact) => artifact.name);
    expect(artifacts).toEqual(
      expect.arrayContaining([
        "brainstorming-final.md",
        "brainstorming-options.json",
        "specs-final.md",
        "prd-final.md",
        "story-backlog.json",
        "execution-round-1-evidence.json",
        "execution-state.json",
        "run-summary.txt",
      ]),
    );

    const evidence = JSON.parse(
      readWorkflowArtifact(record.runId, "execution-round-1-evidence.json").content,
    ) as {
      repoContext: {
        workspaceRoot: string;
        executionWorkspace: string;
        repoRoot: string;
        executionMode: string;
        linkedWorktree: boolean;
      };
      verification: Array<{ kind: string; source: string }>;
    };
    expect(evidence.repoContext).toMatchObject({
      workspaceRoot: workspaceDir,
      executionWorkspace: repoDir,
      repoRoot: repoDir,
      executionMode: "existing_repo",
      linkedWorktree: false,
    });
    expect(evidence.verification).toEqual([
      expect.objectContaining({
        kind: "test",
        source: "worker_output",
      }),
    ]);

    const executionState = JSON.parse(
      readWorkflowArtifact(record.runId, "execution-state.json").content,
    ) as {
      status: string;
      executionMode: string;
      selectedConcept: string | null;
      repoRoot?: string;
      stories: Array<{ id: string; status: string }>;
    };
    expect(executionState).toMatchObject({
      status: "done",
      executionMode: "existing_repo",
      selectedConcept: "Orbit Stream",
      repoRoot: repoDir,
    });
    expect(executionState.stories).toEqual([
      expect.objectContaining({
        id: "story-1",
        status: "done",
      }),
    ]);

    const workspaceArtifactsDir = path.join(workspaceDir, "self-ralph");
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "brainstorming-final.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "specs-final.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "prd-final.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "story-backlog.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "execution-state.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "execution-round-1-evidence.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "run-summary.txt"))).toBe(true);

    const progress = getWorkflowProgress(record.runId);
    expect(progress).toMatchObject({
      runId: record.runId,
      moduleId: "self_ralph",
      status: "done",
      isTerminal: true,
      lastEventKind: "run_completed",
    });
  });

  it("supports plan_only as a clean terminal outcome without an existing git repo", async () => {
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

    const record = await startWorkflowRun("self_ralph", {
      input: {
        direction: "Erstelle eine Social Media App",
        workingDirectory: workspaceDir,
        executionMode: "plan_only",
        maxBrainstormingRounds: 1,
        maxSpecsRounds: 1,
        maxPRDRounds: 1,
      },
    });

    expect(record.status).toBe("planning_done");
    expect(record.terminalReason).toBe("Planning completed without execution.");

    const executionState = JSON.parse(
      readWorkflowArtifact(record.runId, "execution-state.json").content,
    ) as {
      status: string;
      planningStatus: string;
      executionMode: string;
      activeStoryId: string | null;
    };
    expect(executionState).toMatchObject({
      status: "planning_done",
      planningStatus: "planning_done",
      executionMode: "plan_only",
      activeStoryId: "story-1",
    });

    const workspaceArtifactsDir = path.join(workspaceDir, "self-ralph");
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "brainstorming-final.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "story-backlog.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceArtifactsDir, "run-summary.txt"))).toBe(true);
  });

  it("fails async start cleanly for an invalid self_ralph workingDirectory", async () => {
    const invalidPath = path.join(workspaceDir, "missing");

    const initial = await startWorkflowRunAsync("self_ralph", {
      input: {
        direction: "Erstelle eine Social Media App",
        workingDirectory: invalidPath,
      },
    });

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("failed");
    expect(wait.run?.terminalReason).toContain(
      "self_ralph benötigt für `input.workingDirectory` ein existierendes Verzeichnis.",
    );
    expect(listWorkflowArtifacts(initial.runId).map((artifact) => artifact.name)).toEqual([
      "trace.jsonl",
      "trace.summary.json",
    ]);
    expect(ensureWorkflowSessions).not.toHaveBeenCalled();
  });
});
