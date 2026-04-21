import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPoolRouter, resolveHolderKey } from "./router.js";
import {
  createEmptyBrowserPoolState,
  readBrowserPoolState,
  resolveBrowserPoolStatePath,
} from "./state.js";
import { BrowserPoolError } from "./types.js";

const tempDirs: string[] = [];

async function mktemp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createHarness(params?: {
  now?: Date;
  stopImpl?: (profile: "dev-01" | "dev-02" | "dev-03") => Promise<{ stopped: boolean }>;
  inspectProfiles?: () => Promise<Record<"dev-01" | "dev-02" | "dev-03", boolean>>;
}) {
  const home = await mktemp("openclaw-browser-pool-home-");
  const statePath = path.join(home, ".openclaw", "pibo", "dev-browser-profile-router.json");
  const now = params?.now ?? new Date("2026-04-20T20:00:00.000Z");
  const router = createBrowserPoolRouter({
    statePath,
    now: () => now,
    leaseIdFactory: (() => {
      let index = 0;
      return () => `lease_${++index}`;
    })(),
    inspectProfiles:
      params?.inspectProfiles ?? (async () => ({ "dev-01": true, "dev-02": true, "dev-03": true })),
    stopProfile:
      params?.stopImpl ??
      (async () => {
        return { stopped: true };
      }),
  });
  return { home, statePath, router };
}

