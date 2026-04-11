import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "../../../test/helpers/plugins/subagent-hooks.js";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { registerTelegramSubagentHooks } from "./subagent-hooks.js";
import {
  __testing as threadBindingTesting,
  createTelegramThreadBindingManager,
  getTelegramThreadBindingManager,
} from "./thread-bindings.js";

const baseConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  channels: {
    telegram: {
      accounts: {
        work: {},
        langgraph: {},
      },
    },
  },
};

function registerHandlersForTest(config: Record<string, unknown> = baseConfig) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: registerTelegramSubagentHooks,
  });
}

describe("telegram subagent hook handlers", () => {
  beforeEach(async () => {
    await threadBindingTesting.resetTelegramThreadBindingsForTests();
  });

  afterEach(async () => {
    await threadBindingTesting.resetTelegramThreadBindingsForTests();
  });

  it("binds the current Telegram topic on subagent_spawning", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    const result = await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:topic-child",
        agentId: "codex",
        label: "topic-child",
        mode: "session",
        requester: {
          channel: "telegram",
          accountId: "work",
          to: "telegram:-100200300",
          threadId: "77",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({ status: "ok", threadBindingReady: true });
    expect(
      getTelegramThreadBindingManager("work")?.listBySessionKey("agent:main:subagent:topic-child"),
    ).toMatchObject([
      {
        conversationId: "-100200300:topic:77",
        metadata: {
          deliveryTo: "-100200300",
          deliveryThreadId: "77",
        },
      },
    ]);
    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:topic-child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "telegram",
            accountId: "work",
            to: "telegram:-100200300",
            threadId: "77",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).toEqual({
      origin: {
        channel: "telegram",
        accountId: "work",
        to: "-100200300",
        threadId: "77",
      },
    });
  });

  it("binds the current Telegram DM on subagent_spawning", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    const result = await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:dm-child",
        agentId: "codex",
        label: "dm-child",
        mode: "session",
        requester: {
          channel: "telegram",
          accountId: "work",
          to: "telegram:123456",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({ status: "ok", threadBindingReady: true });
    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:dm-child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "telegram",
            accountId: "work",
            to: "telegram:123456",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).toEqual({
      origin: {
        channel: "telegram",
        accountId: "work",
        to: "123456",
      },
    });
  });

  it("matches the requester topic when multiple Telegram bindings exist for the same child session", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:shared-child",
        agentId: "codex",
        label: "shared-child",
        mode: "session",
        requester: {
          channel: "telegram",
          accountId: "work",
          to: "telegram:-100200300",
          threadId: "77",
        },
        threadRequested: true,
      },
      {},
    );
    await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:shared-child",
        agentId: "codex",
        label: "shared-child",
        mode: "session",
        requester: {
          channel: "telegram",
          accountId: "work",
          to: "telegram:-100200300",
          threadId: "88",
        },
        threadRequested: true,
      },
      {},
    );

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:shared-child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "telegram",
            accountId: "work",
            to: "telegram:-100200300",
            threadId: "88",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).toEqual({
      origin: {
        channel: "telegram",
        accountId: "work",
        to: "-100200300",
        threadId: "88",
      },
    });
  });

  it("uses the child agent Telegram account for cross-agent completion delivery", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    const result = await spawnHandler(
      {
        childSessionKey: "agent:langgraph:subagent:topic-child",
        agentId: "langgraph",
        label: "topic-child",
        mode: "run",
        requester: {
          channel: "telegram",
          accountId: "work",
          to: "telegram:-100200300",
          threadId: "77",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({ status: "ok", threadBindingReady: true });
    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:langgraph:subagent:topic-child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "telegram",
            accountId: "work",
            to: "telegram:-100200300",
            threadId: "77",
          },
          expectsCompletionMessage: true,
        },
        {},
      ),
    ).toEqual({
      origin: {
        channel: "telegram",
        accountId: "langgraph",
        to: "-100200300",
        threadId: "77",
      },
    });
  });

  it("rejects Telegram thread-bound spawns when spawnSubagentSessions is disabled", async () => {
    const handlers = registerHandlersForTest({
      session: { mainKey: "main", scope: "per-sender" },
      channels: {
        telegram: {
          threadBindings: {
            spawnSubagentSessions: false,
          },
        },
      },
    });
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      spawnHandler(
        {
          childSessionKey: "agent:main:subagent:disabled-child",
          agentId: "codex",
          label: "disabled-child",
          mode: "session",
          requester: {
            channel: "telegram",
            accountId: "work",
            to: "telegram:-100200300",
            threadId: "77",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("spawnSubagentSessions=true"),
    });
  });

  it("unbinds Telegram bindings on subagent_ended", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const endedHandler = getRequiredHookHandler(handlers, "subagent_ended");
    createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await spawnHandler(
      {
        childSessionKey: "agent:main:subagent:topic-child",
        agentId: "codex",
        label: "topic-child",
        mode: "session",
        requester: {
          channel: "telegram",
          accountId: "work",
          to: "telegram:-100200300",
          threadId: "77",
        },
        threadRequested: true,
      },
      {},
    );
    expect(
      getTelegramThreadBindingManager("work")?.listBySessionKey("agent:main:subagent:topic-child"),
    ).toHaveLength(1);

    endedHandler(
      {
        accountId: "work",
        targetSessionKey: "agent:main:subagent:topic-child",
      },
      {},
    );

    expect(
      getTelegramThreadBindingManager("work")?.listBySessionKey("agent:main:subagent:topic-child"),
    ).toHaveLength(0);
  });
});
