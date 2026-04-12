import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import {
  clearSessionCookie,
  getConfiguredGatewayToken,
  getAuthenticatedUsername,
  isValidCredentialLoginAttempt,
  setSessionCookie,
} from './auth.server'

export type ChatBootstrapData = {
  authenticated: boolean
  gatewayToken: string | null
  username: string | null
}

function validateText(value: unknown, fieldName: string) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Missing ${fieldName}`)
  }

  return trimmed
}

async function buildBootstrap(): Promise<ChatBootstrapData> {
  const username = getAuthenticatedUsername()
  return {
    authenticated: Boolean(username),
    gatewayToken: username ? getConfiguredGatewayToken() : null,
    username,
  }
}

export const getChatBootstrap = createServerFn({ method: 'GET' }).handler(async () => {
  return buildBootstrap()
})

export const loginWithCredentials = createServerFn({ method: 'POST' })
  .inputValidator((data: { username: string; password: string }) => ({
    username: validateText(data.username, 'username'),
    password: validateText(data.password, 'password'),
  }))
  .handler(async ({ data }) => {
    if (!isValidCredentialLoginAttempt(data.username, data.password)) {
      setResponseStatus(401)
      throw new Error('Ungültige Zugangsdaten')
    }

    setSessionCookie(data.username)
    return {
      authenticated: true,
      gatewayToken: getConfiguredGatewayToken(),
      username: data.username,
    } satisfies ChatBootstrapData
  })

export const logout = createServerFn({ method: 'POST' }).handler(async () => {
  clearSessionCookie()
  return {
    authenticated: false,
    gatewayToken: null,
    username: null,
  } satisfies ChatBootstrapData
})
