import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRuntime } from "./sessions.test-helpers.js";

const mocks = vi.hoisted(() => ({
  createDefaultDeps: vi.fn(() => ({})),
  sessionsCompactHandler: vi.fn(),
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: mocks.createDefaultDeps,
}));

vi.mock("../gateway/server-methods.js", () => ({
  coreGatewayHandlers: {
    "sessions.compact": mocks.sessionsCompactHandler,
  },
}));

import { sessionsCompactCommand } from "./sessions-compact.js";

describe("sessionsCompactCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs semantic compaction without maxLines and prints a success summary", async () => {
    mocks.sessionsCompactHandler.mockImplementation(
      async (params: {
        req: { method: string; params: Record<string, unknown> };
        params: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
      }) => {
        expect(params.req.method).toBe("sessions.compact");
        expect(params.params).toEqual({ key: "main" });
        expect(params.req.params).toEqual({ key: "main" });
        params.respond(
          true,
          {
            ok: true,
            key: "agent:main:main",
            compacted: true,
            result: { tokensAfter: 1234 },
          },
          undefined,
        );
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCompactCommand({ key: "main" }, runtime);

    expect(logs).toEqual(["Compacted session main."]);
  });

  it("prints a no-session-id summary when compaction is skipped", async () => {
    mocks.sessionsCompactHandler.mockImplementation(
      async (params: {
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
      }) => {
        params.respond(
          true,
          {
            ok: true,
            key: "agent:main:main",
            compacted: false,
            reason: "no sessionId",
          },
          undefined,
        );
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCompactCommand({ key: "main" }, runtime);

    expect(logs).toEqual(["Session main was not compacted: no sessionId."]);
  });

  it("prints a no-transcript summary when compaction is skipped", async () => {
    mocks.sessionsCompactHandler.mockImplementation(
      async (params: {
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
      }) => {
        params.respond(
          true,
          {
            ok: true,
            key: "agent:main:main",
            compacted: false,
            reason: "no transcript",
          },
          undefined,
        );
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCompactCommand({ key: "main" }, runtime);

    expect(logs).toEqual(["Session main was not compacted: no transcript."]);
  });

  it("prints a failure summary when compaction returns ok=false", async () => {
    mocks.sessionsCompactHandler.mockImplementation(
      async (params: {
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
      }) => {
        params.respond(
          true,
          {
            ok: false,
            key: "agent:main:main",
            compacted: false,
            reason: "model unavailable",
          },
          undefined,
        );
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCompactCommand({ key: "main" }, runtime);

    expect(logs).toEqual(["Session main compaction failed: model unavailable."]);
  });

  it("emits raw gateway JSON in json mode", async () => {
    mocks.sessionsCompactHandler.mockImplementation(
      async (params: {
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
      }) => {
        params.respond(
          true,
          {
            ok: true,
            key: "agent:main:main",
            compacted: false,
            reason: "no transcript",
            result: { tokensAfter: 12 },
          },
          undefined,
        );
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCompactCommand({ key: "main", json: true }, runtime);

    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      ok: true,
      key: "agent:main:main",
      compacted: false,
      reason: "no transcript",
      result: { tokensAfter: 12 },
    });
  });

  it("throws a contextual error when the gateway transport fails", async () => {
    mocks.sessionsCompactHandler.mockImplementation(
      async (params: {
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => void;
      }) => {
        params.respond(false, undefined, { message: "gateway unavailable" });
      },
    );

    const { runtime } = makeRuntime();
    await expect(sessionsCompactCommand({ key: "main" }, runtime)).rejects.toThrow(
      "Failed to compact session main: gateway unavailable",
    );
  });
});
