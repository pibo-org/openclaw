import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWorkflowRunStatus,
  listWorkflowModuleManifests,
  listWorkflowRuns,
  startWorkflowRun,
} from "./index.js";

describe("pibo workflows runtime", () => {
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pibo-workflows-"));
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

  it("lists the native workflow modules", () => {
    const moduleIds = listWorkflowModuleManifests().map((entry) => entry.moduleId);
    expect(moduleIds).toEqual(["codex_controller", "langgraph_worker_critic", "noop"]);
  });

  it("starts, persists, and reloads the noop workflow natively", async () => {
    const record = await startWorkflowRun("noop", {
      input: { prompt: "demo" },
      maxRounds: 3,
    });

    expect(record.moduleId).toBe("noop");
    expect(record.status).toBe("done");
    expect(record.maxRounds).toBe(3);
    expect(record.sessions).toEqual({});

    const reloaded = getWorkflowRunStatus(record.runId);
    expect(reloaded).toEqual(record);

    const runs = listWorkflowRuns(5);
    expect(runs.map((entry) => entry.runId)).toContain(record.runId);
  });
});
