import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { readCronRunLogEntriesPage, resolveCronRunLogPath } from "../cron/run-log.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
  cleanupBrowserSessionsForLifecycleEndMock,
  resolveDeliveryTargetMock,
  workflowStartAsyncMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
  cleanupBrowserSessionsForLifecycleEndMock: vi.fn(async () => {}),
  resolveDeliveryTargetMock: vi.fn(
    async (): Promise<any> => ({
      ok: true,
      channel: "telegram",
      to: "123456",
      accountId: "acct-main",
      threadId: "333",
      mode: "implicit" as const,
    }),
  ),
  workflowStartAsyncMock: vi.fn(async () => ({
    runId: "workflow-run-1",
    moduleId: "codex_controller",
  })),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow,
    }),
  );
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

vi.mock("../cron/isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

vi.mock("../plugins/runtime/runtime-pibo-workflows.js", () => ({
  createRuntimePiboWorkflows: () => ({
    startAsync: workflowStartAsyncMock,
  }),
}));

import { buildGatewayCronService } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    cleanupBrowserSessionsForLifecycleEndMock.mockClear();
    resolveDeliveryTargetMock.mockClear();
    workflowStartAsyncMock.mockClear();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("passes custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: ["project-alpha-monitor"],
        onWarn: expect.any(Function),
      });
    } finally {
      state.cron.stop();
    }
  });

  it("uses a dedicated cron session key for isolated jobs with model overrides", async () => {
    const cfg = createCronConfig("server-cron-isolated-key");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "isolated-model-override",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "run report",
          model: "ollama/kimi-k2.5:cloud",
        },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: `cron:${job.id}`,
        }),
      );
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "main",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: [`cron:${job.id}`],
        onWarn: expect.any(Function),
      });
    } finally {
      state.cron.stop();
    }
  });

  it("starts workflow cron jobs through runtime.piboWorkflows.startAsync and persists linkage fields without webhook success delivery", async () => {
    const cfg = createCronConfig("server-cron-workflow");
    cfg.cron = {
      ...cfg.cron,
      webhook: "https://example.com/cron-webhook",
    };
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "workflow-start",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "telegram:group:-100123:topic:333",
        payload: {
          kind: "workflowStart",
          moduleId: "codex_controller",
          input: { task: "ship" },
          maxRounds: 4,
        },
      });

      await state.cron.run(job.id, "force");

      expect(workflowStartAsyncMock).toHaveBeenCalledWith(
        "codex_controller",
        expect.objectContaining({
          input: { task: "ship" },
          maxRounds: 4,
          origin: {
            ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
            channel: "telegram",
            to: "123456",
            accountId: "acct-main",
            threadId: "333",
          },
          reporting: {
            deliveryMode: "topic_origin",
            senderPolicy: "emitting_agent",
            headerMode: "runtime_header",
            events: ["started", "blocked", "completed"],
          },
        }),
      );
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();

      const logPath = resolveCronRunLogPath({ storePath: cfg.cron.store!, jobId: job.id });
      const page = await readCronRunLogEntriesPage(logPath, { jobId: job.id });
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]).toMatchObject({
        status: "ok",
        workflowRunId: "workflow-run-1",
        workflowModuleId: "codex_controller",
        workflowStartMode: "async",
      });
      expect(page.entries[0]?.summary).toBeUndefined();
      expect(page.entries[0]?.delivered).toBeUndefined();
    } finally {
      state.cron.stop();
    }
  });

  it("fails workflow cron starts closed when trusted origin/reporting cannot be resolved", async () => {
    const cfg = createCronConfig("server-cron-workflow-fail-closed");
    loadConfigMock.mockReturnValue(cfg);
    resolveDeliveryTargetMock.mockResolvedValueOnce({
      ok: false as const,
      mode: "implicit" as const,
      error: new Error("missing delivery target"),
    });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "workflow-fail-closed",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "workflowStart",
          moduleId: "codex_controller",
        },
      });

      await state.cron.run(job.id, "force");

      expect(workflowStartAsyncMock).not.toHaveBeenCalled();
      expect(state.cron.getJob(job.id)?.state.lastError).toContain(
        "workflowStart requires a trusted origin/reporting target: missing delivery target",
      );
    } finally {
      state.cron.stop();
    }
  });

  it("rejects workflow cron jobs with sessionTarget current before persistence", async () => {
    const cfg = createCronConfig("server-cron-workflow-current");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      await expect(
        state.cron.add({
          name: "workflow-current",
          enabled: true,
          schedule: { kind: "at", at: new Date(1).toISOString() },
          sessionTarget: "current",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "workflowStart",
            moduleId: "codex_controller",
          },
        }),
      ).rejects.toThrow(
        'workflowStart cron jobs require sessionTarget="main" or "session:<id>"',
      );
    } finally {
      state.cron.stop();
    }
  });
});
