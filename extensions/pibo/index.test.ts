import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { buildPluginApi } from "../../src/plugins/api-builder.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";

type RegisteredCommand = {
  name: string;
  nativeNames?: { default?: string; telegram?: string; discord?: string };
  description?: string;
};

type RegisteredTool = {
  name?: string;
};

type RegisteredHook = {
  hookName: string;
  handler?: unknown;
};

const originalHome = process.env.HOME;
const PIBO_GLOBAL_SYSTEM_PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "pibo-global-system-prompt.md",
);

function withTempHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pibo-plugin-"));
  process.env.HOME = tempHome;
  return tempHome;
}

function writeCommandFile(homeDir: string, relativeName: string, content: string): void {
  const commandDir = path.join(homeDir, ".config", "pibo", "commands");
  fs.mkdirSync(commandDir, { recursive: true });
  fs.writeFileSync(path.join(commandDir, relativeName), content, "utf8");
}

describe("bundled pibo extension", () => {
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

  it("registers bundled /pibo plus markdown commands with aliases", async () => {
    writeCommandFile(
      process.env.HOME!,
      "autonomy_high.md",
      `---\ndescription: Autonomy high\nbehavior: mode\nnative_name: autonomy_high\n---\n\n# Autonomy High`,
    );
    writeCommandFile(
      process.env.HOME!,
      "tldr.md",
      `---\ndescription: TLDR\nbehavior: one-shot\n---\n\n# TLDR`,
    );

    const { default: piboPlugin } = await import("./index.js");
    const commands: RegisteredCommand[] = [];
    const tools: RegisteredTool[] = [];
    const hooks: RegisteredHook[] = [];
    const api = buildPluginApi({
      id: "pibo",
      name: "PIBo",
      source: "test",
      registrationMode: "full",
      config: {} as OpenClawConfig,
      runtime: {} as PluginRuntime,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      resolvePath: (input) => input,
      handlers: {
        registerCommand(command) {
          commands.push({
            name: command.name,
            nativeNames: command.nativeNames,
            description: command.description,
          });
        },
        registerTool(tool) {
          const resolved =
            typeof tool === "function" ? tool({ config: {}, sessionKey: "test" } as never) : tool;
          tools.push({ name: (resolved as { name?: string }).name });
        },
        on(hookName, handler) {
          hooks.push({ hookName, handler });
        },
      },
    });

    piboPlugin.register(api);

    expect(commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["pibo", "tldr"]),
    );
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "pibo_delegate_start",
        "pibo_delegate_continue",
        "pibo_delegate_status",
        "pibo_workflow_start",
        "pibo_workflow_start_async",
        "pibo_workflow_wait",
        "pibo_workflow_status",
        "pibo_workflow_progress",
        "pibo_workflow_abort",
        "pibo_workflow_describe",
        "pibo_workflow_trace_summary",
        "pibo_workflow_trace_events",
        "pibo_workflow_artifacts",
        "pibo_workflow_artifact",
      ]),
    );
    expect(hooks).toEqual(
      expect.arrayContaining([
        { hookName: "before_prompt_build", handler: expect.any(Function) },
        { hookName: "before_tool_call", handler: expect.any(Function) },
      ]),
    );

    const beforePromptBuild = hooks.find((hook) => hook.hookName === "before_prompt_build");
    expect(beforePromptBuild?.handler).toBeTypeOf("function");
    const beforePromptBuildHandler = beforePromptBuild?.handler as
      | ((event: { prompt: string; messages: unknown[] }, ctx: unknown) => unknown | Promise<unknown>)
      | undefined;
    expect(await beforePromptBuildHandler?.({ prompt: "test", messages: [] }, {})).toEqual({
      prependSystemContext: fs.readFileSync(PIBO_GLOBAL_SYSTEM_PROMPT_PATH, "utf8").trim(),
    });
  });
});