describe("browser pool router", () => {
  it("allocates dev-01, dev-02, and dev-03 sequentially", async () => {
    const { router } = await createHarness();

    const holder = { agentId: "agent-1", sessionKey: "session-1" };
    const first = await router.acquire({ holder });
    const second = await router.acquire({
      holder: { agentId: "agent-2", sessionKey: "session-2" },
    });
    const third = await router.acquire({ holder: { agentId: "agent-3", sessionKey: "session-3" } });

    expect(first.profile).toBe("dev-01");
    expect(second.profile).toBe("dev-02");
    expect(third.profile).toBe("dev-03");
  });

  it("returns NO_DEV_PROFILE_AVAILABLE on the fourth acquire", async () => {
    const { router } = await createHarness();

    await router.acquire({ holder: { agentId: "a-1", sessionKey: "s-1" } });
    await router.acquire({ holder: { agentId: "a-2", sessionKey: "s-2" } });
    await router.acquire({ holder: { agentId: "a-3", sessionKey: "s-3" } });

    await expect(
      router.acquire({ holder: { agentId: "a-4", sessionKey: "s-4" } }),
    ).rejects.toMatchObject({ code: "NO_DEV_PROFILE_AVAILABLE" });
  });

  it("reclaims a stale lease on acquire", async () => {
    const { statePath, router } = await createHarness({
      now: new Date("2026-04-20T20:00:00.000Z"),
    });
    const state = createEmptyBrowserPoolState();
    state.profiles["dev-01"].lease = {
      leaseId: "stale-lease",
      holderKey: "sk:old",
      agentId: "agent-old",
      sessionKey: "old",
      sessionId: null,
      workflowRunId: null,
      task: null,
      acquiredAt: "2026-04-20T18:00:00.000Z",
      lastSeenAt: "2026-04-20T18:30:00.000Z",
      expiresAt: "2026-04-20T19:00:00.000Z",
    };
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

    const result = await router.acquire({ holder: { agentId: "agent-new", sessionKey: "new" } });

    expect(result.profile).toBe("dev-01");
    expect(result.leaseId).toBe("lease_1");
  });

  it("extends TTL on heartbeat", async () => {
    const { router } = await createHarness();
    const acquired = await router.acquire({
      holder: { agentId: "agent-1", sessionKey: "session-1" },
    });

    const heartbeat = await router.heartbeat({
      profile: acquired.profile,
      leaseId: acquired.leaseId,
      ttlSeconds: 7200,
    });

    expect(heartbeat.lastSeenAt).toBe("2026-04-20T20:00:00.000Z");
    expect(heartbeat.expiresAt).toBe("2026-04-20T22:00:00.000Z");
  });

  it("releases with the correct leaseId", async () => {
    const { router } = await createHarness();
    const acquired = await router.acquire({
      holder: { agentId: "agent-1", sessionKey: "session-1" },
    });

    const released = await router.release({ profile: acquired.profile, leaseId: acquired.leaseId });

    expect(released).toMatchObject({
      ok: true,
      profile: "dev-01",
      leaseId: acquired.leaseId,
      stoppedBrowser: true,
      released: true,
    });
  });

  it("fails release with the wrong leaseId", async () => {
    const { router } = await createHarness();
    const acquired = await router.acquire({
      holder: { agentId: "agent-1", sessionKey: "session-1" },
    });

    await expect(
      router.release({ profile: acquired.profile, leaseId: "wrong-lease" }),
    ).rejects.toMatchObject({
      code: "LEASE_MISMATCH",
    });
  });

  it("derives holderKey from workflow and session context priority", () => {
    expect(
      resolveHolderKey({
        agentId: "agent",
        workflowRunId: "wf-1",
        sessionKey: "sk-1",
        sessionId: "sid-1",
      }),
    ).toBe("wf:wf-1");
    expect(resolveHolderKey({ agentId: "agent", sessionKey: "sk-1", sessionId: "sid-1" })).toBe(
      "sk:sk-1",
    );
    expect(resolveHolderKey({ agentId: "agent", sessionId: "sid-1" })).toBe("sid:sid-1");
  });

  it("stops the browser before releasing active and stale leases", async () => {
    const stoppedProfiles: string[] = [];
    const { statePath, router } = await createHarness({
      stopImpl: async (profile) => {
        stoppedProfiles.push(profile);
        return { stopped: true };
      },
    });

    const acquired = await router.acquire({
      holder: { agentId: "agent-1", sessionKey: "session-1" },
    });
    await expect(
      router.release({ profile: acquired.profile, leaseId: acquired.leaseId }),
    ).resolves.toMatchObject({
      profile: "dev-01",
      released: true,
      stoppedBrowser: true,
    });

    const state = createEmptyBrowserPoolState();
    state.profiles["dev-02"].lease = {
      leaseId: "stale-lease",
      holderKey: "sk:stale",
      agentId: "agent-stale",
      sessionKey: "stale",
      sessionId: null,
      workflowRunId: null,
      task: null,
      acquiredAt: "2026-04-20T17:00:00.000Z",
      lastSeenAt: "2026-04-20T17:10:00.000Z",
      expiresAt: "2026-04-20T19:00:00.000Z",
    };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

    await expect(router.sweepStale()).resolves.toMatchObject({
      count: 1,
      reclaimed: [
        {
          profile: "dev-02",
          released: true,
          stoppedBrowser: true,
        },
      ],
    });

    expect(stoppedProfiles).toEqual(["dev-01", "dev-02"]);
  });

  it("surfaces stop failures", async () => {
    const { router } = await createHarness({
      stopImpl: async () => {
        throw new BrowserPoolError("PROFILE_STOP_FAILED", "stop failed");
      },
    });
    const acquired = await router.acquire({
      holder: { agentId: "agent-1", sessionKey: "session-1" },
    });

    await expect(
      router.release({ profile: acquired.profile, leaseId: acquired.leaseId }),
    ).rejects.toMatchObject({ code: "PROFILE_STOP_FAILED" });
  });

  it("initializes empty-start state when missing", async () => {
    const { home } = await createHarness();
    const state = await readBrowserPoolState({
      statePath: resolveBrowserPoolStatePath({ HOME: home }),
      initializeIfMissing: true,
    });

    expect(state.profiles["dev-01"].lease).toBeNull();
    await expect(fs.stat(resolveBrowserPoolStatePath({ HOME: home }))).resolves.toBeTruthy();
  });

  it("fails cleanly on a corrupt state file", async () => {
    const { statePath } = await createHarness();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "{ invalid json\n", "utf8");

    await expect(readBrowserPoolState({ statePath })).rejects.toMatchObject({
      code: "STATE_IO_ERROR",
    });
  });

  it("does not double allocate under concurrent acquire calls", async () => {
    const { router } = await createHarness();

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        router.acquire({
          holder: { agentId: `agent-${index + 1}`, sessionKey: `session-${index + 1}` },
        }),
      ),
    );

    const fulfilled = results
      .filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof router.acquire>>> => {
          return result.status === "fulfilled";
        },
      )
      .map((result) => result.value.profile);
    const rejected = results.filter((result) => result.status === "rejected");

    expect(new Set(fulfilled)).toEqual(new Set(["dev-01", "dev-02", "dev-03"]));
    expect(rejected).toHaveLength(1);
  });
});
