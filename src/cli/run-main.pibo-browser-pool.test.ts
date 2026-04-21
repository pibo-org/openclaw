import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { withTempHome } from "../config/home-env.test-harness.js";

const browserPoolCommandMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async () => ({ ok: true, stopped: true })),
}));

vi.mock("../../extensions/browser/src/cli/browser-cli-shared.js", () => ({
  callBrowserRequest: browserPoolCommandMocks.callBrowserRequest,
}));

vi.mock("./route.js", () => ({
  tryRouteCli: vi.fn(async () => false),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: vi.fn(),
}));

vi.mock("../logging.js", async () => {
  const actual = await vi.importActual<typeof import("../logging.js")>("../logging.js");
  return {
    ...actual,
    enableConsoleCapture: vi.fn(),
  };
});

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: vi.fn(async () => undefined),
}));

const { runCli } = await import("./run-main.js");

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

describe("runCli pibo browser-pool", () => {
  const originalProfile = process.env.OPENCLAW_PROFILE;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalProfile === undefined) {
      delete process.env.OPENCLAW_PROFILE;
    } else {
      process.env.OPENCLAW_PROFILE = originalProfile;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
  });

  it("keeps root --profile working while browser-pool renew/release use --browser-profile", async () => {
    await withTempHome("openclaw-browser-pool-run-cli-", async () => {
      await writeBrowserPoolConfig();

      await runCli([
        "node",
        "openclaw",
        "--profile",
        "work",
        "pibo",
        "browser-pool",
        "acquire",
        "--agent-id",
        "agent-1",
        "--session-key",
        "session-1",
      ]);

      const acquirePayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(acquirePayload).toMatchObject({
        ok: true,
        profile: "dev-01",
      });
      expect(process.env.OPENCLAW_PROFILE).toBe("work");
      logSpy.mockClear();

      await runCli([
        "node",
        "openclaw",
        "--profile",
        "work",
        "pibo",
        "browser-pool",
        "renew",
        "--browser-profile",
        "dev-01",
        "--lease-id",
        acquirePayload.leaseId,
      ]);

      const renewPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(renewPayload).toMatchObject({
        ok: true,
        profile: "dev-01",
        leaseId: acquirePayload.leaseId,
      });
      logSpy.mockClear();

      await runCli([
        "node",
        "openclaw",
        "--profile",
        "work",
        "pibo",
        "browser-pool",
        "release",
        "--browser-profile",
        "dev-01",
        "--lease-id",
        acquirePayload.leaseId,
      ]);

      const releasePayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(releasePayload).toMatchObject({
        ok: true,
        profile: "dev-01",
        released: true,
      });
      expect(browserPoolCommandMocks.callBrowserRequest).toHaveBeenCalledWith(
        {
          json: true,
          timeout: "30000",
        },
        {
          method: "POST",
          path: "/stop",
          query: { profile: "dev-01" },
        },
      );
    });
  });
});
