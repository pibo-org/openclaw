import {
  createBrowserPoolRouter,
  DEFAULT_LEASE_TTL_SECONDS,
  validateAcquireHolder,
  validateLeaseTtlSeconds,
} from "../browser-pool/router.js";
import { BrowserPoolError } from "../browser-pool/types.js";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalTtlSeconds(value: unknown): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new BrowserPoolError("INVALID_ARGUMENT", "ttlSeconds must be a positive integer.");
  }
  return validateLeaseTtlSeconds(Number(normalized));
}

function printJson(payload: unknown) {
  console.log(JSON.stringify(payload, null, 2));
}

function formatStatusLine(entry: {
  profile: string;
  profileExists: boolean;
  leaseActive: boolean;
  leaseStale: boolean;
  leaseId: string | null;
  holderKey: string | null;
  expiresAt: string | null;
}): string {
  if (!entry.profileExists) {
    return `${entry.profile}: missing`;
  }
  if (!entry.leaseActive) {
    return `${entry.profile}: free`;
  }
  return `${entry.profile}: ${entry.leaseStale ? "stale" : "active"} lease=${entry.leaseId ?? "-"} holder=${entry.holderKey ?? "-"} expiresAt=${entry.expiresAt ?? "-"}`;
}

export async function browserPoolStatus(opts: { json?: boolean }) {
  const router = createBrowserPoolRouter();
  const result = await router.status();
  if (opts.json) {
    printJson(result);
    return;
  }
  for (const entry of result.profiles) {
    console.log(formatStatusLine(entry));
  }
}

export async function browserPoolAcquire(opts: {
  agentId?: string;
  workflowRunId?: string;
  sessionKey?: string;
  sessionId?: string;
  task?: string;
  ttlSeconds?: string;
}) {
  const router = createBrowserPoolRouter();
  const holder = validateAcquireHolder({
    agentId: normalizeOptionalString(opts.agentId) ?? "",
    workflowRunId: normalizeOptionalString(opts.workflowRunId),
    sessionKey: normalizeOptionalString(opts.sessionKey),
    sessionId: normalizeOptionalString(opts.sessionId),
    task: normalizeOptionalString(opts.task),
  });
  const result = await router.acquire({
    holder,
    ttlSeconds: parseOptionalTtlSeconds(opts.ttlSeconds) ?? DEFAULT_LEASE_TTL_SECONDS,
  });
  printJson(result);
}

export async function browserPoolHeartbeat(opts: {
  profile?: string;
  leaseId?: string;
  ttlSeconds?: string;
}) {
  const router = createBrowserPoolRouter();
  const profile = normalizeOptionalString(opts.profile);
  if (!profile) {
    throw new BrowserPoolError("INVALID_ARGUMENT", "profile is required.");
  }
  const leaseId = normalizeOptionalString(opts.leaseId);
  if (!leaseId) {
    throw new BrowserPoolError("INVALID_ARGUMENT", "leaseId is required.");
  }
  const result = await router.heartbeat({
    profile,
    leaseId,
    ttlSeconds: parseOptionalTtlSeconds(opts.ttlSeconds) ?? DEFAULT_LEASE_TTL_SECONDS,
  });
  printJson(result);
}

export async function browserPoolRelease(opts: { profile?: string; leaseId?: string }) {
  const router = createBrowserPoolRouter();
  const profile = normalizeOptionalString(opts.profile);
  if (!profile) {
    throw new BrowserPoolError("INVALID_ARGUMENT", "profile is required.");
  }
  const leaseId = normalizeOptionalString(opts.leaseId);
  if (!leaseId) {
    throw new BrowserPoolError("INVALID_ARGUMENT", "leaseId is required.");
  }
  const result = await router.release({ profile, leaseId });
  printJson(result);
}

export async function browserPoolSweepStale() {
  const router = createBrowserPoolRouter();
  const result = await router.sweepStale();
  printJson(result);
}
