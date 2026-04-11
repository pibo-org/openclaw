import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import serverEntry from "./dist/server/server.js";

const port = Number(process.env.PORT || 3000);
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`);

    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/media/")) {
      const filePath = path.join(clientDir, url.pathname.replace(/^\//, ""));
      const data = await readFile(filePath);
      const ext = path.extname(filePath);
      res.statusCode = 200;
      res.setHeader("content-type", mime.get(ext) || "application/octet-stream");
      if (url.pathname.startsWith("/assets/")) {
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
      }
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
      serverEntry.fetch?.bind(serverEntry) ?? serverEntry.default?.fetch?.bind(serverEntry.default);
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
      if (done) {
        break;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    console.error("[server-prod] request failed", error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[server-prod] listening on 127.0.0.1:${port}`);
});
