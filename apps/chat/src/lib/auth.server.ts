import '@tanstack/react-start/server-only'

import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { issueDeviceBootstrapToken } from '../../../../src/infra/device-bootstrap.js'
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

export async function issueChatGatewayBootstrapTokenForUsername(
  username: string,
): Promise<string | null> {
  if (username !== getConfiguredUsername()) {
    throw new Error('UNAUTHORIZED')
  }
  const issued = await issueDeviceBootstrapToken({
    profile: {
      roles: ['operator'],
      scopes: ['operator.read', 'operator.write'],
    },
  })
  return trimToNull(issued.token)
}

export async function issueChatGatewayBootstrapToken(): Promise<string | null> {
  const username = requireAuthenticatedUsername()
  return issueChatGatewayBootstrapTokenForUsername(username)
}
