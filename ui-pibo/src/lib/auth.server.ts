import "@tanstack/react-start/server-only";
import {
  createSessionTokenForConfig,
  isValidCredentialLogin as isValidCredentialLoginForConfig,
  resolveAuthConfig,
  verifySessionToken,
} from "@pibo/shared-auth";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";

function getAuthConfig() {
  return resolveAuthConfig(process.env);
}

export function getConfiguredUsername() {
  return getAuthConfig().username;
}

export function createWebSessionToken(username: string) {
  return createSessionTokenForConfig(username, getAuthConfig());
}

export function setSessionCookie(username: string) {
  const config = getAuthConfig();
  setCookie(config.sessionCookieName ?? "webapp_session", createWebSessionToken(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionDurationSeconds,
    path: "/",
    ...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {}),
  });
}

export function clearSessionCookie() {
  const config = getAuthConfig();
  deleteCookie(config.sessionCookieName ?? "webapp_session", {
    path: "/",
    ...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {}),
  });
}

export function getAuthenticatedUsername(): string | null {
  const config = getAuthConfig();
  const token = getCookie(config.sessionCookieName ?? "webapp_session");
  if (!token) {
    return null;
  }

  const payload = verifySessionToken(token, config);
  if (!payload) {
    return null;
  }

  if (payload.sub !== config.username) {
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
  return isValidCredentialLoginForConfig(username, password, getAuthConfig());
}
