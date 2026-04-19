import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { registerPiboCli } from "./pibo-cli.js";

const tempDirs: string[] = [];
async function mktemp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPiboCli(program);
  return program;
}

describe("pibo cli", () => {
  it("registers representative subcommands", () => {
    const program = createProgram();
    const pibo = program.commands.find((command) => command.name() === "pibo");
    const twitter = pibo?.commands.find((command) => command.name() === "twitter");
    const twitterCheck = twitter?.commands.find((command) => command.name() === "check");
    const twitterState = twitter?.commands.find((command) => command.name() === "state");
    const workflows = pibo?.commands.find((command) => command.name() === "workflows");
    expect(pibo).toBeTruthy();
    expect(pibo?.commands.some((command) => command.name() === "find")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "todo")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "mcp")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "twitter")).toBe(true);
    expect(twitterCheck?.commands.some((command) => command.name() === "following")).toBe(true);
    expect(twitterCheck?.commands.some((command) => command.name() === "for-you")).toBe(true);
    expect(twitterState?.commands.some((command) => command.name() === "status")).toBe(true);
    expect(twitterState?.commands.some((command) => command.name() === "reset")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "workflows")).toBe(true);
    expect(workflows?.commands.some((command) => command.name() === "start-async")).toBe(true);
    expect(workflows?.commands.some((command) => command.name() === "wait")).toBe(true);
  });

  it("exposes feed-oriented Twitter help", () => {
    const program = createProgram();
    const pibo = program.commands.find((command) => command.name() === "pibo");
    const twitter = pibo?.commands.find((command) => command.name() === "twitter");
    const twitterCheck = twitter?.commands.find((command) => command.name() === "check");
    const following = twitterCheck?.commands.find((command) => command.name() === "following");
    const forYou = twitterCheck?.commands.find((command) => command.name() === "for-you");
    const twitterState = twitter?.commands.find((command) => command.name() === "state");
    const status = twitterState?.commands.find((command) => command.name() === "status");

    const followingHelp = following?.helpInformation() ?? "";
    const forYouHelp = forYou?.helpInformation() ?? "";
    const statusHelp = status?.helpInformation() ?? "";

    expect(followingHelp).toContain("Scrape the Following feed");
    expect(followingHelp).toContain("--new <n>");
    expect(followingHelp).toContain("--max-scanned <n>");
    expect(followingHelp).toContain("--ignore-state");
    expect(followingHelp).toContain("--no-write-state");
    expect(followingHelp).toContain("--stateless");
    expect(followingHelp).toContain("--json");
    expect(forYouHelp).toContain("Scrape the For You feed");
    expect(statusHelp).toContain("--feed <feed>");
  });

  it("initializes bundled find prompts into the workspace", async () => {
    await withTempHome("openclaw-pibo-find-home-", async (home) => {
      await createProgram().parseAsync(["pibo", "find", "init"], { from: "user" });
      const docsPrompt = await fs.readFile(
        path.join(home, ".openclaw/workspace/prompts/find/docs.md"),
        "utf8",
      );
      const codePrompt = await fs.readFile(
        path.join(home, ".openclaw/workspace/prompts/find/code.md"),
        "utf8",
      );
      expect(docsPrompt).toContain("Finder-Agent für das Dokumentenwesen");
      expect(codePrompt).toContain("Finder-Agent für das Code-Verzeichnis");
    });
  });

  it("creates and summarizes TODO.md", async () => {
    await withTempHome("openclaw-pibo-todo-home-", async () => {
      const workspace = await mktemp("openclaw-pibo-workspace-");
      const cwdSpy = Object.getOwnPropertyDescriptor(process, "cwd");
      const originalCwd = process.cwd.bind(process);
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
      if (cwdSpy) {
        Object.defineProperty(process, "cwd", cwdSpy);
      }
    });
  });
});
