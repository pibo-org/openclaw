import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import {
  classifyManagedSessionType,
  createRuntimeManagedSessions,
  matchesManagedSessionType,
} from "./runtime-managed-sessions.js";

function createEntry(updatedAt: number, label: string, sessionId: string) {
  return {
    updatedAt,
    label,
    sessionId,
    totalTokens: 100,
    contextTokens: 200_000,
    model: "gpt-5.4",
    modelProvider: "openai-codex",
  };
}

async function writeSessions(
  home: string,
  agentId: string,
  sessions: Record<string, ReturnType<typeof createEntry>>,
) {
  const dir = path.join(home, ".openclaw", "agents", agentId, "sessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sessions.json"), JSON.stringify(sessions, null, 2), "utf8");
}

function createManagedSessionsRuntime() {
  return createRuntimeManagedSessions({
    run: async () => {
      throw new Error("unused");
    },
    waitForRun: async () => {
      throw new Error("unused");
    },
    getSessionMessages: async () => {
      throw new Error("unused");
    },
    getSession: async () => {
      throw new Error("unused");
    },
    deleteSession: async () => {
      throw new Error("unused");
    },
  });
}

describe("runtime managed sessions", () => {
  it("classifies pibo and native session keys", () => {
    expect(classifyManagedSessionType("agent:main:pibo:workflow:e2e:worker:main")).toBe("pibo");
    expect(classifyManagedSessionType("agent:main:main")).toBe("native");
    expect(matchesManagedSessionType("agent:main:pibo:workflow:e2e:worker:main", "pibo")).toBe(
      true,
    );
    expect(matchesManagedSessionType("agent:main:main", "pibo")).toBe(false);
    expect(matchesManagedSessionType("agent:main:main", "native")).toBe(true);
    expect(matchesManagedSessionType("agent:main:main", "both")).toBe(true);
  });

  it("lists pibo sessions by default with a bounded result", async () => {
    await withTempHome(async (home) => {
      const now = Date.now();
      const sessions: Record<string, ReturnType<typeof createEntry>> = {
        "agent:main:main": createEntry(now - 60_000, "Native Main", "sess-native-main"),
      };
      for (let index = 0; index < 12; index += 1) {
        sessions[`agent:main:pibo:workflow:flow-${index}:worker:main`] = createEntry(
          now - index * 1_000,
          `Pibo ${index}`,
          `sess-pibo-${index}`,
        );
      }
      await writeSessions(home, "main", sessions);

      const runtime = createManagedSessionsRuntime();
      const list = await runtime.list();

      expect(list.sessionType).toBe("pibo");
      expect(list.totalCount).toBe(12);
      expect(list.shownCount).toBe(10);
      expect(list.count).toBe(10);
      expect(list.truncated).toBe(true);
      expect(list.sessions).toHaveLength(10);
      expect(list.sessions.every((session) => session.key.includes(":pibo:"))).toBe(true);
    });
  });

  it("supports native and both session-type filters", async () => {
    await withTempHome(async (home) => {
      const now = Date.now();
      await writeSessions(home, "main", {
        "agent:main:main": createEntry(now - 60_000, "Native Main", "sess-native-main"),
        "agent:main:telegram:group:demo": createEntry(
          now - 45_000,
          "Telegram Group",
          "sess-native-telegram",
        ),
        "agent:main:pibo:workflow:e2e:worker:main": createEntry(
          now - 15_000,
          "Pibo Worker",
          "sess-pibo-worker",
        ),
      });

      const runtime = createManagedSessionsRuntime();
      const nativeList = await runtime.list({ sessionType: "native", all: true });
      const bothList = await runtime.list({ sessionType: "both", all: true });

      expect(nativeList.totalCount).toBe(2);
      expect(nativeList.sessions.every((session) => !session.key.includes(":pibo:"))).toBe(true);
      expect(bothList.totalCount).toBe(3);
      expect(bothList.sessions.some((session) => session.key.includes(":pibo:"))).toBe(true);
      expect(bothList.sessions.some((session) => session.key === "agent:main:main")).toBe(true);
    });
  });

  it("resolves within the selected session type", async () => {
    await withTempHome(async (home) => {
      const now = Date.now();
      await writeSessions(home, "main", {
        "agent:main:main": createEntry(now - 60_000, "Native Main", "sess-native-main"),
        "agent:main:pibo:workflow:e2e:worker:main": createEntry(
          now - 15_000,
          "Pibo Worker",
          "sess-pibo-worker",
        ),
      });

      const runtime = createManagedSessionsRuntime();

      await expect(
        runtime.resolveSelector({
          label: "Native Main",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: "No session found with label: Native Main" },
      });

      await expect(
        runtime.resolveSelector({
          label: "Native Main",
          sessionType: "native",
        }),
      ).resolves.toEqual({
        ok: true,
        key: "agent:main:main",
      });

      await expect(
        runtime.resolveSelector({
          label: "Pibo Worker",
        }),
      ).resolves.toEqual({
        ok: true,
        key: "agent:main:pibo:workflow:e2e:worker:main",
      });
    });
  });
});
