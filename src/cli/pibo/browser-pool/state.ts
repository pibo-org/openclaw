import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../../../infra/json-files.js";
import {
  BrowserPoolError,
  DEV_BROWSER_PROFILES,
  type BrowserPoolLease,
  type BrowserPoolProfileState,
  type BrowserPoolState,
  type DevBrowserProfileName,
} from "./types.js";

const STATE_FILENAME = "dev-browser-profile-router.json";
const LOCK_FILENAME = `${STATE_FILENAME}.lock`;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;
const DEFAULT_LOCK_STALE_MS = 30000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseIsoString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty ISO timestamp string`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid ISO timestamp string`);
  }
  return value;
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Expected string, null, or undefined");
  }
  return value;
}

function parseLease(value: unknown): BrowserPoolLease | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error("lease must be an object or null");
  }
  if (typeof record.leaseId !== "string" || !record.leaseId.trim()) {
    throw new Error("lease.leaseId must be a non-empty string");
  }
  if (typeof record.holderKey !== "string" || !record.holderKey.trim()) {
    throw new Error("lease.holderKey must be a non-empty string");
  }
  if (typeof record.agentId !== "string" || !record.agentId.trim()) {
    throw new Error("lease.agentId must be a non-empty string");
  }
  return {
    leaseId: record.leaseId,
    holderKey: record.holderKey,
    agentId: record.agentId,
    sessionKey: normalizeNullableString(record.sessionKey),
    sessionId: normalizeNullableString(record.sessionId),
    workflowRunId: normalizeNullableString(record.workflowRunId),
    task: normalizeNullableString(record.task),
    acquiredAt: parseIsoString(record.acquiredAt, "lease.acquiredAt"),
    lastSeenAt: parseIsoString(record.lastSeenAt, "lease.lastSeenAt"),
    expiresAt: parseIsoString(record.expiresAt, "lease.expiresAt"),
  };
}

function parseProfileState(
  profile: DevBrowserProfileName,
  value: unknown,
): BrowserPoolProfileState {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`profiles.${profile} must be an object`);
  }
  if (record.class !== "dev") {
    throw new Error(`profiles.${profile}.class must equal "dev"`);
  }
  return {
    class: "dev",
    lease: parseLease(record.lease),
  };
}

export function createEmptyBrowserPoolState(): BrowserPoolState {
  return {
    version: 1,
    profiles: {
      "dev-01": { class: "dev", lease: null },
      "dev-02": { class: "dev", lease: null },
      "dev-03": { class: "dev", lease: null },
    },
  };
}

export function normalizeBrowserPoolState(raw: unknown): BrowserPoolState {
  const record = asRecord(raw);
  if (!record) {
    throw new Error("state must be an object");
  }
  if (record.version !== 1) {
    throw new Error(`state.version must equal 1`);
  }
  const profiles = asRecord(record.profiles);
  if (!profiles) {
    throw new Error("state.profiles must be an object");
  }
  const next = createEmptyBrowserPoolState();
  for (const profile of DEV_BROWSER_PROFILES) {
    const rawProfile = profiles[profile];
    next.profiles[profile] =
      rawProfile === undefined
        ? { class: "dev", lease: null }
        : parseProfileState(profile, rawProfile);
  }
  return next;
}

export function resolveBrowserPoolStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const homeDir = env.HOME?.trim() || os.homedir();
  return path.join(homeDir, ".openclaw", "pibo", STATE_FILENAME);
}

function resolveBrowserPoolLockPath(statePath: string): string {
  return path.join(path.dirname(statePath), LOCK_FILENAME);
}

export async function readBrowserPoolState(params?: {
  statePath?: string;
  initializeIfMissing?: boolean;
}): Promise<BrowserPoolState> {
  const statePath = params?.statePath ?? resolveBrowserPoolStatePath();
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return normalizeBrowserPoolState(JSON.parse(raw));
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      const empty = createEmptyBrowserPoolState();
      if (params?.initializeIfMissing) {
        await writeBrowserPoolState(empty, { statePath });
      }
      return empty;
    }
    throw new BrowserPoolError(
      "STATE_IO_ERROR",
      `Failed to read browser pool state at ${statePath}.`,
      {
        cause: err,
      },
    );
  }
}

export async function writeBrowserPoolState(
  state: BrowserPoolState,
  params?: { statePath?: string },
): Promise<void> {
  const statePath = params?.statePath ?? resolveBrowserPoolStatePath();
  try {
    await writeJsonAtomic(statePath, state, { mode: 0o600, trailingNewline: true });
  } catch (err) {
    throw new BrowserPoolError(
      "STATE_IO_ERROR",
      `Failed to write browser pool state at ${statePath}.`,
      { cause: err },
    );
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withBrowserPoolStateLock<T>(
  fn: () => Promise<T>,
  params?: {
    statePath?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleMs?: number;
  },
): Promise<T> {
  const statePath = params?.statePath ?? resolveBrowserPoolStatePath();
  const lockPath = resolveBrowserPoolLockPath(statePath);
  const timeoutMs = params?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollIntervalMs = params?.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const staleMs = params?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const startedAt = Date.now();

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (err) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") {
        throw new BrowserPoolError(
          "STATE_IO_ERROR",
          `Failed to acquire state lock at ${lockPath}.`,
          {
            cause: err,
          },
        );
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new BrowserPoolError(
          "STATE_LOCK_TIMEOUT",
          `Timed out waiting for browser pool state lock at ${lockPath}.`,
        );
      }

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }

      await sleep(pollIntervalMs);
      continue;
    }

    try {
      if (!handle) {
        throw new BrowserPoolError(
          "STATE_IO_ERROR",
          `Failed to acquire state lock at ${lockPath}.`,
        );
      }
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2) + "\n",
          "utf8",
        );
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } finally {
      handle = null;
    }
  }
}
