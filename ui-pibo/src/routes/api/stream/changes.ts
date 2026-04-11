import { createFileRoute } from "@tanstack/react-router";
import { getAuthenticatedUsername } from "#/lib/auth.server";
import { storageWatcher } from "#/lib/storage-watcher.server";
import type { FileChangeEvent } from "#/lib/storage-watcher.server";

let watcherStartPromise: Promise<void> | null = null;

function ensureStorageWatcherStarted() {
  if (!watcherStartPromise) {
    watcherStartPromise = storageWatcher.start().catch((error) => {
      watcherStartPromise = null;
      throw error;
    });
  }

  return watcherStartPromise;
}

export const Route = createFileRoute("/api/stream/changes")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const username = getAuthenticatedUsername();
        if (!username) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          await ensureStorageWatcherStarted();
        } catch (error) {
          console.error("[file-sync] failed to start storage watcher", error);
          return new Response("Storage watcher unavailable", { status: 503 });
        }

        const encoder = new TextEncoder();
        const { writable, readable } = new TransformStream();
        const writer = writable.getWriter();

        const headers = new Headers({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        const sendEvent = (event: string, data: string) => {
          writer.write(encoder.encode(`event: ${event}\ndata: ${data}\n\n`)).catch(() => {
            /* client gone */
          });
        };

        // Keep-alive ping every 15s
        const pingInterval = setInterval(() => {
          writer.write(encoder.encode(": ping\n\n")).catch(() => {
            clearInterval(pingInterval);
          });
        }, 15_000);

        // Listen to storage changes
        const onChange = (event: FileChangeEvent) => {
          sendEvent("file-change", JSON.stringify(event));
        };

        storageWatcher.on("change", onChange);

        // Send initial connected event
        sendEvent("connected", JSON.stringify({ username, timestamp: Date.now() }));

        // Handle disconnect via request signal
        const signal = request.signal;
        signal.addEventListener("abort", () => {
          clearInterval(pingInterval);
          storageWatcher.off("change", onChange);
          writer.close().catch(() => {
            /* already closed */
          });
        });

        return new Response(readable, { headers });
      },
    },
  },
});
