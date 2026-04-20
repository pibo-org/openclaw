import fs from "node:fs";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { withTempHomeConfig } from "../config/test-helpers.js";
import { captureEnv } from "../test-utils/env.js";
import { registerCronCli } from "./cron-cli.js";
import { registerSystemCli } from "./system-cli.js";

const gatewayCallState = vi.hoisted(() => ({
  methods: [] as string[],
}));
const runtimeState = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const defaultRuntime = {
    log: vi.fn((value: string) => {
      runtimeLogs.push(value);
    }),
    error: vi.fn((value: string) => {
      runtimeErrors.push(value);
    }),
    writeStdout: vi.fn((value: string) => {
      runtimeLogs.push(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtimeLogs.push(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    runtimeLogs,
    runtimeErrors,
    defaultRuntime,
    reset() {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
      defaultRuntime.log.mockClear();
      defaultRuntime.error.mockClear();
      defaultRuntime.writeStdout.mockClear();
      defaultRuntime.writeJson.mockClear();
      defaultRuntime.exit.mockClear();
    },
  };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: runtimeState.defaultRuntime,
}));

const gatewayCallModule = await import("../gateway/call.js");
const { registerPreActionHooks } = await import("./program/preaction.js");

class StubGatewayClient {
  constructor(
    private readonly opts: {
      onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
    },
  ) {}

  async request(method: string): Promise<unknown> {
    gatewayCallState.methods.push(method);
    if (method === "cron.status") {
      return { enabled: true, running: false };
    }
    if (method === "cron.list") {
      return { jobs: [] };
    }
    if (method === "system-presence") {
      return { items: [] };
    }
    return { ok: true };
  }

  start(): void {
    void this.opts.onHelloOk?.({
      features: {
        methods: ["cron.status", "cron.list", "system-presence"],
      },
    });
  }

  stop(): void {}
}

function countConfigReads(
  spy: { mock: { calls: Array<[unknown, ...unknown[]]> } },
  configPath: string,
): number {
  return spy.mock.calls.filter(([candidate]) => candidate === configPath).length;
}

function buildProgram(): Command {
  const program = new Command().name("openclaw");
  program.exitOverride();
  registerCronCli(program);
  registerSystemCli(program);
  registerPreActionHooks(program, "9.9.9-test");
  return program;
}

describe("gateway-backed CLI startup config reuse", () => {
  const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR", "HOME"]);
  let originalArgv: string[];

  beforeEach(() => {
    gatewayCallState.methods = [];
    originalArgv = [...process.argv];
    runtimeState.reset();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    gatewayCallModule.__testing.setDepsForTests({
      createGatewayClient: (opts) =>
        new StubGatewayClient(opts as ConstructorParameters<typeof StubGatewayClient>[0]) as never,
      loadOrCreateDeviceIdentity: () =>
        ({
          deviceId: "test-device",
          publicKeyPem: "test-public-key",
          privateKeyPem: "test-private-key",
        }) as never,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    envSnapshot.restore();
    gatewayCallModule.__testing.resetDepsForTests();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it.each([
    {
      args: ["cron", "status", "--json"],
      expectedMethod: "cron.status",
      expectedJson: { enabled: true, running: false },
    },
    {
      args: ["cron", "list", "--json"],
      expectedMethod: "cron.list",
      expectedJson: { jobs: [] },
    },
    {
      args: ["system", "presence", "--json"],
      expectedMethod: "system-presence",
      expectedJson: { items: [] },
    },
  ])("reads config once for $args", async ({ args, expectedMethod, expectedJson }) => {
    await withTempHomeConfig(
      {
        commands: { ownerDisplay: "raw" },
        gateway: {
          mode: "local",
          bind: "loopback",
          port: 18789,
          auth: { mode: "token", token: "test-token" },
        },
      },
      async ({ configPath }) => {
        const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
        try {
          const argv = ["node", "openclaw", ...args];
          process.argv = argv;

          const program = buildProgram();
          await program.parseAsync(argv, { from: "node" });

          expect(countConfigReads(readFileSyncSpy, configPath)).toBe(1);
          expect(gatewayCallState.methods).toEqual([expectedMethod]);
          expect(runtimeState.runtimeLogs).toEqual([JSON.stringify(expectedJson, null, 2)]);
        } finally {
          readFileSyncSpy.mockRestore();
        }
      },
    );
  });
});
