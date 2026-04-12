import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveDevGatewayToken(): string | undefined {
  const home = process.env.HOME?.trim();
  if (!home) {
    return undefined;
  }
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      gateway?: { auth?: { token?: unknown } };
    };
    const token = parsed.gateway?.auth?.token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export default defineConfig(({ command }) => {
  const envBase = process.env.OPENCLAW_CUSTOM_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  const devGatewayToken = command === "serve" ? resolveDevGatewayToken() : undefined;
  return {
    base,
    define: {
      __OPENCLAW_DEV_GATEWAY_TOKEN__: JSON.stringify(devGatewayToken),
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "custom-web-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                assistantAvatar: "",
                assistantName: "OpenClaw",
                basePath: "/",
              }),
            );
          });
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(here, "src"),
      },
    },
    build: {
      outDir: path.resolve(here, "../dist/custom-web-ui"),
      emptyOutDir: true,
      sourcemap: true,
      chunkSizeWarningLimit: 1024,
    },
    server: {
      fs: {
        allow: [path.resolve(here, "..")],
      },
      host: true,
      port: 5174,
      proxy: {
        "/__openclaw/gateway": {
          target: "ws://127.0.0.1:18789",
          ws: true,
          rewrite: () => "/",
        },
      },
      strictPort: true,
    },
  };
});
