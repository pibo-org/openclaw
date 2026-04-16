import type { AcpRuntimeEvent, AcpSessionStore } from "acpx/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import {
  AcpxRuntime,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
} from "./runtime.js";

function makeRuntime(
  baseStore: AcpSessionStore,
  testOptions?: ConstructorParameters<typeof AcpxRuntime>[1],
): {
  runtime: AcpxRuntime;
  wrappedStore: AcpSessionStore & { markFresh: (sessionKey: string) => void };
  delegate: { close: AcpRuntime["close"] };
} {
  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp",
      sessionStore: baseStore,
      agentRegistry: {
        resolve: () => "codex",
        list: () => ["codex"],
      },
      permissionMode: "approve-reads",
    },
    testOptions,
  );

  return {
    runtime,
    wrappedStore: (
      runtime as unknown as {
        sessionStore: AcpSessionStore & { markFresh: (sessionKey: string) => void };
      }
    ).sessionStore,
    delegate: (runtime as unknown as { delegate: { close: AcpRuntime["close"] } }).delegate,
  };
}

async function collectEvents(stream: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const events: AcpRuntimeEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore } = makeRuntime(baseStore);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: "agent:codex:acp:binding:test",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(2);
  });

  it("marks the session fresh after discardPersistentState close", async () => {
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    const close = vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });

    expect(close).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).not.toHaveBeenCalled();
  });

  it("relaxes the first persistent turn to allow-new semantics when no agent history exists", async () => {
    const sessionKey = "agent:codex:acp:workflow:test:worker:codex";
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: sessionKey, messages: [] }) as never),
      save: vi.fn(async () => {}),
    };

    let observedSessionMode: string | undefined;
    const manager = {
      runTurn: vi.fn(async function* (input: {
        handle: { runtimeSessionName: string };
        sessionMode: string;
      }) {
        observedSessionMode = input.sessionMode;
        input.handle.runtimeSessionName = encodeAcpxRuntimeHandleState({
          name: sessionKey,
          agent: "codex",
          cwd: "/tmp",
          mode: "oneshot",
          acpxRecordId: sessionKey,
          backendSessionId: "fresh-backend-session",
          agentSessionId: "fresh-agent-session",
        });
        yield { type: "done", stopReason: "completed" } satisfies AcpRuntimeEvent;
      }),
    };

    const { runtime } = makeRuntime(baseStore, {
      managerFactory: () => manager as never,
    });
    const handle = {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: sessionKey,
        agent: "codex",
        cwd: "/tmp",
        mode: "persistent",
        acpxRecordId: sessionKey,
        backendSessionId: "stale-backend-session",
      }),
    };

    const events = await collectEvents(
      runtime.runTurn({
        handle,
        text: "do work",
        mode: "prompt",
        requestId: "req-1",
      }),
    );

    expect(events).toEqual([{ type: "done", stopReason: "completed" }]);
    expect(observedSessionMode).toBe("oneshot");
    expect(baseStore.load).toHaveBeenCalledWith(sessionKey);
    expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)).toEqual({
      name: sessionKey,
      agent: "codex",
      cwd: "/tmp",
      mode: "persistent",
      acpxRecordId: sessionKey,
      backendSessionId: "stale-backend-session",
    });
  });

  it("relaxes first persistent setMode controls to allow-new semantics when no agent history exists", async () => {
    const sessionKey = "agent:codex:acp:workflow:test:worker:codex";
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: sessionKey, messages: [] }) as never),
      save: vi.fn(async () => {}),
    };

    let observedSessionMode: string | undefined;
    const manager = {
      setMode: vi.fn(async (_handle: unknown, _mode: string, sessionMode?: string) => {
        observedSessionMode = sessionMode;
      }),
    };

    const { runtime } = makeRuntime(baseStore, {
      managerFactory: () => manager as never,
    });
    const handle = {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: sessionKey,
        agent: "codex",
        cwd: "/tmp",
        mode: "persistent",
        acpxRecordId: sessionKey,
        backendSessionId: "fresh-backend-session",
      }),
    };

    await runtime.setMode({
      handle,
      mode: "danger-full-access",
    });

    expect(observedSessionMode).toBe("oneshot");
    expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)?.mode).toBe("persistent");
  });

  it("relaxes first persistent setConfigOption controls to allow-new semantics when no agent history exists", async () => {
    const sessionKey = "agent:codex:acp:workflow:test:worker:codex";
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: sessionKey, messages: [] }) as never),
      save: vi.fn(async () => {}),
    };

    let observedSessionMode: string | undefined;
    const manager = {
      setConfigOption: vi.fn(
        async (_handle: unknown, _key: string, _value: string, sessionMode?: string) => {
          observedSessionMode = sessionMode;
        },
      ),
    };

    const { runtime } = makeRuntime(baseStore, {
      managerFactory: () => manager as never,
    });
    const handle = {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: sessionKey,
        agent: "codex",
        cwd: "/tmp",
        mode: "persistent",
        acpxRecordId: sessionKey,
        backendSessionId: "fresh-backend-session",
      }),
    };

    await runtime.setConfigOption({
      handle,
      key: "model",
      value: "gpt-5.4",
    });

    expect(observedSessionMode).toBe("oneshot");
    expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)?.mode).toBe("persistent");
  });

  it("skips unsupported timeout config controls locally", async () => {
    const sessionKey = "agent:codex:acp:workflow:test:worker:codex";
    const baseStore: AcpSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: sessionKey, messages: [] }) as never),
      save: vi.fn(async () => {}),
    };

    const manager = {
      setConfigOption: vi.fn(),
    };

    const { runtime } = makeRuntime(baseStore, {
      managerFactory: () => manager as never,
    });
    const handle = {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: sessionKey,
        agent: "codex",
        cwd: "/tmp",
        mode: "persistent",
        acpxRecordId: sessionKey,
        backendSessionId: "fresh-backend-session",
      }),
    };

    await runtime.setConfigOption({
      handle,
      key: "timeout",
      value: "300",
    });

    expect(manager.setConfigOption).not.toHaveBeenCalled();
    expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)?.mode).toBe("persistent");
  });

  it("keeps same-session-only semantics once agent history exists", async () => {
    const sessionKey = "agent:codex:acp:workflow:test:worker:codex";
    const baseStore: AcpSessionStore = {
      load: vi.fn(
        async () =>
          ({
            acpxRecordId: sessionKey,
            messages: [{ Agent: { message: "already replied" } }],
          }) as never,
      ),
      save: vi.fn(async () => {}),
    };

    let observedSessionMode: string | undefined;
    const manager = {
      runTurn: vi.fn(async function* (input: { sessionMode: string }) {
        observedSessionMode = input.sessionMode;
        yield { type: "done", stopReason: "completed" } satisfies AcpRuntimeEvent;
      }),
    };

    const { runtime } = makeRuntime(baseStore, {
      managerFactory: () => manager as never,
    });
    const handle = {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: sessionKey,
        agent: "codex",
        cwd: "/tmp",
        mode: "persistent",
        acpxRecordId: sessionKey,
        backendSessionId: "existing-backend-session",
      }),
    };

    await collectEvents(
      runtime.runTurn({
        handle,
        text: "continue",
        mode: "prompt",
        requestId: "req-2",
      }),
    );

    expect(observedSessionMode).toBe("persistent");
    expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)?.mode).toBe("persistent");
  });
});
