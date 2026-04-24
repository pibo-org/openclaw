import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const codexConstructorArgs: unknown[] = [];
const startThread = vi.fn();
const resumeThread = vi.fn();
const spawn = vi.fn();
const execFileSync = vi.fn();
const existsSync = vi.fn();
const readFileSync = vi.fn();

class MockCodex {
  constructor(options?: unknown) {
    codexConstructorArgs.push(options);
  }

  startThread = startThread;
  resumeThread = resumeThread;
}

vi.mock("@openai/codex-sdk", () => ({
  Codex: MockCodex,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn,
    execFileSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync,
    readFileSync,
  };
});

function createThread(threadId = "thread-1") {
  return {
    id: null as string | null,
    async runStreamed() {
      return {
        events: (async function* () {
          yield {
            type: "thread.started",
            thread_id: threadId,
          };
          yield {
            type: "item.completed",
            item: {
              id: "assistant-1",
              type: "agent_message",
              text: "worker reply",
            },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          };
        })(),
      };
    },
  };
}

function createAppServerChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.kill = vi.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return true;
  });

  let buffer = "";
  child.stdin.write = ((chunk: string | Uint8Array) => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line) as { id?: string; method?: string };
      if (!message.id || !message.method) {
        continue;
      }
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      if (message.method === "thread/compact/start") {
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({
              method: "turn/started",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "compact-1",
                },
              },
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              method: "thread/compacted",
              params: {
                threadId: "thread-1",
                turnId: "compact-1",
              },
            })}\n`,
          );
        });
      }
    }
    return true;
  }) as typeof child.stdin.write;

  return child;
}

describe("codex-sdk-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexConstructorArgs.length = 0;
    existsSync.mockReturnValue(false);
    readFileSync.mockReturnValue("");
    startThread.mockImplementation(() => createThread());
    resumeThread.mockImplementation(() => createThread());
    spawn.mockImplementation(() => createAppServerChild());
    execFileSync.mockReturnValue("");
  });

  it("passes run-scoped worker developer instructions through the SDK config override", async () => {
    const { createCodexSdkWorkerRuntime } = await import("./codex-sdk-runtime.js");
    const runtime = createCodexSdkWorkerRuntime({
      workingDirectory: "/repo",
      contextWorkspaceDir: "/context",
      developerInstructions: "RUN CONTRACT\n\nORIGINAL_TASK:\nShip the fix",
    });

    const result = await runtime.runTurn({
      text: "Continue",
      hardTimeoutSeconds: 1,
      idleTimeoutSeconds: 1,
    });

    expect(result.threadId).toBe("thread-1");
    expect(codexConstructorArgs[0]).toEqual({
      config: {
        developer_instructions: "RUN CONTRACT\n\nORIGINAL_TASK:\nShip the fix",
      },
    });
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/repo",
        additionalDirectories: ["/context"],
      }),
    );
  });

  it("passes fast mode through the SDK config override", async () => {
    const { createCodexSdkWorkerRuntime } = await import("./codex-sdk-runtime.js");
    const runtime = createCodexSdkWorkerRuntime({
      workingDirectory: "/repo",
      fastMode: true,
    });

    await runtime.runTurn({
      text: "Continue",
      hardTimeoutSeconds: 1,
      idleTimeoutSeconds: 1,
    });

    expect(codexConstructorArgs[0]).toEqual({
      config: {
        service_tier: "fast",
      },
    });
  });

  it("maps disabled fast mode to Codex flex service tier", async () => {
    const { createCodexSdkWorkerRuntime } = await import("./codex-sdk-runtime.js");
    const runtime = createCodexSdkWorkerRuntime({
      workingDirectory: "/repo",
      fastMode: false,
    });

    await runtime.runTurn({
      text: "Continue",
      hardTimeoutSeconds: 1,
      idleTimeoutSeconds: 1,
    });

    expect(codexConstructorArgs[0]).toEqual({
      config: {
        service_tier: "flex",
      },
    });
  });

  it("defaults the Codex worker to fast mode when no wrapper override is configured", async () => {
    const { resolveCodexWorkerDefaultOptions } = await import("./codex-sdk-runtime.js");

    expect(resolveCodexWorkerDefaultOptions()).toMatchObject({
      fastMode: true,
    });
  });

  it("loads fast mode from the codex-cli-wrapper default config", async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        model: "gpt-5.5",
        effort: "high",
        fastMode: true,
      }),
    );

    const { resolveCodexWorkerDefaultOptions } = await import("./codex-sdk-runtime.js");

    expect(resolveCodexWorkerDefaultOptions()).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      fastMode: true,
    });
    expect(resolveCodexWorkerDefaultOptions({ fastMode: "off" })).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      fastMode: false,
    });
  });

  it("reuses the same worker-local developer instructions on the app-server compaction path", async () => {
    const { createCodexSdkWorkerRuntime } = await import("./codex-sdk-runtime.js");
    const runtime = createCodexSdkWorkerRuntime({
      workingDirectory: "/repo",
      developerInstructions: "RUN CONTRACT\n\nORIGINAL_TASK:\nShip the fix",
      fastMode: true,
    });

    await runtime.runTurn({
      text: "Continue",
      hardTimeoutSeconds: 1,
      idleTimeoutSeconds: 1,
    });
    const compaction = await runtime.compactThread();

    expect(compaction?.threadId).toBe("thread-1");
    expect(compaction?.compactionTurnId).toBe("compact-1");
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringContaining("codex.js"),
        "app-server",
        "--listen",
        "stdio://",
        "--config",
        expect.stringContaining(
          'developer_instructions="RUN CONTRACT\\n\\nORIGINAL_TASK:\\nShip the fix"',
        ),
        "--config",
        'service_tier="fast"',
      ]),
      expect.objectContaining({
        cwd: "/repo",
      }),
    );
  });
});
