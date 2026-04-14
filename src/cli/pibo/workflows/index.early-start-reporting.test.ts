import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { emitTracedWorkflowReportEvent } = vi.hoisted(() => ({
  emitTracedWorkflowReportEvent: vi.fn(async () => ({
    attempted: true,
    delivered: true,
  })),
}));

vi.mock("./workflow-reporting.js", () => ({
  emitTracedWorkflowReportEvent,
}));

import {
  getWorkflowRunStatus,
  startWorkflowRun,
  startWorkflowRunAsync,
  waitForWorkflowRun,
} from "./index.js";

type WorkflowReportEventCall = {
  eventType?: string;
};

type FailureWorkflowReportCall = WorkflowReportEventCall & {
  runId?: string;
  moduleId?: string;
  phase?: string;
  status?: string;
  messageText?: string;
  reporting?: { events?: string[] };
};

describe("workflow early-start reporting", () => {
  let tempHome = "";
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pibo-early-start-"));
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

  it("keeps the normal noop started/completed reporting path unchanged", async () => {
    const record = await startWorkflowRun("noop", {
      input: { prompt: "demo" },
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
        accountId: "telegram-default",
        threadId: "333",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["started", "completed"],
      },
    });

    expect(record.status).toBe("done");
    expect(emitTracedWorkflowReportEvent).toHaveBeenCalledTimes(2);
    const reportCalls = emitTracedWorkflowReportEvent.mock.calls as unknown as Array<[unknown]>;
    expect(reportCalls.map(([call]) => (call as WorkflowReportEventCall).eventType)).toEqual([
      "started",
      "completed",
    ]);
  });

  it("preserves the synchronous start failure behavior when no run record exists yet", async () => {
    await expect(
      startWorkflowRun("codex_controller", {
        input: {
          task: "Ship the fix",
          repoPath: "/repo",
        },
        origin: {
          ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
          channel: "telegram",
          to: "group:-100123",
          accountId: "telegram-default",
          threadId: "333",
        },
        reporting: {
          deliveryMode: "topic_origin",
          senderPolicy: "emitting_agent",
          headerMode: "runtime_header",
          events: ["started", "completed"],
        },
      }),
    ).rejects.toThrow(
      "codex_controller benötigt `input.workingDirectory`. Falls `repoPath` übergeben wurde, bitte in `workingDirectory` umbenennen.",
    );

    expect(emitTracedWorkflowReportEvent).not.toHaveBeenCalled();
  });

  it("announces early codex_controller start failures visibly without a duplicate started report", async () => {
    const initial = await startWorkflowRunAsync("codex_controller", {
      input: {
        task: "Ship the fix",
        repoPath: "/repo",
      },
      origin: {
        ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
        channel: "telegram",
        to: "group:-100123",
        accountId: "telegram-default",
        threadId: "333",
      },
      reporting: {
        deliveryMode: "topic_origin",
        senderPolicy: "emitting_agent",
        headerMode: "runtime_header",
        events: ["started", "completed"],
      },
    });

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("failed");

    expect(emitTracedWorkflowReportEvent).toHaveBeenCalledTimes(1);
    const reportCalls = emitTracedWorkflowReportEvent.mock.calls as unknown as Array<[unknown]>;
    const failureReport = reportCalls[0]?.[0] as FailureWorkflowReportCall | undefined;
    expect(failureReport).toMatchObject({
      runId: initial.runId,
      moduleId: "codex_controller",
      phase: "run_start_failed",
      eventType: "blocked",
      status: "failed",
      reporting: {
        events: expect.arrayContaining(["started", "completed", "blocked"]),
      },
    });
    expect(failureReport?.messageText).toContain(
      "Workflow start failed before the regular workflow start/reporting path began.",
    );
    expect(failureReport?.messageText).toContain("Module: codex_controller");
    expect(failureReport?.messageText).toContain(`Run: ${initial.runId}`);
    expect(failureReport?.messageText).toContain(
      "codex_controller benötigt `input.workingDirectory`",
    );
    expect(
      reportCalls.some(([call]) => (call as WorkflowReportEventCall).eventType === "started"),
    ).toBe(false);

    expect(getWorkflowRunStatus(initial.runId).status).toBe("failed");
  });
});
