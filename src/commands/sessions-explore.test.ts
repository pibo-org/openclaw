import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({
  rootDir: "",
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        store: `${configState.rootDir}/{agentId}/sessions.json`,
      },
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
        defaults: {
          model: { primary: "pi:opus" },
          models: { "pi:opus": {} },
          contextTokens: 32000,
        },
      },
    }),
  };
});

import {
  sessionsFindCommand,
  sessionsGrepCommand,
  sessionsPeekCommand,
  sessionsShowCommand,
} from "./sessions-explore.js";
import { makeRuntime } from "./sessions.test-helpers.js";

type TranscriptMessage = Record<string, unknown>;

function writeAgentStore(params: {
  agentId: string;
  store: Record<string, Record<string, unknown>>;
  transcripts: Record<string, TranscriptMessage[]>;
}) {
  const agentDir = path.join(configState.rootDir, params.agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "sessions.json"),
    JSON.stringify(params.store, null, 2),
    "utf-8",
  );

  for (const [sessionId, messages] of Object.entries(params.transcripts)) {
    const lines = [
      JSON.stringify({
        type: "session",
        version: 1,
        id: sessionId,
      }),
      ...messages.map((message) => JSON.stringify({ message })),
    ];
    fs.writeFileSync(path.join(agentDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
  }
}

function readJsonLog<T>(logs: string[]): T {
  return JSON.parse(logs[0] ?? "{}") as T;
}

describe("sessions exploration commands", () => {
  beforeEach(() => {
    configState.rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-explore-"));
  });

  afterEach(() => {
    fs.rmSync(configState.rootDir, { recursive: true, force: true });
  });

  it("peek returns a bounded sanitized recent window and hides tool messages by default", async () => {
    writeAgentStore({
      agentId: "main",
      store: {
        main: {
          sessionId: "peek-main",
          updatedAt: Date.now(),
        },
      },
      transcripts: {
        "peek-main": [
          { role: "user", content: "start" },
          { role: "assistant", content: "working" },
          { role: "toolResult", content: [{ type: "text", text: "hidden tool payload" }] },
          { role: "user", content: "step 4" },
          { role: "assistant", content: "step 5" },
          { role: "user", content: "api key sk-live-123456789" },
          { role: "assistant", content: "done" },
        ],
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsPeekCommand({ key: "main", json: true }, runtime);
    const payload = readJsonLog<{
      sessionKey: string;
      messages: Array<{ role?: string; content?: string }>;
      truncated: boolean;
      contentRedacted: boolean;
      window: { totalMessages: number; availableOlder: number };
    }>(logs);

    expect(payload.sessionKey).toBe("agent:main:main");
    expect(payload.messages).toHaveLength(5);
    expect(payload.messages.map((message) => message.role)).not.toContain("toolResult");
    expect(payload.truncated).toBe(true);
    expect(payload.contentRedacted).toBe(true);
    expect(JSON.stringify(payload.messages)).toContain("***");
    expect(JSON.stringify(payload.messages)).not.toContain("sk-live-123456789");
    expect(payload.window.totalMessages).toBe(6);
    expect(payload.window.availableOlder).toBe(1);
  });

  it("grep returns bounded sanitized snippets instead of transcript dumps", async () => {
    writeAgentStore({
      agentId: "main",
      store: {
        main: {
          sessionId: "grep-main",
          updatedAt: Date.now(),
        },
      },
      transcripts: {
        "grep-main": [
          { role: "user", content: "alpha needle beta needle gamma" },
          { role: "assistant", content: "assistant needle answer" },
        ],
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsGrepCommand(
      {
        key: "main",
        query: "needle",
        limit: "1",
        beforeChars: "6",
        afterChars: "6",
        json: true,
      },
      runtime,
    );
    const payload = readJsonLog<{
      hits: Array<{ snippet: string }>;
      totalHits: number;
      truncated: boolean;
      bytes: number;
    }>(logs);

    expect(payload.totalHits).toBeGreaterThan(1);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]?.snippet).toContain("needle");
    expect(payload.hits[0]?.snippet.length ?? 0).toBeLessThan(
      "alpha needle beta needle gamma".length,
    );
    expect(payload.truncated).toBe(true);
    expect(payload.bytes).toBeGreaterThan(0);
  });

  it("find searches metadata across stores without matching transcript-only content", async () => {
    writeAgentStore({
      agentId: "main",
      store: {
        incident: {
          sessionId: "find-main",
          updatedAt: Date.now(),
          displayName: "Release Planning",
        },
      },
      transcripts: {
        "find-main": [{ role: "user", content: "needle appears only inside the transcript body" }],
      },
    });
    writeAgentStore({
      agentId: "work",
      store: {
        deploy: {
          sessionId: "find-work",
          updatedAt: Date.now() - 1000,
          subject: "Needle Rollout",
        },
      },
      transcripts: {
        "find-work": [{ role: "assistant", content: "no relevant transcript text needed" }],
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsFindCommand({ query: "needle", json: true }, runtime);
    const payload = readJsonLog<{
      metadataOnly: boolean;
      searchedStores: number;
      sessions: Array<{ key: string }>;
    }>(logs);

    expect(payload.metadataOnly).toBe(true);
    expect(payload.searchedStores).toBe(2);
    expect(payload.sessions.map((session) => session.key)).toContain("agent:work:deploy");
    expect(payload.sessions.map((session) => session.key)).not.toContain("agent:main:incident");
  });

  it("show returns bounded pages with explicit older/newer cursor tokens", async () => {
    writeAgentStore({
      agentId: "main",
      store: {
        main: {
          sessionId: "show-main",
          updatedAt: Date.now(),
        },
      },
      transcripts: {
        "show-main": [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
          { role: "assistant", content: "four" },
          { role: "user", content: "five" },
          { role: "assistant", content: "six" },
        ],
      },
    });

    const firstRun = makeRuntime();
    await sessionsShowCommand({ key: "main", limit: "2", json: true }, firstRun.runtime);
    const firstPayload = readJsonLog<{
      messages: Array<{ content?: string; __openclaw?: { seq?: number } }>;
      cursor: { older: string | null; newer: string | null };
      window: { startSeq: number | null; endSeq: number | null };
    }>(firstRun.logs);

    expect(firstPayload.window.startSeq).toBe(5);
    expect(firstPayload.window.endSeq).toBe(6);
    expect(firstPayload.cursor.older).toBe("before:5");
    expect(firstPayload.cursor.newer).toBeNull();

    const secondRun = makeRuntime();
    await sessionsShowCommand(
      {
        key: "main",
        cursor: firstPayload.cursor.older ?? undefined,
        limit: "2",
        json: true,
      },
      secondRun.runtime,
    );
    const secondPayload = readJsonLog<{
      cursor: { older: string | null; newer: string | null };
      window: { startSeq: number | null; endSeq: number | null };
    }>(secondRun.logs);

    expect(secondPayload.window.startSeq).toBe(3);
    expect(secondPayload.window.endSeq).toBe(4);
    expect(secondPayload.cursor.older).toBe("before:3");
    expect(secondPayload.cursor.newer).toBe("after:4");
  });
});
