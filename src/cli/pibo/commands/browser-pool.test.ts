import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfigFile } from "../../../config/config.js";
import { withTempHome } from "../../../config/home-env.test-harness.js";
import { registerPiboCli } from "../../pibo-cli.js";

const browserPoolCommandMocks = vi.hoisted(() => ({
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ profiles: new Map() })),
  createBrowserControlContext: vi.fn(() => ({
    forProfile: () => ({
      stopRunningBrowser: vi.fn(async () => ({ stopped: true })),
    }),
  })),
}));

vi.mock("../../../../extensions/browser/src/control-service.js", () => ({
  startBrowserControlServiceFromConfig:
    browserPoolCommandMocks.startBrowserControlServiceFromConfig,
  createBrowserControlContext: browserPoolCommandMocks.createBrowserControlContext,
}));

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPiboCli(program);
  return program;
}

async function writeBrowserPoolConfig() {
  await writeConfigFile({
    browser: {
      profiles: {
        "dev-01": { cdpPort: 18801, color: "#AA0001" },
        "dev-02": { cdpPort: 18802, color: "#AA0002" },
        "dev-03": { cdpPort: 18803, color: "#AA0003" },
      },
    },
  });
}

describe("browser pool command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    browserPoolCommandMocks.startBrowserControlServiceFromConfig.mockClear();
    browserPoolCommandMocks.createBrowserControlContext.mockClear();
  });

  it("validates acquire arguments", async () => {
    await withTempHome("openclaw-browser-pool-cli-", async () => {
      await writeBrowserPoolConfig();
      await expect(
        createProgram().parseAsync(["pibo", "browser-pool", "acquire", "--agent-id", "agent-1"], {
          from: "user",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });
  });

  it("validates heartbeat arguments", async () => {
    await withTempHome("openclaw-browser-pool-cli-", async () => {
      await writeBrowserPoolConfig();
      await expect(
        createProgram().parseAsync(["pibo", "browser-pool", "heartbeat", "--profile", "dev-01"], {
          from: "user",
        }),
      ).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
    });
  });

  it("validates release arguments", async () => {
    await withTempHome("openclaw-browser-pool-cli-", async () => {
      await writeBrowserPoolConfig();
      await expect(
        createProgram().parseAsync(["pibo", "browser-pool", "release", "--lease-id", "lease-1"], {
          from: "user",
        }),
      ).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
    });
  });

  it("prints status output with free, active, and stale states", async () => {
    await withTempHome("openclaw-browser-pool-cli-", async (home) => {
      await writeBrowserPoolConfig();
      const statePath = path.join(home, ".openclaw", "pibo", "dev-browser-profile-router.json");
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify(
          {
            version: 1,
            profiles: {
              "dev-01": {
                class: "dev",
                lease: {
                  leaseId: "lease-active",
                  holderKey: "sk:session-active",
                  agentId: "agent-1",
                  sessionKey: "session-active",
                  sessionId: null,
                  workflowRunId: null,
                  task: null,
                  acquiredAt: "2026-04-20T19:00:00.000Z",
                  lastSeenAt: "2026-04-20T19:10:00.000Z",
                  expiresAt: "2999-04-20T21:00:00.000Z",
                },
              },
              "dev-02": {
                class: "dev",
                lease: {
                  leaseId: "lease-stale",
                  holderKey: "sk:session-stale",
                  agentId: "agent-2",
                  sessionKey: "session-stale",
                  sessionId: null,
                  workflowRunId: null,
                  task: null,
                  acquiredAt: "2026-04-20T17:00:00.000Z",
                  lastSeenAt: "2026-04-20T17:10:00.000Z",
                  expiresAt: "2026-04-20T18:00:00.000Z",
                },
              },
              "dev-03": { class: "dev", lease: null },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await createProgram().parseAsync(["pibo", "browser-pool", "status"], { from: "user" });

      expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
        expect.stringContaining("dev-01: active"),
        expect.stringContaining("dev-02: stale"),
        "dev-03: free",
      ]);
    });
  });

  it("runs the full CLI acquire -> heartbeat -> release flow", async () => {
    await withTempHome("openclaw-browser-pool-cli-", async () => {
      await writeBrowserPoolConfig();

      await createProgram().parseAsync(
        ["pibo", "browser-pool", "acquire", "--agent-id", "agent-1", "--session-key", "session-1"],
        { from: "user" },
      );

      const acquirePayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(acquirePayload).toMatchObject({
        ok: true,
        profile: "dev-01",
      });

      await createProgram().parseAsync(
        [
          "pibo",
          "browser-pool",
          "heartbeat",
          "--profile",
          "dev-01",
          "--lease-id",
          acquirePayload.leaseId,
        ],
        { from: "user" },
      );
      const heartbeatPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(heartbeatPayload).toMatchObject({
        ok: true,
        profile: "dev-01",
        leaseId: acquirePayload.leaseId,
      });

      await createProgram().parseAsync(
        [
          "pibo",
          "browser-pool",
          "release",
          "--profile",
          "dev-01",
          "--lease-id",
          acquirePayload.leaseId,
        ],
        { from: "user" },
      );
      const releasePayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(releasePayload).toMatchObject({
        ok: true,
        profile: "dev-01",
        released: true,
      });
      expect(browserPoolCommandMocks.startBrowserControlServiceFromConfig).toHaveBeenCalled();
    });
  });
});
