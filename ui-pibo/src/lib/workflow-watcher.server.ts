import { EventEmitter } from "node:events";
import { mkdir, stat, watch } from "node:fs/promises";
import path from "node:path";
import { getWorkflowsStateRoot } from "#/lib/workflows.server";
import type { WorkflowStreamEvent } from "#/lib/workflows.shared";

type WorkflowWatchTarget = {
  relativePath: string;
  runId: string;
  scope: WorkflowStreamEvent["scope"];
};

function parseWorkflowWatchTarget(filename: string): WorkflowWatchTarget | null {
  const normalized = filename.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments[0] === "runs" && segments.length === 2 && segments[1]?.endsWith(".json")) {
    return {
      relativePath: normalized,
      runId: segments[1].replace(/\.json$/, ""),
      scope: "run",
    };
  }
  if (segments[0] === "artifacts" && segments.length >= 3) {
    return {
      relativePath: normalized,
      runId: segments[1] ?? "",
      scope:
        segments[2] === "trace.jsonl" || segments[2] === "trace.summary.json"
          ? "trace"
          : "artifact",
    };
  }
  return null;
}

class WorkflowWatcher extends EventEmitter {
  private watcherAbort: AbortController | null = null;
  private knownMtimes = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs = 250;
  private running = false;

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    const stateRoot = getWorkflowsStateRoot();
    await mkdir(stateRoot, { recursive: true });
    await this.scanDirectory(stateRoot, "");

    this.watcherAbort = new AbortController();
    const abortSignal = this.watcherAbort.signal;

    void (async () => {
      try {
        const watcher = watch(stateRoot, {
          recursive: true,
          signal: abortSignal,
        });
        for await (const event of watcher) {
          if (!event.filename) {
            continue;
          }
          const target = parseWorkflowWatchTarget(event.filename);
          if (!target) {
            continue;
          }
          void this.processFsEvent(target);
        }
      } catch {
        // watcher aborted
      }
    })();
  }

  stop() {
    this.running = false;
    this.watcherAbort?.abort();
    this.watcherAbort = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private async scanDirectory(dirPath: string, relativeDir: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const nextRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await this.scanDirectory(fullPath, nextRelative);
          continue;
        }
        const target = parseWorkflowWatchTarget(nextRelative);
        if (!target) {
          continue;
        }
        try {
          const current = await stat(fullPath);
          this.knownMtimes.set(target.relativePath, current.mtimeMs);
        } catch {
          // file disappeared during bootstrap
        }
      }
    } catch {
      // ignore scan errors
    }
  }

  private async processFsEvent(target: WorkflowWatchTarget) {
    const existing = this.debounceTimers.get(target.relativePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(target.relativePath);
      await this.resolveEvent(target);
    }, this.debounceMs);

    this.debounceTimers.set(target.relativePath, timer);
  }

  private async resolveEvent(target: WorkflowWatchTarget) {
    const stateRoot = getWorkflowsStateRoot();
    const fullPath = path.join(stateRoot, target.relativePath);
    const previousMtime = this.knownMtimes.get(target.relativePath);

    try {
      const current = await stat(fullPath);
      if (previousMtime === current.mtimeMs) {
        return;
      }
      this.knownMtimes.set(target.relativePath, current.mtimeMs);
      this.emit("change", {
        runId: target.runId,
        relativePath: target.relativePath,
        scope: target.scope,
        eventType: previousMtime === undefined ? "create" : "update",
        mtimeMs: current.mtimeMs,
      } satisfies WorkflowStreamEvent);
    } catch {
      if (previousMtime === undefined) {
        return;
      }
      this.knownMtimes.delete(target.relativePath);
      this.emit("change", {
        runId: target.runId,
        relativePath: target.relativePath,
        scope: target.scope,
        eventType: "delete",
        mtimeMs: Date.now(),
      } satisfies WorkflowStreamEvent);
    }
  }
}

export const workflowWatcher = new WorkflowWatcher();
