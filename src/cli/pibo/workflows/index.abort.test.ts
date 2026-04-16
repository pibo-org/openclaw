import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowAbortError } from "./abort.js";
import type { WorkflowModule, WorkflowRunRecord } from "./types.js";

const abortableWorkflowModule: WorkflowModule = {
  manifest: {
    moduleId: "abortable",
    displayName: "Abortable Test Workflow",
    description: "Test-only workflow that waits until abort is requested.",
    kind: "maintenance_workflow",
    version: "1.0.0",
    requiredAgents: [],
    terminalStates: ["aborted", "failed"],
    supportsAbort: true,
    inputSchemaSummary: ["test-only"],
    artifactContract: ["none"],
  },
  async start(request, ctx) {
    const now = ctx.nowIso();
    const record: WorkflowRunRecord = {
      runId: ctx.runId,
      moduleId: "abortable",
      status: "running",
      terminalReason: null,
      abortRequested: false,
      abortRequestedAt: null,
      currentRound: 0,
      maxRounds: request.maxRounds ?? null,
      input: request.input,
      artifacts: [],
      sessions: {},
      latestWorkerOutput: null,
      latestCriticVerdict: null,
      originalTask: null,
      currentTask: null,
      createdAt: now,
      updatedAt: now,
    };
    ctx.persist(record);
    await new Promise<never>((_, reject) => {
      const onAbort = () => reject(createWorkflowAbortError(ctx.abortSignal.reason));
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (ctx.abortSignal.aborted) {
        onAbort();
      }
    });
    throw new Error("unreachable");
  },
};

vi.mock("./modules/index.js", () => ({
  getWorkflowModule: (moduleId: string) =>
    moduleId === "abortable" ? abortableWorkflowModule : undefined,
  listWorkflowModules: () => [abortableWorkflowModule],
}));

import {
  abortWorkflowRun,
  getWorkflowRunStatus,
  startWorkflowRunAsync,
  waitForWorkflowRun,
  workflowsAbort,
} from "./index.js";

describe("workflow abort lifecycle", () => {
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pibo-workflow-abort-"));
    process.env.HOME = tempHome;
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

  it("treats pending abort as requested first, then finalizes to aborted", async () => {
    const initial = await startWorkflowRunAsync("abortable", { input: { task: "demo" } });
    expect(initial.status).toBe("pending");
    expect(initial.abortRequested).toBe(false);

    const requested = abortWorkflowRun(initial.runId);
    expect(requested.status).toBe("pending");
    expect(requested.abortRequested).toBe(true);
    expect(requested.abortRequestedAt).toBeTruthy();

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("aborted");
    expect(wait.run?.abortRequested).toBe(true);
    expect(wait.run?.terminalReason).toBe("Abort requested by operator.");

    const terminalAgain = abortWorkflowRun(initial.runId);
    expect(terminalAgain.status).toBe("aborted");
    expect(terminalAgain.abortRequested).toBe(true);
  });

  it("keeps running abort idempotent until the workflow reaches terminal aborted", async () => {
    const initial = await startWorkflowRunAsync("abortable", { input: { task: "demo" } });
    await vi.waitFor(() => {
      expect(getWorkflowRunStatus(initial.runId).status).toBe("running");
    });

    const first = abortWorkflowRun(initial.runId);
    expect(first.status).toBe("running");
    expect(first.abortRequested).toBe(true);

    const second = abortWorkflowRun(initial.runId);
    expect(second.status).toBe("running");
    expect(second.abortRequested).toBe(true);
    expect(second.abortRequestedAt).toBe(first.abortRequestedAt);

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("aborted");
    expect(wait.run?.abortRequested).toBe(true);

    const finalRecord = abortWorkflowRun(initial.runId);
    expect(finalRecord.status).toBe("aborted");
    expect(finalRecord.abortRequestedAt).toBe(first.abortRequestedAt);
  });

  it("reports requested-versus-terminal abort feedback truthfully", async () => {
    const initial = await startWorkflowRunAsync("abortable", { input: { task: "demo" } });
    await vi.waitFor(() => {
      expect(getWorkflowRunStatus(initial.runId).status).toBe("running");
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    workflowsAbort(initial.runId, { json: false });
    expect(consoleSpy.mock.calls.map(([line]) => String(line))).toEqual(
      expect.arrayContaining([
        `Abort angefordert: ${initial.runId}`,
        "Status: running",
        "Abort requested: yes",
      ]),
    );
    expect(consoleSpy.mock.calls.flat().join("\n")).toContain(
      "Abort requested; wait for the active workflow step to stop before the run becomes terminal.",
    );

    await waitForWorkflowRun(initial.runId, 5_000);
    consoleSpy.mockClear();

    workflowsAbort(initial.runId, { json: false });
    expect(consoleSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      `Run bereits abgebrochen: ${initial.runId}`,
    );
  });
});
