import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWorkflowProgress,
  getWorkflowRunStatus,
  getWorkflowTraceEvents,
  getWorkflowTraceSummary,
  listWorkflowArtifacts,
  listWorkflowModuleManifests,
  listWorkflowRuns,
  readWorkflowArtifact,
  startWorkflowRun,
  startWorkflowRunAsync,
  waitForWorkflowRun,
} from "./index.js";
import { writeWorkflowArtifact } from "./store.js";

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
    expect(moduleIds).toEqual([
      "codex_controller",
      "langgraph_worker_critic",
      "noop",
      "ralph_from_specs",
      "self_ralph",
    ]);
  });

  it("starts, persists, and reloads the noop workflow natively", async () => {
    const record = await startWorkflowRun("noop", {
      input: { prompt: "demo" },
      maxRounds: 3,
      origin: {
        ownerSessionKey: "agent:main:telegram:topic:demo",
        channel: "telegram",
        to: "group:demo",
        accountId: "telegram-default",
        threadId: "17",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["completed"],
      },
    });

    expect(record.moduleId).toBe("noop");
    expect(record.status).toBe("done");
    expect(record.maxRounds).toBe(3);
    expect(record.sessions).toEqual({});
    expect(record.origin).toEqual({
      ownerSessionKey: "agent:main:telegram:topic:demo",
      channel: "telegram",
      to: "group:demo",
      accountId: "telegram-default",
      threadId: "17",
    });
    expect(record.reporting).toEqual({
      deliveryMode: "topic_origin",
      senderPolicy: "emitting_agent",
      headerMode: "runtime_header",
      events: ["completed"],
    });
    expect(record.trace).toMatchObject({
      version: "v1",
      level: 1,
      eventCount: expect.any(Number),
    });
    expect(fs.existsSync(record.trace?.eventLogPath ?? "")).toBe(true);
    expect(fs.existsSync(record.trace?.summaryPath ?? "")).toBe(true);

    const reloaded = getWorkflowRunStatus(record.runId);
    expect(reloaded).toEqual(record);

    const summary = getWorkflowTraceSummary(record.runId);
    expect(summary).toMatchObject({
      runId: record.runId,
      moduleId: "noop",
      traceLevel: 1,
      status: "done",
    });

    const events = getWorkflowTraceEvents(record.runId);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "run_started",
        "run_status_changed",
        "run_completed",
        "report_delivery_attempted",
      ]),
    );

    const runs = listWorkflowRuns(5);
    expect(runs.map((entry) => entry.runId)).toContain(record.runId);
  });

  it("starts noop asynchronously and can wait for terminal completion", async () => {
    const initial = await startWorkflowRunAsync("noop", {
      input: { prompt: "async-demo" },
      maxRounds: 2,
    });

    expect(initial.moduleId).toBe("noop");
    expect(initial.status).toBe("pending");
    expect(initial.trace).toMatchObject({
      version: "v1",
      level: 0,
      eventCount: 0,
    });

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("done");
    expect(wait.run?.moduleId).toBe("noop");
    expect(wait.run?.trace?.level).toBe(1);

    const reloaded = getWorkflowRunStatus(initial.runId);
    expect(reloaded.status).toBe("done");
    expect(getWorkflowTraceEvents(initial.runId).length).toBeGreaterThan(0);
  });

  it("derives compact progress snapshots and filtered trace events", async () => {
    const record = await startWorkflowRun("noop", {
      input: { prompt: "progress-demo" },
    });

    const progress = getWorkflowProgress(record.runId);
    expect(progress).toMatchObject({
      runId: record.runId,
      moduleId: "noop",
      status: "done",
      isTerminal: true,
      traceLevel: 1,
      lastEventKind: "run_completed",
    });
    expect(progress.humanSummary).toContain("erfolgreich abgeschlossen");

    const filtered = getWorkflowTraceEvents(record.runId, {
      kind: "run_completed",
      limit: 1,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe("run_completed");
  });

  it("lists and reads workflow artifacts without requiring the full file", async () => {
    const record = await startWorkflowRun("noop", {
      input: { prompt: "artifact-demo" },
    });
    writeWorkflowArtifact(record.runId, "notes.txt", "line-1\nline-2\nline-3\n");

    const artifacts = listWorkflowArtifacts(record.runId);
    expect(artifacts.map((artifact) => artifact.name)).toContain("notes.txt");

    const artifact = readWorkflowArtifact(record.runId, "notes.txt", { tailLines: 2 });
    expect(artifact.mode).toBe("tail");
    expect(artifact.truncated).toBe(true);
    expect(artifact.content).toBe("line-3\n");
  });
});
