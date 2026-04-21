export const DEV_BROWSER_PROFILES = ["dev-01", "dev-02", "dev-03"] as const;

export type DevBrowserProfileName = (typeof DEV_BROWSER_PROFILES)[number];

export type BrowserPoolErrorCode =
  | "NO_DEV_PROFILE_AVAILABLE"
  | "UNKNOWN_PROFILE"
  | "LEASE_NOT_FOUND"
  | "LEASE_MISMATCH"
  | "INVALID_ARGUMENT"
  | "PROFILE_NOT_READY"
  | "PROFILE_STOP_FAILED"
  | "STATE_IO_ERROR"
  | "STATE_LOCK_TIMEOUT";

export type BrowserPoolLease = {
  leaseId: string;
  holderKey: string;
  agentId: string;
  sessionKey?: string | null;
  sessionId?: string | null;
  workflowRunId?: string | null;
  task?: string | null;
  acquiredAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type BrowserPoolProfileState = {
  class: "dev";
  lease: BrowserPoolLease | null;
};

export type BrowserPoolState = {
  version: 1;
  profiles: Record<DevBrowserProfileName, BrowserPoolProfileState>;
};

export type BrowserPoolHolderContext = {
  agentId: string;
  workflowRunId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  task?: string | null;
};

export type BrowserPoolStatusEntry = {
  profile: DevBrowserProfileName;
  leaseActive: boolean;
  leaseStale: boolean;
  leaseId: string | null;
  holderKey: string | null;
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  workflowRunId: string | null;
  acquiredAt: string | null;
  lastSeenAt: string | null;
  expiresAt: string | null;
  profileExists: boolean;
};

export type BrowserPoolStatusResult = {
  ok: true;
  profiles: BrowserPoolStatusEntry[];
};

export type BrowserPoolAcquireResult = {
  ok: true;
  profile: DevBrowserProfileName;
  leaseId: string;
  leaseTtlSeconds: number;
  acquiredAt: string;
  expiresAt: string;
  holder: {
    holderKey: string;
    agentId: string;
    workflowRunId?: string | null;
    sessionKey?: string | null;
    sessionId?: string | null;
    task?: string | null;
  };
};

export type BrowserPoolRenewResult = {
  ok: true;
  profile: DevBrowserProfileName;
  leaseId: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type BrowserPoolReleaseResult = {
  ok: true;
  profile: DevBrowserProfileName;
  leaseId: string;
  stoppedBrowser: boolean;
  released: true;
};

export type BrowserPoolSweepReclaimedResult = {
  profile: DevBrowserProfileName;
  leaseId: string;
  stoppedBrowser: boolean;
  released: true;
};

export type BrowserPoolSweepResult = {
  ok: true;
  reclaimed: BrowserPoolSweepReclaimedResult[];
  count: number;
};

export class BrowserPoolError extends Error {
  readonly code: BrowserPoolErrorCode;

  constructor(code: BrowserPoolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserPoolError";
    this.code = code;
  }
}

export function isDevBrowserProfileName(value: string): value is DevBrowserProfileName {
  return DEV_BROWSER_PROFILES.includes(value as DevBrowserProfileName);
}

export function assertDevBrowserProfileName(value: string): DevBrowserProfileName {
  if (!isDevBrowserProfileName(value)) {
    throw new BrowserPoolError(
      "UNKNOWN_PROFILE",
      `Unknown dev browser profile: ${value}. Expected one of ${DEV_BROWSER_PROFILES.join(", ")}.`,
    );
  }
  return value;
}
