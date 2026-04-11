import { EventEmitter } from "node:events";
import { watch, stat, readdir } from "node:fs/promises";
// src/sse-server.ts — legacy standalone SSE server
// NOTE: Production now uses the integrated TanStack Start route
// `/api/stream/changes` together with `storage-watcher.server.ts`.
// Keep this file only as historical reference while migrating/cleaning up.
import { createServer } from "node:http";
import path from "node:path";

// ---------- Storage Watcher ----------

function getDocsRoot(): string {
  const configured = process.env.PIBO_STORAGE_DIR?.trim();
  if (!configured) {
    throw new Error("PIBO_STORAGE_DIR not set");
  }
  return path.resolve(process.cwd(), configured, "docs");
}

interface FileChangeEvent {
  path: string;
  mtimeMs: number;
  eventType: "create" | "update" | "delete";
}

class StorageWatcher extends EventEmitter {
  private knownMtimes = new Map<string, number>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs = 300;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    this.knownMtimes.clear();
    await this.scanDirectory(getDocsRoot(), "");
    this.startWatching();
    this.startPolling();
  }

  private async scanDirectory(dir: string, rel: string): Promise<void> {
    await this.scanDirectoryToMap(dir, rel, this.knownMtimes);
  }

  private async scanDirectoryToMap(
    dir: string,
    rel: string,
    target: Map<string, number>,
  ): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await this.scanDirectoryToMap(full, rel ? `${rel}/${e.name}` : e.name, target);
        } else if (e.name.endsWith(".md")) {
          try {
            const s = await stat(full);
            const rp = rel ? `${rel}/${e.name.replace(/\.md$/, "")}` : e.name.replace(/\.md$/, "");
            target.set(rp.replaceAll("\\", "/"), s.mtimeMs);
          } catch {
            /* file vanished during scan */
          }
        }
      }
    } catch {
      /* dir inaccessible */
    }
  }

  private startWatching(): void {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const w = watch(getDocsRoot(), { recursive: true, signal: ctrl.signal });
        for await (const ev of w) {
          if (!ev.filename?.endsWith(".md")) {
            continue;
          }
          this.debounce(ev.filename);
        }
      } catch (error) {
        console.warn("[SSE Server] fs.watch loop unavailable, relying on polling fallback", error);
      }
    })();
  }

  private startPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.pollInterval = setInterval(() => {
      void this.pollSnapshot();
    }, 1500);
  }

  private async pollSnapshot(): Promise<void> {
    const current = new Map<string, number>();
    await this.scanDirectoryToMap(getDocsRoot(), "", current);

    for (const [filePath, mtimeMs] of current) {
      const prev = this.knownMtimes.get(filePath);
      if (prev === undefined) {
        this.knownMtimes.set(filePath, mtimeMs);
        this.emit("change", {
          path: filePath,
          mtimeMs,
          eventType: "create" as const,
        } satisfies FileChangeEvent);
      } else if (prev !== mtimeMs) {
        this.knownMtimes.set(filePath, mtimeMs);
        this.emit("change", {
          path: filePath,
          mtimeMs,
          eventType: "update" as const,
        } satisfies FileChangeEvent);
      }
    }

    for (const [filePath] of this.knownMtimes) {
      if (!current.has(filePath)) {
        this.knownMtimes.delete(filePath);
        this.emit("change", {
          path: filePath,
          mtimeMs: Date.now(),
          eventType: "delete" as const,
        } satisfies FileChangeEvent);
      }
    }
  }

  private debounce(filename: string): void {
    const norm = filename.replaceAll("\\", "/").replace(/\.md$/, "");
    const prev = this.debounceTimers.get(norm);
    if (prev) {
      clearTimeout(prev);
    }
    this.debounceTimers.set(
      norm,
      setTimeout(() => {
        this.debounceTimers.delete(norm);
        void this.resolve(norm);
      }, this.debounceMs),
    );
  }

  private async resolve(norm: string): Promise<void> {
    const full = path.join(getDocsRoot(), `${norm}.md`);
    const prev = this.knownMtimes.get(norm);
    try {
      const s = await stat(full);
      if (prev === undefined) {
        this.knownMtimes.set(norm, s.mtimeMs);
        this.emit("change", {
          path: norm,
          mtimeMs: s.mtimeMs,
          eventType: "create" as const,
        } satisfies FileChangeEvent);
      } else if (s.mtimeMs !== prev) {
        this.knownMtimes.set(norm, s.mtimeMs);
        this.emit("change", {
          path: norm,
          mtimeMs: s.mtimeMs,
          eventType: "update" as const,
        } satisfies FileChangeEvent);
      }
    } catch {
      if (prev !== undefined) {
        this.knownMtimes.delete(norm);
        this.emit("change", {
          path: norm,
          mtimeMs: Date.now(),
          eventType: "delete" as const,
        } satisfies FileChangeEvent);
      }
    }
  }
}

const watcher = new StorageWatcher();

// ---------- SSE HTTP Server ----------

interface SSEClient {
  id: number;
  res: import("http").ServerResponse;
  interval: ReturnType<typeof setInterval>;
}

let nextClientId = 1;
const clients = new Set<SSEClient>();
const encoder = new TextEncoder();

function broadcast(event: string, data: string): void {
  const msg = encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
  for (const client of clients) {
    if (!client.res.writableEnded) {
      client.res.write(msg);
    }
  }
}

watcher.on("change", (ev: FileChangeEvent) => {
  broadcast("file-change", JSON.stringify(ev));
});

const server = createServer(async (req, res) => {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url !== "/" && req.url !== "/sse") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const client: SSEClient = {
    id: nextClientId++,
    res,
    interval: setInterval(() => {
      if (!res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 15_000),
  };

  clients.add(client);
  res.write(
    `event: connected\ndata: ${JSON.stringify({ clientId: client.id, ts: Date.now() })}\n\n`,
  );

  req.on("close", () => {
    clearInterval(client.interval);
    clients.delete(client);
  });
});

const PORT = parseInt(process.env.SSE_PORT || "3001", 10);
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[SSE Server] Listening on 127.0.0.1:${PORT}`);
  console.log(`[SSE Server] Watching: ${getDocsRoot()}`);
});
