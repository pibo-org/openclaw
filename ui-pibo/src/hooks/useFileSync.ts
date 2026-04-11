import { useCallback, useEffect, useRef, useState } from "react";

interface FileChangeEvent {
  path: string;
  mtimeMs: number;
  eventType: "create" | "update" | "delete";
}

const RECENT_SAVE_WINDOW_MS = 3_000;
const FILE_SYNC_STREAM_URL = "/api/stream/changes";
const LEGACY_FILE_SYNC_STREAM_URL = "/sse";

export function useFileSync() {
  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const treeChangeCallbacksRef = useRef(new Set());
  const fileChangeCallbacksRef = useRef(new Set());
  const recentSavesRef = useRef(new Map());

  const isRecentlySaved = useCallback((filePath: string): boolean => {
    const savedAt = recentSavesRef.current.get(filePath);
    if (savedAt === undefined) {
      return false;
    }
    return Date.now() - savedAt < RECENT_SAVE_WINDOW_MS;
  }, []);

  useEffect(() => {
    const connect = () => {
      const es = new EventSource(FILE_SYNC_STREAM_URL);
      eventSourceRef.current = es;

      const closeWithFallback = () => {
        if (eventSourceRef.current === es) {
          eventSourceRef.current = null;
        }
        es.close();
      };

      es.addEventListener("connected", () => {
        setIsConnected(true);
      });

      es.addEventListener("file-change", (event) => {
        try {
          const change = JSON.parse(event.data) as FileChangeEvent;

          // Ignore events for files we recently saved ourselves
          if (isRecentlySaved(change.path)) {
            return;
          }

          // Notify tree change subscribers (always)
          for (const cb of treeChangeCallbacksRef.current) {
            cb();
          }

          // Notify file change subscribers
          for (const cb of fileChangeCallbacksRef.current) {
            cb(change.path, change.mtimeMs, change.eventType);
          }
        } catch {
          // malformed JSON — ignore
        }
      });

      es.addEventListener("error", () => {
        setIsConnected(false);
        closeWithFallback();
      });

      es.addEventListener("open", () => {
        const currentUrl = eventSourceRef.current?.url ?? "";
        setIsConnected(!currentUrl.endsWith(LEGACY_FILE_SYNC_STREAM_URL));
      });

      return es;
    };

    const es = connect();

    return () => {
      es.close();
      if (eventSourceRef.current === es) {
        eventSourceRef.current = null;
      }
      setIsConnected(false);
    };
  }, [isRecentlySaved]);

  const subscribeTreeChange = useCallback((cb: () => void) => {
    treeChangeCallbacksRef.current.add(cb);
    return () => {
      treeChangeCallbacksRef.current.delete(cb);
    };
  }, []);

  const subscribeFileChange = useCallback(
    (cb: (path: string, mtimeMs: number, eventType: FileChangeEvent["eventType"]) => void) => {
      fileChangeCallbacksRef.current.add(cb);
      return () => {
        fileChangeCallbacksRef.current.delete(cb);
      };
    },
    [],
  );

  const notifyJustSaved = useCallback((filePath: string) => {
    recentSavesRef.current.set(filePath, Date.now());

    // Cleanup old saves after window
    setTimeout(() => {
      recentSavesRef.current.delete(filePath);
    }, RECENT_SAVE_WINDOW_MS + 500);
  }, []);

  return {
    isConnected,
    subscribeTreeChange,
    subscribeFileChange,
    notifyJustSaved,
  };
}
