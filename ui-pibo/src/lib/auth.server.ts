import "@tanstack/react-start/server-only";
import {
  verifyJwt,
  createSessionToken,
  isValidCredential,
  DEFAULT_SESSION_DURATION,
} from "@pibo/shared-auth";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";

const SESSION_COOKIE = "webapp_session";
const SESSION_COOKIE_DOMAIN = ".pibo.schottech.de";
const SESSION_DURATION_SECONDS = DEFAULT_SESSION_DURATION;

type SessionPayload = {
  sub: string;
  type: "session";
  iat: number;
  exp: number;
};

function getEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function getJwtSecret() {
  return getEnv("APP_JWT_SECRET", "local-dev-secret-change-me-please");
}

export function getConfiguredUsername() {
  return getEnv("APP_USERNAME", "admin");
}

export function getConfiguredPassword() {
  return getEnv("APP_PASSWORD", "admin");
}

export function createWebSessionToken(username: string) {
  return createSessionToken(username, getJwtSecret(), SESSION_DURATION_SECONDS);
}

export function setSessionCookie(username: string) {
  setCookie(SESSION_COOKIE, createWebSessionToken(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DURATION_SECONDS,
    path: "/",
    domain: SESSION_COOKIE_DOMAIN,
  });
}

export function clearSessionCookie() {
  deleteCookie(SESSION_COOKIE, { path: "/", domain: SESSION_COOKIE_DOMAIN });
}

export function getAuthenticatedUsername(): string | null {
  const token = getCookie(SESSION_COOKIE);
  if (!token) {
    return null;
  }

  const payload = verifyJwt(token, getJwtSecret()) as SessionPayload | null;
  if (!payload) {
    return null;
  }

  if (payload.sub !== getConfiguredUsername()) {
    return null;
  }

  return payload.sub;
}

export function requireAuthenticatedUsername(): string {
  const username = getAuthenticatedUsername();
  if (!username) {
    throw new Error("UNAUTHORIZED");
  }
  return username;
}

export function isValidCredentialLogin(username: string, password: string): boolean {
  return isValidCredential(username, password, getConfiguredUsername(), getConfiguredPassword());
}
