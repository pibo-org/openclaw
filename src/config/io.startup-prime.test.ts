import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
  primeRuntimeConfigLoadFromSnapshot,
  readConfigFileSnapshot,
} from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

function countConfigReads(
  spy: { mock: { calls: Array<[unknown, ...unknown[]]> } },
  configPath: string,
): number {
  return spy.mock.calls.filter(([candidate]) => candidate === configPath).length;
}

describe("startup config priming", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("reuses a primed valid snapshot for the first runtime config load", async () => {
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
          const snapshot = await readConfigFileSnapshot();
          const readsAfterSnapshot = countConfigReads(readFileSyncSpy, configPath);

          expect(snapshot.valid).toBe(true);
          expect(readsAfterSnapshot).toBe(1);

          primeRuntimeConfigLoadFromSnapshot(snapshot);
          const primedConfig = loadConfig();

          expect(countConfigReads(readFileSyncSpy, configPath)).toBe(readsAfterSnapshot);
          expect(primedConfig.gateway?.auth?.token).toBe("test-token");

          clearRuntimeConfigSnapshot();
          clearConfigCache();
          readFileSyncSpy.mockClear();

          const freshConfig = loadConfig();

          expect(countConfigReads(readFileSyncSpy, configPath)).toBe(1);
          expect(freshConfig).toEqual(primedConfig);
        } finally {
          readFileSyncSpy.mockRestore();
        }
      },
    );
  });
});
