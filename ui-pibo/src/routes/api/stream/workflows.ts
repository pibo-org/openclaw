import { createFileRoute } from "@tanstack/react-router";
import { getAuthenticatedUsername } from "#/lib/auth.server";
import { workflowWatcher } from "#/lib/workflow-watcher.server";
import type { WorkflowStreamEvent } from "#/lib/workflows.shared";

let watcherStartPromise: Promise<void> | null = null;

function ensureWorkflowWatcherStarted() {
  if (!watcherStartPromise) {
    watcherStartPromise = workflowWatcher.start().catch((error) => {
      watcherStartPromise = null;
      throw error;
    });
  }
  return watcherStartPromise;
}

export const Route = createFileRoute("/api/stream/workflows")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const username = getAuthenticatedUsername();
        if (!username) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          await ensureWorkflowWatcherStarted();
        } catch (error) {
          console.error("[workflows-stream] failed to start workflow watcher", error);
          return new Response("Workflow watcher unavailable", { status: 503 });
        }

        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream();
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

        const pingInterval = setInterval(() => {
          writer.write(encoder.encode(": ping\n\n")).catch(() => {
            clearInterval(pingInterval);
          });
        }, 15_000);

        const onChange = (event: WorkflowStreamEvent) => {
          sendEvent("workflow-change", JSON.stringify(event));
        };

        workflowWatcher.on("change", onChange);
        sendEvent("connected", JSON.stringify({ username, timestamp: Date.now() }));

        request.signal.addEventListener("abort", () => {
          clearInterval(pingInterval);
          workflowWatcher.off("change", onChange);
          writer.close().catch(() => {
            /* already closed */
          });
        });

        return new Response(readable, { headers });
      },
    },
  },
});
