import { randomUUID } from "node:crypto";
import {
  resolveBrowserConfig,
  resolveProfile,
} from "../../../../extensions/browser/src/browser-runtime.js";
import { loadConfig } from "../../../config/config.js";
import {
  createEmptyBrowserPoolState,
  readBrowserPoolState,
  withBrowserPoolStateLock,
  writeBrowserPoolState,
} from "./state.js";
import { stopBrowserPoolProfile } from "./stop-profile.js";
import {
  assertDevBrowserProfileName,
  BrowserPoolError,
  DEV_BROWSER_PROFILES,
  type BrowserPoolAcquireResult,
  type BrowserPoolHolderContext,
  type BrowserPoolLease,
  type BrowserPoolReleaseResult,
  type BrowserPoolRenewResult,
  type BrowserPoolState,
  type BrowserPoolStatusResult,
  type BrowserPoolSweepReclaimedResult,
  type BrowserPoolSweepResult,
  type DevBrowserProfileName,
} from "./types.js";

export const DEFAULT_LEASE_TTL_SECONDS = 3600;
export const MIN_LEASE_TTL_SECONDS = 60;
export const MAX_LEASE_TTL_SECONDS = 86400;

type RouterDeps = {
  statePath?: string;
  now?: () => Date;
  inspectProfiles?: () => Promise<Record<DevBrowserProfileName, boolean>>;
  stopProfile?: (profile: DevBrowserProfileName) => Promise<{ stopped: boolean }>;
  leaseIdFactory?: () => string;
  lockTimeoutMs?: number;
};

function toIso(date: Date): string {
  return date.toISOString();
}

function plusSeconds(date: Date, ttlSeconds: number): string {
  return new Date(date.getTime() + ttlSeconds * 1000).toISOString();
}

export function resolveHolderKey(holder: BrowserPoolHolderContext): string {
  if (holder.workflowRunId?.trim()) {
    return `wf:${holder.workflowRunId.trim()}`;
  }
  if (holder.sessionKey?.trim()) {
    return `sk:${holder.sessionKey.trim()}`;
  }
  if (holder.sessionId?.trim()) {
    return `sid:${holder.sessionId.trim()}`;
  }
  throw new BrowserPoolError(
    "INVALID_ARGUMENT",
    "At least one of workflowRunId, sessionKey, or sessionId is required.",
  );
}

export function isLeaseStale(lease: BrowserPoolLease, now: Date): boolean {
  return Date.parse(lease.expiresAt) <= now.getTime();
}

export async function resolveBrowserPoolProfileAvailability(): Promise<
  Record<DevBrowserProfileName, boolean>
> {
  try {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    return {
      "dev-01": Boolean(resolveProfile(resolved, "dev-01")),
      "dev-02": Boolean(resolveProfile(resolved, "dev-02")),
      "dev-03": Boolean(resolveProfile(resolved, "dev-03")),
    };
  } catch (err) {
    throw new BrowserPoolError(
      "PROFILE_NOT_READY",
      "Unable to resolve dev browser profiles from the OpenClaw config.",
      { cause: err },
    );
  }
}

async function mutateBrowserPoolState<T>(
  deps: RouterDeps,
  fn: (state: BrowserPoolState, now: Date) => Promise<T>,
): Promise<T> {
  return await withBrowserPoolStateLock(
    async () => {
      const state = await readBrowserPoolState({
        statePath: deps.statePath,
        initializeIfMissing: true,
      });
      const now = deps.now ? deps.now() : new Date();
      return await fn(state, now);
    },
    { statePath: deps.statePath, timeoutMs: deps.lockTimeoutMs },
  );
}

function buildLease(params: {
  holder: BrowserPoolHolderContext;
  holderKey: string;
  ttlSeconds: number;
  now: Date;
  leaseIdFactory?: () => string;
}): BrowserPoolLease {
  const timestamp = toIso(params.now);
  return {
    leaseId: params.leaseIdFactory ? params.leaseIdFactory() : `lease_${randomUUID()}`,
    holderKey: params.holderKey,
    agentId: params.holder.agentId,
    sessionKey: params.holder.sessionKey?.trim() || null,
    sessionId: params.holder.sessionId?.trim() || null,
    workflowRunId: params.holder.workflowRunId?.trim() || null,
    task: params.holder.task?.trim() || null,
    acquiredAt: timestamp,
    lastSeenAt: timestamp,
    expiresAt: plusSeconds(params.now, params.ttlSeconds),
  };
}

