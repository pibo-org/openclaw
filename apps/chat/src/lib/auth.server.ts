import '@tanstack/react-start/server-only'

import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import {
  createSessionTokenForConfig,
  isValidCredentialLogin,
  resolveAuthConfig,
  verifySessionToken,
} from '@pibo/shared-auth'

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function getAuthConfig() {
  return resolveAuthConfig(process.env)
}

export function getConfiguredUsername() {
  return getAuthConfig().username
}

export function getConfiguredGatewayToken(): string | null {
  return trimToNull(process.env.OPENCLAW_GATEWAY_TOKEN)
}

export function createWebSessionToken(username: string) {
  return createSessionTokenForConfig(username, getAuthConfig())
}

export function setSessionCookie(username: string) {
  const config = getAuthConfig()
  setCookie(config.sessionCookieName ?? 'webapp_session', createWebSessionToken(username), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: config.sessionDurationSeconds,
    path: '/',
    ...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {}),
  })
}

export function clearSessionCookie() {
  const config = getAuthConfig()
  deleteCookie(config.sessionCookieName ?? 'webapp_session', {
    path: '/',
    ...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {}),
  })
}

export function getAuthenticatedUsername(): string | null {
  const config = getAuthConfig()
  const token = getCookie(config.sessionCookieName ?? 'webapp_session')
  if (!token) {
    return null
  }

  const payload = verifySessionToken(token, config)
  if (!payload) {
    return null
  }

  if (payload.sub !== config.username) {
    return null
  }

  return payload.sub
}

export function requireAuthenticatedUsername(): string {
  const username = getAuthenticatedUsername()
  if (!username) {
    throw new Error('UNAUTHORIZED')
  }
  return username
}

export function isValidCredentialLoginAttempt(username: string, password: string): boolean {
  return isValidCredentialLogin(username, password, getAuthConfig())
}
