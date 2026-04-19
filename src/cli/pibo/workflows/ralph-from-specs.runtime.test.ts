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
  listWorkflowArtifacts,
  listWorkflowModuleManifests,
  readWorkflowArtifact,
  startWorkflowRun,
} from "./index.js";

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

describe("ralph_from_specs runtime integration", () => {
  let tempHome = "";
  let repoDir = "";
  let workspaceDir = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ralph-from-specs-runtime-home-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ralph-from-specs-runtime-repo-"));
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-ralph-from-specs-runtime-workspace-"),
    );
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

  it("describes, starts, and exposes ralph_from_specs lifecycle artifacts through the runtime surface", async () => {
    const moduleIds = listWorkflowModuleManifests().map((entry) => entry.moduleId);
    expect(moduleIds).toContain("ralph_from_specs");

    const manifest = describeWorkflowModule("ralph_from_specs");
    expect(manifest.moduleId).toBe("ralph_from_specs");
    expect(manifest.requiredAgents).toEqual(["codex", "codex-controller"]);
    expect(manifest.terminalStates).toContain("planning_done");

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
            "- Ran `pnpm vitest src/cli/pibo/workflows/ralph-from-specs.runtime.test.ts`",
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
            "- Preserve runtime-surface coverage for specs-first workflow modules.",
            "NEXT_TASK:",
            "- none",
          ].join("\n"),
          "exec-1-review",
        ),
      );

    const record = await startWorkflowRun("ralph_from_specs", {
      input: {
        specs: "# Specs\n\nTrusted approved product spec",
        direction: "Social media app",
        workingDirectory: workspaceDir,
        executionMode: "existing_repo",
        repoRoot: repoDir,
        maxPRDRounds: 1,
        maxExecutionRounds: 1,
      },
    });

    expect(record.moduleId).toBe("ralph_from_specs");
    expect(record.status).toBe("done");
    expect(record.terminalReason).toBe("All stories completed.");

    const artifacts = listWorkflowArtifacts(record.runId).map((artifact) => artifact.name);
    expect(artifacts).toEqual(
      expect.arrayContaining([
        "specs-final.md",
        "prd-final.md",
        "story-backlog.json",
        "execution-round-1-evidence.json",
        "execution-state.json",
        "run-summary.txt",
      ]),
    );
    expect(artifacts).not.toContain("brainstorming-final.md");

    const specsArtifact = readWorkflowArtifact(record.runId, "specs-final.md").content;
    expect(specsArtifact).toBe("# Specs\n\nTrusted approved product spec");
  });
});
