import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CHAT_BASE_PATH = '/chat'

function normalizeBasePath(value: string | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }

  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') {
    return ''
  }

  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, '')
  return withoutSlashes ? `/${withoutSlashes}` : ''
}

function withBasePath(pathname: string, basePath: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  return basePath ? `${basePath}${normalizedPath}` : normalizedPath
}

function resolveDevGatewayToken(): string | undefined {
  const home = process.env.HOME?.trim()
  if (!home) {
    return undefined
  }

  const configPath = path.join(home, '.openclaw', 'openclaw.json')
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      gateway?: { auth?: { token?: unknown } }
    }
    const token = parsed.gateway?.auth?.token
    return typeof token === 'string' && token.trim() ? token.trim() : undefined
  } catch {
    return undefined
  }
}

export default defineConfig(({ command }) => {
  const devGatewayToken = command === 'serve' ? resolveDevGatewayToken() : undefined
  const chatBasePath = normalizeBasePath(
    process.env.CHAT_BASE_PATH ?? process.env.VITE_CHAT_BASE_PATH ?? DEFAULT_CHAT_BASE_PATH,
  )

  process.env.VITE_CHAT_BASE_PATH = chatBasePath || '/'

  return {
    base: chatBasePath ? `${chatBasePath}/` : '/',
    define: {
      __OPENCLAW_DEV_GATEWAY_TOKEN__: JSON.stringify(devGatewayToken),
    },
    plugins: [
      devtools(),
      tsconfigPaths({ projects: ['./tsconfig.json'] }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
      {
        name: 'chat-app-dev-stubs',
        configureServer(server) {
          server.middlewares.use(
            withBasePath('/__openclaw/control-ui-config.json', chatBasePath),
            (_req, res) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                assistantAvatar: '',
                assistantName: 'OpenClaw',
                basePath: chatBasePath,
              }),
            )
            },
          )
        },
      },
    ],
    server: {
      fs: {
        allow: [path.resolve(here, '../..')],
      },
      allowedHosts: ['chat.pibo.schottech.de', 'pibo.schottech.de', 'www.pibo.schottech.de'],
      host: true,
      port: 3010,
      proxy: {
        [withBasePath('/__openclaw/gateway', chatBasePath)]: {
          target: 'ws://127.0.0.1:18789',
          ws: true,
          rewrite: () => '/',
        },
      },
      strictPort: true,
    },
  }
})
