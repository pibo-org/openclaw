import { DEFAULT_SESSION_DURATION, type AuthConfig, type SharedAuthEnv } from "./types.js";
import {
  DEFAULT_JWT_SECRET,
  DEFAULT_PASSWORD,
  DEFAULT_PRODUCTION_SESSION_COOKIE_DOMAIN,
  DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_USERNAME,
} from "./constants.js";

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseDurationSeconds(raw: string | undefined): number | undefined {
  const trimmed = trimToUndefined(raw);
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid APP_SESSION_DURATION_SECONDS: ${raw}`);
  }

  return parsed;
}

export function resolveAuthConfig(env: SharedAuthEnv = process.env): AuthConfig {
  const nodeEnv = trimToUndefined(env.NODE_ENV);
  const sessionCookieDomain =
    trimToUndefined(env.APP_SESSION_COOKIE_DOMAIN) ??
    (nodeEnv === "production" ? DEFAULT_PRODUCTION_SESSION_COOKIE_DOMAIN : undefined);

  return {
    username: trimToUndefined(env.APP_USERNAME) ?? DEFAULT_USERNAME,
    password: trimToUndefined(env.APP_PASSWORD) ?? DEFAULT_PASSWORD,
    jwtSecret: trimToUndefined(env.APP_JWT_SECRET) ?? DEFAULT_JWT_SECRET,
    sessionDurationSeconds:
      parseDurationSeconds(env.APP_SESSION_DURATION_SECONDS) ?? DEFAULT_SESSION_DURATION,
    sessionCookieName: trimToUndefined(env.APP_SESSION_COOKIE_NAME) ?? DEFAULT_SESSION_COOKIE_NAME,
    sessionCookieDomain,
  };
}
