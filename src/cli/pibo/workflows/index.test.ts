import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn,
  };
});

import {
  getWorkflowProgress,
  getWorkflowRunStatus,
  getWorkflowTraceEvents,
  getWorkflowTraceSummary,
  listWorkflowArtifacts,
  listWorkflowModuleManifests,
  listWorkflowRuns,
  readWorkflowArtifact,
  runPendingWorkflowRun,
  startWorkflowRun,
  startWorkflowRunAsync,
  waitForWorkflowRun,
  workflowsRun,
  workflowsStart,
  workflowsStartAsync,
} from "./index.js";
import { writeWorkflowArtifact } from "./store.js";

describe("pibo workflows runtime", () => {
  let tempHome = "";
  let originalHome: string | undefined;
  let originalWorkflowEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalWorkflowEnv = {
      OPENCLAW_WORKFLOW_OWNER_SESSION_KEY: process.env.OPENCLAW_WORKFLOW_OWNER_SESSION_KEY,
      OPENCLAW_MCP_SESSION_KEY: process.env.OPENCLAW_MCP_SESSION_KEY,
      OPENCLAW_MCP_ACCOUNT_ID: process.env.OPENCLAW_MCP_ACCOUNT_ID,
      OPENCLAW_MCP_MESSAGE_CHANNEL: process.env.OPENCLAW_MCP_MESSAGE_CHANNEL,
      OPENCLAW_WORKFLOW_CHANNEL: process.env.OPENCLAW_WORKFLOW_CHANNEL,
      OPENCLAW_WORKFLOW_TO: process.env.OPENCLAW_WORKFLOW_TO,
      OPENCLAW_WORKFLOW_ACCOUNT_ID: process.env.OPENCLAW_WORKFLOW_ACCOUNT_ID,
      OPENCLAW_WORKFLOW_THREAD_ID: process.env.OPENCLAW_WORKFLOW_THREAD_ID,
    };
    for (const key of Object.keys(originalWorkflowEnv)) {
      delete process.env[key];
    }
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
    for (const [key, value] of Object.entries(originalWorkflowEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["pibo", "workflows", "_run-pending", initial.runId]),
      expect.objectContaining({
        detached: true,
        env: process.env,
        stdio: "ignore",
        windowsHide: true,
      }),
    );

    const pendingProgress = getWorkflowProgress(initial.runId);
    expect(pendingProgress.statusPhase).toBe("bootstrapping");
    expect(pendingProgress.humanSummary).toContain("bootstrapping");

    await runPendingWorkflowRun(initial.runId);

    const wait = await waitForWorkflowRun(initial.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.status).toBe("done");
    expect(wait.run?.moduleId).toBe("noop");
    expect(wait.run?.trace?.level).toBe(1);

    const reloaded = getWorkflowRunStatus(initial.runId);
    expect(reloaded.status).toBe("done");
    expect(getWorkflowTraceEvents(initial.runId).length).toBeGreaterThan(0);
  });

  it("builds trusted origin/reporting for CLI workflow starts", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await workflowsStart("noop", {
      json: '{"prompt":"cli-demo"}',
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
      channel: "telegram",
      to: "group:-100123",
      accountId: "telegram-default",
      threadId: "333",
      outputJson: true,
    });

    const rawRecord = consoleLog.mock.calls[0]?.[0];
    expect(typeof rawRecord).toBe("string");
    const record = JSON.parse(String(rawRecord));
    expect(record.origin).toEqual({
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
      channel: "telegram",
      to: "group:-100123",
      accountId: "telegram-default",
      threadId: "333",
    });
    expect(record.reporting).toEqual({
      deliveryMode: "topic_origin",
      senderPolicy: "emitting_agent",
      headerMode: "runtime_header",
      events: ["started", "blocked", "completed"],
    });
    expect(getWorkflowTraceEvents(record.runId).map((event) => event.kind)).toContain(
      "report_delivery_attempted",
    );
  });

  it("builds trusted origin/reporting for async CLI workflow starts", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await workflowsStartAsync("noop", {
      json: '{"prompt":"cli-async-demo"}',
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:444",
      channel: "telegram",
      to: "group:-100123",
      accountId: "telegram-default",
      threadId: "444",
      outputJson: true,
    });

    const rawInitialRecord = consoleLog.mock.calls[0]?.[0];
    expect(typeof rawInitialRecord).toBe("string");
    const initialRecord = JSON.parse(String(rawInitialRecord));
    expect(initialRecord.status).toBe("pending");
    expect(initialRecord.origin).toEqual({
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:444",
      channel: "telegram",
      to: "group:-100123",
      accountId: "telegram-default",
      threadId: "444",
    });
    expect(initialRecord.reporting).toEqual({
      deliveryMode: "topic_origin",
      senderPolicy: "emitting_agent",
      headerMode: "runtime_header",
      events: ["started", "blocked", "completed"],
    });

    await runPendingWorkflowRun(initialRecord.runId);

    const wait = await waitForWorkflowRun(initialRecord.runId, 5_000);
    expect(wait.status).toBe("ok");
    expect(wait.run?.origin).toEqual(initialRecord.origin);
    expect(wait.run?.reporting).toEqual(initialRecord.reporting);
  });

  it("runs codex_controller with task-first flags and defaults cwd to pwd", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(tempHome);
    process.env.OPENCLAW_WORKFLOW_OWNER_SESSION_KEY = "agent:main:telegram:group:-100123:topic:555";
    process.env.OPENCLAW_WORKFLOW_CHANNEL = "telegram";
    process.env.OPENCLAW_WORKFLOW_TO = "group:-100123";
    process.env.OPENCLAW_WORKFLOW_ACCOUNT_ID = "telegram-default";
    process.env.OPENCLAW_WORKFLOW_THREAD_ID = "555";

    await workflowsRun("codex_controller", {
      replyHere: true,
      task: "Ship the fix",
      success: ["Tests pass", "Docs updated"],
      constraint: ["Do not touch unrelated changes"],
      agentId: "writer",
      maxRounds: "4",
      workerModel: "gpt-5.4",
      workerReasoningEffort: "high",
      outputJson: true,
    });

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as {
      record: {
        status: string;
        maxRounds: number;
        origin: Record<string, unknown>;
        input: Record<string, unknown>;
      };
      resolvedDefaults: Record<string, unknown>;
      resolvedOrigin: Record<string, unknown>;
    };
    expect(payload.record.status).toBe("pending");
    expect(payload.record.maxRounds).toBe(4);
    expect(payload.record.input).toMatchObject({
      task: "Ship the fix",
      workingDirectory: tempHome,
      successCriteria: ["Tests pass", "Docs updated"],
      constraints: ["Do not touch unrelated changes"],
      agentId: "writer",
      maxRounds: 4,
      workerModel: "gpt-5.4",
      workerReasoningEffort: "high",
    });
    expect(payload.record.origin).toEqual({
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:555",
      channel: "telegram",
      to: "group:-100123",
      accountId: "telegram-default",
      threadId: "555",
    });
    expect(payload.resolvedDefaults).toEqual({
      cwd: tempHome,
      replyTarget: "current context",
    });
    expect(payload.resolvedOrigin).toEqual(payload.record.origin);
  });

  it("passes --existing-working-directory through to codex_controller input", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(tempHome);

    await workflowsRun("codex_controller", {
      task: "Ship the fix",
      existingWorkingDirectory: true,
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
      channel: "telegram",
      to: "group:-100123",
      threadId: "333",
      outputJson: true,
    });

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as {
      record: {
        input: Record<string, unknown>;
      };
    };
    expect(payload.record.input).toMatchObject({
      task: "Ship the fix",
      workingDirectory: tempHome,
      workingDirectoryMode: "existing",
    });
  });

  it("resolves --reply-here from bundled MCP session context", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(tempHome);
    process.env.OPENCLAW_MCP_SESSION_KEY = "agent:main:telegram:group:-100123:topic:555";
    process.env.OPENCLAW_MCP_ACCOUNT_ID = "telegram-default";
    process.env.OPENCLAW_MCP_MESSAGE_CHANNEL = "telegram";

    await workflowsRun("codex_controller", {
      replyHere: true,
      task: "Ship the fix",
      outputJson: true,
    });

    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as {
      record: {
        origin: Record<string, unknown>;
      };
      resolvedDefaults: Record<string, unknown>;
    };
    expect(payload.record.origin).toEqual({
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:555",
      channel: "telegram",
      to: "group:-100123",
      accountId: "telegram-default",
      threadId: "555",
    });
    expect(payload.resolvedDefaults).toMatchObject({
      cwd: tempHome,
      replyTarget: "current context",
    });
  });

  it("prints resolved operator start context for run codex_controller", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(tempHome);

    await workflowsRun("codex_controller", {
      task: "Inspect the repo",
      ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
      channel: "telegram",
      to: "group:-100123",
      threadId: "333",
    });

    const lines = consoleLog.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toMatch(/^Started workflow run /);
    expect(lines).toContain("Module: codex_controller");
    expect(lines).toContain("Status: pending");
    expect(lines).toContain("Reporting to: telegram group:-100123 topic 333");
    expect(lines).toContain(`Working directory: ${tempHome}`);
    expect(lines.some((line) => line.startsWith("Next: openclaw pibo workflows progress "))).toBe(
      true,
    );
    expect(lines).toContain("Defaults applied:");
    expect(lines).toContain(`- cwd -> ${tempHome}`);
  });

  it("fails --reply-here clearly without a safe current origin", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);
    delete process.env.OPENCLAW_WORKFLOW_OWNER_SESSION_KEY;
    delete process.env.OPENCLAW_MCP_SESSION_KEY;
    delete process.env.OPENCLAW_WORKFLOW_CHANNEL;
    delete process.env.OPENCLAW_WORKFLOW_TO;

    await expect(
      workflowsRun("codex_controller", {
        replyHere: true,
        task: "Ship the fix",
      }),
    ).rejects.toThrow("process.exit:1");
    expect(consoleError.mock.calls[0]?.[0]).toContain("`--reply-here` is not available");
    expect(consoleError.mock.calls[0]?.[0]).toContain("Missing: ownerSessionKey, channel, to");
    exitSpy.mockRestore();
  });

  it("rejects conflicting --json and direct operator flags", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    await expect(
      workflowsRun("codex_controller", {
        json: '{"task":"from json","workingDirectory":"/tmp"}',
        task: "from flag",
      }),
    ).rejects.toThrow("process.exit:1");
    expect(consoleError.mock.calls[0]?.[0]).toContain("Conflicting --json and direct flag inputs");
    expect(consoleError.mock.calls[0]?.[0]).toContain("--task conflicts with JSON field `task`");
    exitSpy.mockRestore();
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
