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

  return {
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
          server.middlewares.use('/__openclaw/control-ui-config.json', (_req, res) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                assistantAvatar: '',
                assistantName: 'OpenClaw',
                basePath: '/',
              }),
            )
          })
        },
      },
    ],
    server: {
      fs: {
        allow: [path.resolve(here, '../..')],
      },
      allowedHosts: ['chat.pibo.schottech.de'],
      host: true,
      port: 3010,
      proxy: {
        '/__openclaw/gateway': {
          target: 'ws://127.0.0.1:18789',
          ws: true,
          rewrite: () => '/',
        },
      },
      strictPort: true,
    },
  }
})
