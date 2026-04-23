import { useEffect, useRef, useState } from "react";
import type { WorkflowStreamEvent } from "#/lib/workflows.shared";

type WorkflowLiveUpdateOptions = {
  runId?: string | null;
  onWorkflowChange: (event: WorkflowStreamEvent) => void;
};

export function useWorkflowLiveUpdates(options: WorkflowLiveUpdateOptions) {
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const latestOptionsRef = useRef(options);
  latestOptionsRef.current = options;

  useEffect(() => {
    const source = new EventSource("/api/stream/workflows");

    const queueRefresh = (event: WorkflowStreamEvent) => {
      if (latestOptionsRef.current.runId && event.runId !== latestOptionsRef.current.runId) {
        return;
      }
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        latestOptionsRef.current.onWorkflowChange(event);
      }, 250);
    };

    source.addEventListener("open", () => {
      setConnected(true);
    });
    source.addEventListener("error", () => {
      setConnected(false);
    });
    source.addEventListener("connected", () => {
      setConnected(true);
    });
    source.addEventListener("workflow-change", (message) => {
      setConnected(true);
      setLastEventAt(Date.now());
      try {
        queueRefresh(JSON.parse(message.data) as WorkflowStreamEvent);
      } catch {
        // ignore malformed payload
      }
    });

    return () => {
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      source.close();
    };
  }, []);

  return {
    connected,
    lastEventAt,
  };
}
