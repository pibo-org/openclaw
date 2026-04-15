import { createServer } from "node:http";
import serverEntry from "./dist/server/server.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 3010);
const DEFAULT_CHAT_BASE_PATH = "/chat";
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(rootDir, "dist/client");
const mime = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function normalizeBasePath(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutSlashes ? `/${withoutSlashes}` : "";
}

function withBasePath(pathname, basePath) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return basePath ? `${basePath}${normalizedPath}` : normalizedPath;
}

const basePath = normalizeBasePath(
  process.env.CHAT_BASE_PATH || process.env.VITE_CHAT_BASE_PATH || DEFAULT_CHAT_BASE_PATH,
);
const controlUiConfigPath = withBasePath("/__openclaw/control-ui-config.json", basePath);
const assetsPathPrefix = withBasePath("/assets/", basePath);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`);

    if (url.pathname === controlUiConfigPath) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          assistantAvatar: "",
          assistantName: "OpenClaw",
          basePath,
        }),
      );
      return;
    }

    if (url.pathname.startsWith(assetsPathPrefix)) {
      const relativePath = url.pathname.slice((basePath ? `${basePath}/` : "/").length);
      const filePath = path.join(clientDir, relativePath);
      let data;
      try {
        data = await readFile(filePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        throw error;
      }
      const ext = path.extname(filePath);
      res.statusCode = 200;
      res.setHeader("content-type", mime.get(ext) || "application/octet-stream");
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.end(data);
      return;
    }

    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method && req.method !== "GET" && req.method !== "HEAD" ? req : undefined,
      duplex: "half",
    });

    const fetchHandler =
      typeof serverEntry.fetch === "function"
        ? (request) => serverEntry.fetch(request)
        : typeof serverEntry.default?.fetch === "function"
          ? (request) => serverEntry.default.fetch(request)
          : null;
    if (typeof fetchHandler !== "function") {
      throw new TypeError("fetchHandler is not a function");
    }
    const response = await fetchHandler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {break;}
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    console.error("[chat-server-prod] request failed", error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[chat-server-prod] listening on 127.0.0.1:${port}`);
});
