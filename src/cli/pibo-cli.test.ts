import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { registerPiboCli } from "./pibo-cli.js";

const tempDirs: string[] = [];
async function mktemp(prefix: string) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); tempDirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function createProgram() { const program = new Command(); program.exitOverride(); registerPiboCli(program); return program; }

describe("pibo cli", () => {
  it("registers representative subcommands", () => {
    const program = createProgram();
    const pibo = program.commands.find((command) => command.name() === "pibo");
    expect(pibo).toBeTruthy();
    expect(pibo?.commands.some((command) => command.name() === "find")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "todo")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "mcp")).toBe(true);
  });

  it("initializes bundled find prompts into the workspace", async () => {
    await withTempHome("openclaw-pibo-find-home-", async (home) => {
      await createProgram().parseAsync(["pibo", "find", "init"], { from: "user" });
      const docsPrompt = await fs.readFile(path.join(home, ".openclaw/workspace/prompts/find/docs.md"), "utf8");
      const codePrompt = await fs.readFile(path.join(home, ".openclaw/workspace/prompts/find/code.md"), "utf8");
      expect(docsPrompt).toContain("Finder-Agent für das Dokumentenwesen");
      expect(codePrompt).toContain("Finder-Agent für das Code-Verzeichnis");
    });
  });

  it("creates and summarizes TODO.md", async () => {
    await withTempHome("openclaw-pibo-todo-home-", async () => {
      const workspace = await mktemp("openclaw-pibo-workspace-");
      const cwdSpy = Object.getOwnPropertyDescriptor(process, "cwd");
      const originalCwd = process.cwd;
      process.cwd = () => workspace;
      try {
        await createProgram().parseAsync(["pibo", "todo", "init"], { from: "user" });
        const todoPath = path.join(workspace, "TODO.md");
        const todo = await fs.readFile(todoPath, "utf8");
        expect(todo).toContain("# TODO.md");
        await createProgram().parseAsync(["pibo", "todo", "status"], { from: "user" });
      } finally {
        process.cwd = originalCwd;
      }
      if (cwdSpy) Object.defineProperty(process, "cwd", cwdSpy);
    });
  });
});
