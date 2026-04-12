import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkflowTraceRuntime,
  readWorkflowTraceEvents,
  readWorkflowTraceSummary,
} from "./runtime.js";

describe("workflow tracing runtime", () => {
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workflow-trace-"));
    process.env.HOME = tempHome;
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
  });

  it("writes trace files, updates summary, and redacts sensitive payload fields", () => {
    const tracer = createWorkflowTraceRuntime({
      runId: "run-1",
      moduleId: "noop",
      level: 1,
      nowIso: () => "2026-04-12T10:00:00.000Z",
    });

    tracer.emit({
      kind: "run_started",
      stepId: "run",
      status: "running",
      summary: "started",
      payload: {
        apiToken: "secret-value",
        nested: { cookie: "cookie-value" },
        note: "x".repeat(5_000),
      },
    });
    tracer.emit({
      kind: "artifact_written",
      stepId: "run",
      artifactPath: "/tmp/run-1/input.json",
      summary: "input written",
    });
    tracer.emit({
      kind: "run_completed",
      stepId: "run",
      status: "done",
      summary: "completed",
    });

    const summary = readWorkflowTraceSummary("run-1");
    expect(summary).toMatchObject({
      runId: "run-1",
      moduleId: "noop",
      traceLevel: 1,
      status: "done",
      eventCount: 3,
      stepCount: 1,
      artifactCount: 1,
      lastEventKind: "run_completed",
    });

    const events = readWorkflowTraceEvents("run-1");
    expect(events).toHaveLength(3);
    expect(events[0]?.payload).toMatchObject({
      apiToken: "[REDACTED]",
      nested: { cookie: "[REDACTED]" },
    });
    expect(String((events[0]?.payload as { note?: string }).note)).toContain("[truncated");
    expect(
      tracer.attachToRunRecord({
        runId: "run-1",
        moduleId: "noop",
        status: "done",
        terminalReason: "ok",
        currentRound: 0,
        maxRounds: null,
        input: {},
        artifacts: [],
        sessions: {},
        latestWorkerOutput: null,
        latestCriticVerdict: null,
        originalTask: null,
        currentTask: null,
        createdAt: "2026-04-12T10:00:00.000Z",
        updatedAt: "2026-04-12T10:00:00.000Z",
      }).trace,
    ).toMatchObject({
      version: "v1",
      level: 1,
      eventCount: 3,
    });
  });
});
