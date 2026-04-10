import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../config/home-env.test-harness.js";
import { registerPiboCli } from "../../pibo-cli.js";

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPiboCli(program);
  return program;
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managed-session CLI", () => {
  it("lists pibo sessions in compact text form by default", async () => {
    await withTempHome("openclaw-pibo-managed-session-cli-", async (home) => {
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

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await createProgram().parseAsync(["pibo", "managed-session", "list"], { from: "user" });

      const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ""));
      const text = lines.join("\n");
      expect(lines[0]).toContain("Type");
      expect(text).toContain("Showing 10 of 12 pibo sessions");
      expect(text).not.toContain("Native Main");
    });
  });

  it("supports the managed-sessions alias and json output", async () => {
    await withTempHome("openclaw-pibo-managed-session-cli-", async (home) => {
      const now = Date.now();
      await writeSessions(home, "main", {
        "agent:main:main": createEntry(now - 60_000, "Native Main", "sess-native-main"),
        "agent:main:pibo:workflow:e2e:worker:main": createEntry(
          now - 15_000,
          "Pibo Worker",
          "sess-pibo-worker",
        ),
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await createProgram().parseAsync(
        ["pibo", "managed-sessions", "list", "--json", "--session-type", "native", "--all"],
        { from: "user" },
      );

      const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
        sessionType?: string;
        totalCount?: number;
        sessions?: Array<{ key?: string }>;
      };
      expect(payload.sessionType).toBe("native");
      expect(payload.totalCount).toBe(1);
      expect(payload.sessions?.map((session) => session.key)).toEqual(["agent:main:main"]);
    });
  });

  it("resolves within the selected session type", async () => {
    await withTempHome("openclaw-pibo-managed-session-cli-", async (home) => {
      const now = Date.now();
      await writeSessions(home, "main", {
        "agent:main:main": createEntry(now - 60_000, "Native Main", "sess-native-main"),
        "agent:main:pibo:workflow:e2e:worker:main": createEntry(
          now - 15_000,
          "Pibo Worker",
          "sess-pibo-worker",
        ),
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(
        createProgram().parseAsync(
          ["pibo", "managed-session", "resolve", "--label", "Native Main"],
          { from: "user" },
        ),
      ).rejects.toThrow("No session found with label: Native Main");

      logSpy.mockClear();
      await createProgram().parseAsync(
        [
          "pibo",
          "managed-session",
          "resolve",
          "--label",
          "Native Main",
          "--session-type",
          "native",
        ],
        { from: "user" },
      );
      expect(logSpy).toHaveBeenCalledWith("agent:main:main");
    });
  });
});
