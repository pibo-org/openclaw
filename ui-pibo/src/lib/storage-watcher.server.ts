import { EventEmitter } from "node:events";
import { watch, stat } from "node:fs/promises";
import path from "node:path";

export interface FileChangeEvent {
  path: string;
  mtimeMs: number;
  eventType: "create" | "update" | "delete";
}

function getDocsRoot(): string {
  const configuredRoot = process.env.PIBO_STORAGE_DIR?.trim();
  if (!configuredRoot) {
    throw new Error("Missing PIBO_STORAGE_DIR — storage watcher cannot start.");
  }
  return path.resolve(process.cwd(), configuredRoot, "docs");
}

class StorageWatcher extends EventEmitter {
  private watcherAbort: AbortController | null = null;
  private knownMtimes = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs = 300;
  private running = false;

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    const docsRoot = getDocsRoot();

    // Bootstrap known mtimes
    await this.scanDirectory(docsRoot, "");

    this.watcherAbort = new AbortController();
    const abortSignal = this.watcherAbort.signal;

    void (async () => {
      try {
        const watcher = watch(docsRoot, {
          recursive: true,
          signal: abortSignal,
        });
        for await (const event of watcher) {
          // Only care about .md files
          if (!event.filename?.endsWith(".md")) {
            continue;
          }
          void this.processFsEvent(event.filename);
        }
      } catch {
        // AbortController rejection — expected on stop()
      }
    })();

    // Fire-and-forget; errors swallowed on abort
  }

  stop(): void {
    this.running = false;
    this.watcherAbort?.abort();
    this.watcherAbort = null;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private async scanDirectory(dir: string, relativeDir: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const nextRel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
          await this.scanDirectory(fullPath, nextRel);
        } else if (entry.name.endsWith(".md")) {
          try {
            const s = await stat(fullPath);
            const relPath = relativeDir
              ? `${relativeDir}/${entry.name.replace(/\.md$/, "")}`
              : entry.name.replace(/\.md$/, "");
            const normalized = relPath.replaceAll("\\", "/");
            this.knownMtimes.set(normalized, s.mtimeMs);
          } catch {
            // file disappeared during scan — skip
          }
        }
      }
    } catch {
      // directory inaccessible — skip
    }
  }

  private async processFsEvent(filename: string): Promise<void> {
    // Normalize path
    const normalized = filename.replaceAll("\\", "/").replace(/\.md$/, "");

    // Debounce: clear existing timer for this path, set new one
    const existing = this.debounceTimers.get(normalized);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(normalized);
      await this.resolveEvent(normalized);
    }, this.debounceMs);

    this.debounceTimers.set(normalized, timer);
  }

  private async resolveEvent(normalizedPath: string): Promise<void> {
    const docsRoot = getDocsRoot();
    const filePath = path.join(docsRoot, `${normalizedPath}.md`);
    const prevMtime = this.knownMtimes.get(normalizedPath);

    try {
      const s = await stat(filePath);
      const mtimeMs = s.mtimeMs;

      if (prevMtime === undefined) {
        // New file
        this.knownMtimes.set(normalizedPath, mtimeMs);
        this.emit("change", {
          path: normalizedPath,
          mtimeMs,
          eventType: "create" as const,
        } satisfies FileChangeEvent);
      } else if (mtimeMs !== prevMtime) {
        // Existing file changed
        this.knownMtimes.set(normalizedPath, mtimeMs);
        this.emit("change", {
          path: normalizedPath,
          mtimeMs,
          eventType: "update" as const,
        } satisfies FileChangeEvent);
      }
      // else: false positive, mtime unchanged → ignore
    } catch {
      // File no longer exists
      if (prevMtime !== undefined) {
        this.knownMtimes.delete(normalizedPath);
        this.emit("change", {
          path: normalizedPath,
          mtimeMs: Date.now(),
          eventType: "delete" as const,
        } satisfies FileChangeEvent);
      }
    }
  }
}

// Singleton — one instance per server process
export const storageWatcher = new StorageWatcher();
export default storageWatcher;
