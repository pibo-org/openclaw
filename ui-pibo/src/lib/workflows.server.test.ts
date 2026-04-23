import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/auth.server", () => ({
  requireAuthenticatedUsername: () => "tester",
}));

import { writeRunRecord, writeWorkflowArtifact } from "../../../src/cli/pibo/workflows/store.ts";
import type { WorkflowRunRecord } from "../../../src/cli/pibo/workflows/types.ts";
import { readWorkflowRunDetailPage, readWorkflowsDashboardPage } from "./workflows.server";

describe("workflows.server", () => {
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ui-pibo-workflows-"));
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

  it("builds compact dashboard rows and falls back when trace summaries are missing", async () => {
    writeRunRecord(
      buildRunRecord({
        runId: "run-missing-summary",
        status: "running",
        currentTask: "Ship the workflows dashboard",
        sessions: {
          orchestrator: "agent:orchestrator",
          worker: "agent:worker",
        },
        updatedAt: "2026-04-23T09:00:00.000Z",
      }),
    );

    const page = await readWorkflowsDashboardPage({
      q: "dashboard",
      role: "worker",
      window: "all",
    });

    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({
      runId: "run-missing-summary",
      status: "running",
      taskSnippet: "Ship the workflows dashboard",
      trace: {
        summaryAvailable: false,
        rolesSeen: ["orchestrator", "worker"],
      },
    });
  });

  it("does not surface report_failed:event-disabled as a generic dashboard failure", async () => {
    writeRunRecord(
      buildRunRecord({
        runId: "run-event-disabled",
        status: "done",
        currentTask: "Send completion report",
        updatedAt: "2026-04-23T10:00:00.000Z",
      }),
    );
    writeWorkflowArtifact(
      "run-event-disabled",
      "trace.summary.json",
      JSON.stringify(
        {
          runId: "run-event-disabled",
          moduleId: "noop",
          traceLevel: 1,
          status: "done",
          eventCount: 5,
          stepCount: 1,
          roundCount: 1,
          rolesSeen: ["worker"],
          artifactCount: 0,
          lastEventKind: "run_completed",
          errorSummary: "event-disabled",
        },
        null,
        2,
      ),
    );

    const page = await readWorkflowsDashboardPage({
      q: "completion",
      window: "all",
    });

    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]?.trace.errorSummary).toBe("event-disabled");
    expect(page.runs[0]?.trace.hasMeaningfulError).toBe(false);
  });

  it("returns filtered trace events and tail artifact previews for the detail view", async () => {
    writeRunRecord(
      buildRunRecord({
        runId: "run-detail",
        status: "done",
        currentTask: "Inspect generated artifacts",
        updatedAt: "2026-04-23T11:00:00.000Z",
      }),
    );
    writeWorkflowArtifact(
      "run-detail",
      "trace.summary.json",
      JSON.stringify(
        {
          runId: "run-detail",
          moduleId: "noop",
          traceLevel: 1,
          status: "done",
          startedAt: "2026-04-23T10:55:00.000Z",
          endedAt: "2026-04-23T11:00:00.000Z",
          durationMs: 300000,
          eventCount: 4,
          stepCount: 1,
          roundCount: 1,
          rolesSeen: ["worker"],
          artifactCount: 1,
          lastEventKind: "run_completed",
          errorSummary: "event-disabled",
        },
        null,
        2,
      ),
    );
    writeWorkflowArtifact(
      "run-detail",
      "trace.jsonl",
      [
        JSON.stringify({
          eventId: "evt-1",
          runId: "run-detail",
          moduleId: "noop",
          ts: "2026-04-23T10:55:00.000Z",
          seq: 1,
          kind: "run_started",
          summary: "workflow started",
        }),
        JSON.stringify({
          eventId: "evt-2",
          runId: "run-detail",
          moduleId: "noop",
          ts: "2026-04-23T10:56:00.000Z",
          seq: 2,
          kind: "role_turn_started",
          role: "worker",
          summary: "drafting preview",
        }),
        JSON.stringify({
          eventId: "evt-3",
          runId: "run-detail",
          moduleId: "noop",
          ts: "2026-04-23T10:57:00.000Z",
          seq: 3,
          kind: "artifact_written",
          artifactPath: `/tmp/run-detail/notes.txt`,
          summary: "notes written",
        }),
        JSON.stringify({
          eventId: "evt-4",
          runId: "run-detail",
          moduleId: "noop",
          ts: "2026-04-23T11:00:00.000Z",
          seq: 4,
          kind: "run_completed",
          status: "done",
          summary: "workflow completed",
        }),
      ].join("\n"),
    );
    writeWorkflowArtifact("run-detail", "notes.txt", "line-1\nline-2\nline-3");

    const detail = await readWorkflowRunDetailPage("run-detail", {
      kind: "role_turn_started",
      q: "drafting",
      artifact: "notes.txt",
      artifactMode: "tail",
      artifactLines: 2,
    });

    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({
      kind: "role_turn_started",
      role: "worker",
      summary: "drafting preview",
    });
    expect(detail.artifactPreview).toMatchObject({
      artifactName: "notes.txt",
      mode: "tail",
      content: "line-2\nline-3",
    });
    expect(detail.traceSummary.hasMeaningfulError).toBe(false);
  });
});

function buildRunRecord(overrides: Partial<WorkflowRunRecord> & Pick<WorkflowRunRecord, "runId">) {
  return {
    runId: overrides.runId,
    moduleId: "noop",
    status: "running",
    terminalReason: null,
    abortRequested: false,
    abortRequestedAt: null,
    currentRound: 1,
    maxRounds: 3,
    input: { prompt: "demo" },
    artifacts: [],
    sessions: {},
    latestWorkerOutput: null,
    latestCriticVerdict: null,
    originalTask: overrides.currentTask ?? "demo task",
    currentTask: "demo task",
    createdAt: "2026-04-23T08:55:00.000Z",
    updatedAt: "2026-04-23T08:56:00.000Z",
    ...overrides,
  } satisfies WorkflowRunRecord;
}
