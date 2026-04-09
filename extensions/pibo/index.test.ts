import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { buildPluginApi } from "../../src/plugins/api-builder.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";

type RegisteredCommand = {
  name: string;
  nativeNames?: { default?: string; telegram?: string; discord?: string };
  description?: string;
};

const originalHome = process.env.HOME;

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
      },
    });

    piboPlugin.register(api);

    expect(commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["pibo", "autonomy-high", "tldr"]),
    );
    expect(commands.find((command) => command.name === "autonomy-high")?.nativeNames).toEqual({
      default: "autonomy_high",
    });
  });
});
