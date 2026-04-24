import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findWorkflowWorktreeBindingByPath,
  findWorkflowWorktreeSentinelByPath,
  listWorkflowWorktreeBindings,
  readWorkflowWorktreeBinding,
  workflowWorktreeBindingPath,
  writeRunRecord,
  writeWorkflowWorktreeBinding,
  writeWorkflowWorktreeSentinelFile,
} from "./store.js";
import type { WorkflowRunRecord, WorkflowWorktreeBinding } from "./types.js";
import { inspectWorkflowWorktreeOwner } from "./worktree-owner.js";

function buildRun(overrides: Partial<WorkflowRunRecord> & Pick<WorkflowRunRecord, "runId">) {
  const { runId, ...rest } = overrides;
  return {
    runId,
    moduleId: overrides.moduleId ?? "codex_controller",
    status: overrides.status ?? "running",
    terminalReason: null,
    abortRequested: false,
    abortRequestedAt: null,
    currentRound: 0,
    maxRounds: null,
    input: {},
    artifacts: [],
    sessions: {},
    latestWorkerOutput: null,
    latestCriticVerdict: null,
    originalTask: null,
    currentTask: null,
    createdAt: overrides.createdAt ?? "2026-04-24T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-24T00:00:00.000Z",
    ...rest,
  } satisfies WorkflowRunRecord;
}

function buildBinding(
  overrides: Partial<WorkflowWorktreeBinding> & Pick<WorkflowWorktreeBinding, "runId">,
) {
  const { runId, ...rest } = overrides;
  return {
    version: 1,
    runId,
    moduleId: "codex_controller",
    status: "active",
    sourceRepoRoot: "/repo",
    requestedWorkingDirectory: "/repo",
    worktreePath: `/worktrees/${runId}/worktree`,
    integrationWorktreePath: `/worktrees/${runId}/integration`,
    managedBranch: `pibo/workflows/codex_controller/${runId}`,
    recoveryRef: `refs/pibo/workflows/codex_controller/${runId}/worker-head`,
    integrationTargetBranch: "main",
    workerHead: null,
    integratedHead: null,
    cleanupPolicy: "remove_after_success",
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    ...rest,
  } satisfies WorkflowWorktreeBinding;
}

describe("workflow store worktree bindings", () => {
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worktree-store-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("writes, reads, lists, and resolves bindings by nested path", () => {
    const binding = buildBinding({ runId: "run-1" });
    writeWorkflowWorktreeBinding(binding);

    expect(workflowWorktreeBindingPath("run-1")).toContain("worktree-bindings/run-1.json");
    expect(readWorkflowWorktreeBinding("run-1")).toEqual(binding);
    expect(listWorkflowWorktreeBindings()).toEqual(expect.arrayContaining([binding]));
    expect(findWorkflowWorktreeBindingByPath("/worktrees/run-1/worktree/src/index.ts")).toEqual(
      binding,
    );
    expect(findWorkflowWorktreeBindingByPath("/worktrees/run-1/integration")).toEqual(binding);
  });

  it("classifies current, foreign active, terminal, unknown, and non-workflow paths", () => {
    const active = buildBinding({
      runId: "active-run",
      worktreePath: path.join(tempHome, "active"),
    });
    const terminal = buildBinding({
      runId: "terminal-run",
      worktreePath: path.join(tempHome, "terminal"),
      status: "cleaned",
    });
    fs.mkdirSync(active.worktreePath, { recursive: true });
    fs.mkdirSync(terminal.worktreePath, { recursive: true });
    fs.mkdirSync(path.join(tempHome, "sentinel-only"), { recursive: true });
    writeRunRecord(buildRun({ runId: "active-run", status: "running" }));
    writeRunRecord(buildRun({ runId: "terminal-run", status: "done" }));
    writeWorkflowWorktreeBinding(active);
    writeWorkflowWorktreeBinding(terminal);
    writeWorkflowWorktreeSentinelFile(path.join(tempHome, "sentinel-only"), {
      version: 1,
      kind: "openclaw.workflow-worktree",
      runId: "missing-run",
      moduleId: "codex_controller",
      bindingPath: path.join(tempHome, "missing.json"),
      sourceRepoRoot: "/repo",
      managedBranch: "pibo/workflows/codex_controller/missing-run",
      createdAt: "2026-04-24T00:00:00.000Z",
    });

    expect(
      inspectWorkflowWorktreeOwner(path.join(active.worktreePath, "src"), {
        currentRunId: "active-run",
      }).classification,
    ).toBe("owned-by-current-run");
    expect(inspectWorkflowWorktreeOwner(active.worktreePath).classification).toBe(
      "owned-by-other-active-run",
    );
    expect(inspectWorkflowWorktreeOwner(terminal.worktreePath).classification).toBe(
      "owned-by-terminal-run",
    );
    expect(inspectWorkflowWorktreeOwner(path.join(tempHome, "sentinel-only")).classification).toBe(
      "unknown-worktree",
    );
    expect(inspectWorkflowWorktreeOwner(path.join(tempHome, "plain")).classification).toBe(
      "not-a-workflow-worktree",
    );
    expect(findWorkflowWorktreeSentinelByPath(path.join(tempHome, "sentinel-only"))).toMatchObject({
      sentinel: { runId: "missing-run" },
    });
  });
});
