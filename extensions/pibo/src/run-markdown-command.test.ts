import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { PluginCommandContext } from "../../../src/plugins/types.js";

const originalHome = process.env.HOME;

function withTempHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pibo-run-"));
  process.env.HOME = tempHome;
  return tempHome;
}

function writeCommandFile(homeDir: string, relativeName: string, content: string): void {
  const commandDir = path.join(homeDir, ".config", "pibo", "commands");
  fs.mkdirSync(commandDir, { recursive: true });
  fs.writeFileSync(path.join(commandDir, relativeName), content, "utf8");
}

describe("runMarkdownCommandByName", () => {
  beforeEach(() => {
    withTempHome();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  it("passes prompt and runtime routing fields to the embedded agent runner", async () => {
    writeCommandFile(
      process.env.HOME!,
      "tldr.md",
      `---\ndescription: TLDR\nbehavior: one-shot\n---\n\n# TLDR`,
    );
    const { runMarkdownCommandByName } = await import("./run-markdown-command.js");

    const runEmbeddedPiAgent = vi.fn(async () => ({ text: "ok" }));
    const saveSessionStore = vi.fn();
    const api = {
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.4",
          },
        },
      } as OpenClawConfig,
      logger: {
        info() {},
        error() {},
      },
      runtime: {
        agent: {
          resolveAgentWorkspaceDir: () => "/tmp/openclaw-agent-workspace",
          ensureAgentWorkspace: vi.fn(async () => {}),
          resolveAgentDir: () => "/tmp/openclaw-agent",
          resolveAgentTimeoutMs: () => 30_000,
          runEmbeddedPiAgent,
          session: {
            resolveStorePath: () => "/tmp/openclaw-agent/store.json",
            loadSessionStore: () => ({}),
            saveSessionStore,
            resolveSessionFilePath: (sessionId: string) => `/tmp/openclaw-agent/${sessionId}.jsonl`,
          },
        },
      },
    } as any;

    const ctx: PluginCommandContext = {
      channel: "telegram",
      isAuthorizedSender: true,
      sessionKey: "agent:main:telegram:group:-1003736645971:topic:1609",
      sessionId: "session-1",
      commandBody: "/tldr",
      args: "Kurz bitte",
      config: api.config,
      from: "telegram:group:-1003736645971:topic:1609",
      to: "telegram:-1003736645971",
      accountId: "telegram-default",
      messageThreadId: 1609,
      senderId: "6214977845",
      requestConversationBinding: async () => ({ status: "error", message: "unused" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    };

    const reply = await runMarkdownCommandByName(api, "tldr", ctx);

    expect(reply).toEqual({ text: "ok" });
    expect(saveSessionStore).toHaveBeenCalled();
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Kurz bitte"),
        workspaceDir: "/tmp/openclaw-agent-workspace",
        config: api.config,
        messageProvider: "telegram",
        messageTo: "telegram:-1003736645971",
        agentAccountId: "telegram-default",
        messageThreadId: 1609,
        senderId: "6214977845",
      }),
    );
    expect(runEmbeddedPiAgent.mock.calls[0]?.[0]).not.toHaveProperty("input");
  });
});
