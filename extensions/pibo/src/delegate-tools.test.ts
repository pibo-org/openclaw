import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnExecute = vi.fn();
const sendExecute = vi.fn();

vi.mock("../../../src/agents/tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: vi.fn(() => ({
    execute: spawnExecute,
  })),
}));

vi.mock("../../../src/agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: vi.fn(() => ({
    execute: sendExecute,
  })),
}));

function createApi(stateDir: string) {
  return {
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      subagent: {
        getSessionMessages: vi.fn().mockResolvedValue({
          messages: [{ role: "assistant", content: "LATEST CHILD REPLY" }],
        }),
      },
    },
  } as const;
}

function createCtx() {
  return {
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-1003736645971:topic:3336",
    deliveryContext: {
      channel: "telegram",
      accountId: "default",
      to: "-1003736645971",
      threadId: "3336",
    },
    agentAccountId: "default",
    sandboxed: false,
    workspaceDir: "/home/pibo/.openclaw/workspace",
    config: {},
  } as const;
}

describe("pibo delegate tools", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pibo-delegate-"));
    spawnExecute.mockReset();
    sendExecute.mockReset();
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("starts a delegate via the internal spawn tool and persists the delegate record", async () => {
    spawnExecute.mockResolvedValue({
      details: {
        status: "accepted",
        childSessionKey: "agent:langgraph:subagent:child-1",
        runId: "spawn-run-1",
      },
    });

    const { createPiboDelegateStartTool } = await import("./delegate-tools.js");
    const tool = createPiboDelegateStartTool(createApi(stateDir) as never)(createCtx() as never);

    const result = (await tool.execute?.("call-1", {
      agentId: "langgraph",
      task: "Do the delegated work",
      label: "Test Delegate",
      runTimeoutSeconds: 45,
    })) as { details: Record<string, unknown> };

    expect(spawnExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agentId: "langgraph",
        task: "Do the delegated work",
        label: "Test Delegate",
        thread: true,
        mode: "run",
        cleanup: "keep",
        runTimeoutSeconds: 45,
      }),
    );

    expect(result.details.ok).toBe(true);
    expect(result.details.childSessionKey).toBe("agent:langgraph:subagent:child-1");
    expect(typeof result.details.delegateId).toBe("string");

    const delegateId = String(result.details.delegateId);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(stateDir, "pibo", "delegates", `${delegateId}.json`), "utf8"),
    ) as { targetAgentId: string; childSessionKey: string; ownerSessionKey: string };

    expect(persisted).toMatchObject({
      targetAgentId: "langgraph",
      childSessionKey: "agent:langgraph:subagent:child-1",
      ownerSessionKey: "agent:main:telegram:group:-1003736645971:topic:3336",
    });
  });

  it("continues a persisted delegate via the internal send tool", async () => {
    const delegateId = "delegate-1";
    fs.mkdirSync(path.join(stateDir, "pibo", "delegates"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "pibo", "delegates", `${delegateId}.json`),
      JSON.stringify({
        delegateId,
        ownerSessionKey: "agent:main:telegram:group:-1003736645971:topic:3336",
        targetAgentId: "langgraph",
        childSessionKey: "agent:langgraph:subagent:child-1",
        originalTask: "Do the delegated work",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        start: { status: "accepted", runId: "spawn-run-1" },
      }),
      "utf8",
    );

    sendExecute.mockResolvedValue({
      details: {
        status: "ok",
        runId: "continue-run-1",
        reply: "CHILD CONTINUED",
      },
    });

    const { createPiboDelegateContinueTool } = await import("./delegate-tools.js");
    const tool = createPiboDelegateContinueTool(createApi(stateDir) as never)(createCtx() as never);

    const result = (await tool.execute?.("call-2", {
      delegateId,
      message: "Continue the same work",
      timeoutSeconds: 20,
    })) as { details: Record<string, unknown> };

    expect(sendExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionKey: "agent:langgraph:subagent:child-1",
        message: "Continue the same work",
        timeoutSeconds: 20,
      }),
    );
    expect(result.details).toMatchObject({
      ok: true,
      delegateId,
      status: "ok",
      reply: "CHILD CONTINUED",
    });
  });

  it("returns delegate status plus the latest assistant reply", async () => {
    const delegateId = "delegate-2";
    fs.mkdirSync(path.join(stateDir, "pibo", "delegates"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "pibo", "delegates", `${delegateId}.json`),
      JSON.stringify({
        delegateId,
        ownerSessionKey: "agent:main:telegram:group:-1003736645971:topic:3336",
        targetAgentId: "langgraph",
        childSessionKey: "agent:langgraph:subagent:child-2",
        originalTask: "Do the delegated work",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        start: { status: "accepted", runId: "spawn-run-2" },
      }),
      "utf8",
    );

    const api = createApi(stateDir);
    const { createPiboDelegateStatusTool } = await import("./delegate-tools.js");
    const tool = createPiboDelegateStatusTool(api as never)(createCtx() as never);

    const result = (await tool.execute?.("call-3", {
      delegateId,
    })) as { details: Record<string, unknown> };

    expect(api.runtime.subagent.getSessionMessages).toHaveBeenCalledWith({
      sessionKey: "agent:langgraph:subagent:child-2",
      limit: 50,
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.latestAssistantReply).toBe("LATEST CHILD REPLY");
  });
});