export function validateLeaseTtlSeconds(value: number): number {
  if (!Number.isInteger(value)) {
    throw new BrowserPoolError("INVALID_ARGUMENT", "ttlSeconds must be an integer.");
  }
  if (value < MIN_LEASE_TTL_SECONDS || value > MAX_LEASE_TTL_SECONDS) {
    throw new BrowserPoolError(
      "INVALID_ARGUMENT",
      `ttlSeconds must be between ${MIN_LEASE_TTL_SECONDS} and ${MAX_LEASE_TTL_SECONDS}.`,
    );
  }
  return value;
}

export function validateAcquireHolder(holder: BrowserPoolHolderContext): BrowserPoolHolderContext {
  if (!holder.agentId.trim()) {
    throw new BrowserPoolError("INVALID_ARGUMENT", "agentId is required.");
  }
  void resolveHolderKey(holder);
  return holder;
}

export function createBrowserPoolRouter(deps: RouterDeps = {}) {
  const inspectProfiles = deps.inspectProfiles ?? resolveBrowserPoolProfileAvailability;
  const stopProfile = deps.stopProfile ?? stopBrowserPoolProfile;

  return {
    async status(): Promise<BrowserPoolStatusResult> {
      return await mutateBrowserPoolState(deps, async (state, now) => {
        const availability = await inspectProfiles();
        return {
          ok: true,
          profiles: DEV_BROWSER_PROFILES.map((profile) => {
            const lease = state.profiles[profile].lease;
            const stale = lease ? isLeaseStale(lease, now) : false;
            return {
              profile,
              leaseActive: Boolean(lease),
              leaseStale: stale,
              leaseId: lease?.leaseId ?? null,
              holderKey: lease?.holderKey ?? null,
              agentId: lease?.agentId ?? null,
              sessionKey: lease?.sessionKey ?? null,
              sessionId: lease?.sessionId ?? null,
              workflowRunId: lease?.workflowRunId ?? null,
              acquiredAt: lease?.acquiredAt ?? null,
              lastSeenAt: lease?.lastSeenAt ?? null,
              expiresAt: lease?.expiresAt ?? null,
              profileExists: availability[profile],
            };
          }),
        };
      });
    },

    async acquire(params: {
      holder: BrowserPoolHolderContext;
      ttlSeconds?: number;
    }): Promise<BrowserPoolAcquireResult> {
      const holder = validateAcquireHolder(params.holder);
      const ttlSeconds = validateLeaseTtlSeconds(params.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS);
      const holderKey = resolveHolderKey(holder);
      return await mutateBrowserPoolState(deps, async (state, now) => {
        const availability = await inspectProfiles();

        for (const profile of DEV_BROWSER_PROFILES) {
          if (!availability[profile]) {
            continue;
          }
          const currentLease = state.profiles[profile].lease;
          if (currentLease && !isLeaseStale(currentLease, now)) {
            continue;
          }
          const lease = buildLease({
            holder,
            holderKey,
            ttlSeconds,
            now,
            leaseIdFactory: deps.leaseIdFactory,
          });
          state.profiles[profile].lease = lease;
          await writeBrowserPoolState(state, { statePath: deps.statePath });
          return {
            ok: true,
            profile,
            leaseId: lease.leaseId,
            leaseTtlSeconds: ttlSeconds,
            acquiredAt: lease.acquiredAt,
            expiresAt: lease.expiresAt,
            holder: {
              holderKey: lease.holderKey,
              agentId: lease.agentId,
              workflowRunId: lease.workflowRunId,
              sessionKey: lease.sessionKey,
              sessionId: lease.sessionId,
              task: lease.task,
            },
          };
        }

        throw new BrowserPoolError(
          "NO_DEV_PROFILE_AVAILABLE",
          "No free dev browser profile is available.",
        );
      });
    },

    async renew(params: {
      profile: string;
      leaseId: string;
      ttlSeconds?: number;
    }): Promise<BrowserPoolRenewResult> {
      const profile = assertDevBrowserProfileName(params.profile);
      const ttlSeconds = validateLeaseTtlSeconds(params.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS);
      if (!params.leaseId.trim()) {
        throw new BrowserPoolError("INVALID_ARGUMENT", "leaseId is required.");
      }
      return await mutateBrowserPoolState(deps, async (state, now) => {
        const lease = state.profiles[profile].lease;
        if (!lease) {
          throw new BrowserPoolError(
            "LEASE_NOT_FOUND",
            `No lease is active for profile ${profile}.`,
          );
        }
        if (lease.leaseId !== params.leaseId) {
          throw new BrowserPoolError(
            "LEASE_MISMATCH",
            `Lease id ${params.leaseId} does not own profile ${profile}.`,
          );
        }
        lease.lastSeenAt = toIso(now);
        lease.expiresAt = plusSeconds(now, ttlSeconds);
        await writeBrowserPoolState(state, { statePath: deps.statePath });
        return {
          ok: true,
          profile,
          leaseId: lease.leaseId,
          lastSeenAt: lease.lastSeenAt,
          expiresAt: lease.expiresAt,
        };
      });
    },

    async release(params: {
      profile: string;
      leaseId: string;
      stopBrowser?: boolean;
    }): Promise<BrowserPoolReleaseResult> {
      const profile = assertDevBrowserProfileName(params.profile);
      if (!params.leaseId.trim()) {
        throw new BrowserPoolError("INVALID_ARGUMENT", "leaseId is required.");
      }
      return await mutateBrowserPoolState(deps, async (state) => {
        const lease = state.profiles[profile].lease;
        if (!lease) {
          throw new BrowserPoolError(
            "LEASE_NOT_FOUND",
            `No lease is active for profile ${profile}.`,
          );
        }
        if (lease.leaseId !== params.leaseId) {
          throw new BrowserPoolError(
            "LEASE_MISMATCH",
            `Lease id ${params.leaseId} does not own profile ${profile}.`,
          );
        }
        let stoppedBrowser = false;
        if (params.stopBrowser !== false) {
          const stopResult = await stopProfile(profile);
          stoppedBrowser = stopResult.stopped;
        }
        state.profiles[profile].lease = null;
        await writeBrowserPoolState(state, { statePath: deps.statePath });
        return {
          ok: true,
          profile,
          leaseId: lease.leaseId,
          stoppedBrowser,
          released: true,
        };
      });
    },

    async sweepStale(params?: { stopBrowser?: boolean }): Promise<BrowserPoolSweepResult> {
      return await mutateBrowserPoolState(deps, async (state, now) => {
        const reclaimed: BrowserPoolSweepReclaimedResult[] = [];
        for (const profile of DEV_BROWSER_PROFILES) {
          const lease = state.profiles[profile].lease;
          if (!lease || !isLeaseStale(lease, now)) {
            continue;
          }
          let stoppedBrowser = false;
          if (params?.stopBrowser !== false) {
            const stopResult = await stopProfile(profile);
            stoppedBrowser = stopResult.stopped;
          }
          state.profiles[profile].lease = null;
          await writeBrowserPoolState(state, { statePath: deps.statePath });
          reclaimed.push({
            profile,
            leaseId: lease.leaseId,
            stoppedBrowser,
            released: true,
          });
        }
        return {
          ok: true,
          reclaimed,
          count: reclaimed.length,
        };
      });
    },
  };
}

export async function initializeBrowserPoolState(params?: { statePath?: string }): Promise<void> {
  const statePath = params?.statePath;
  await withBrowserPoolStateLock(
    async () => {
      const state = await readBrowserPoolState({ statePath, initializeIfMissing: false });
      const next = state ?? createEmptyBrowserPoolState();
      await writeBrowserPoolState(next, { statePath });
    },
    { statePath },
  );
}
