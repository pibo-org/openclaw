import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const mcp = pibo?.commands.find((command) => command.name() === "mcp");
    const workflows = pibo?.commands.find((command) => command.name() === "workflows");
    expect(pibo).toBeTruthy();
    expect(pibo?.commands.some((command) => command.name() === "find")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "todo")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "mcp")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "browser-pool")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "twitter")).toBe(true);
    expect(twitterCheck?.commands.some((command) => command.name() === "following")).toBe(true);
    expect(twitterCheck?.commands.some((command) => command.name() === "for-you")).toBe(true);
    expect(twitterState?.commands.some((command) => command.name() === "status")).toBe(true);
    expect(twitterState?.commands.some((command) => command.name() === "reset")).toBe(true);
    expect(mcp?.commands.some((command) => command.name() === "activate-openclaw")).toBe(true);
    expect(mcp?.commands.some((command) => command.name() === "deactivate-openclaw")).toBe(true);
    expect(pibo?.commands.some((command) => command.name() === "workflows")).toBe(true);
    expect(workflows?.commands.some((command) => command.name() === "start-async")).toBe(true);
    expect(workflows?.commands.some((command) => command.name() === "wait")).toBe(true);
    const worktrees = workflows?.commands.find((command) => command.name() === "worktrees");
    expect(worktrees?.commands.some((command) => command.name() === "owner")).toBe(true);
    expect(worktrees?.commands.some((command) => command.name() === "inspect")).toBe(true);
  });

  it("requires explicit trusted routing flags for workflow starts", async () => {
    const program = createProgram();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      program.parseAsync(["pibo", "workflows", "start", "noop"], { from: "user" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("--owner-session-key"),
    });

    stderrWrite.mockRestore();
  });

  it("documents trusted routing flags for workflow start commands", () => {
    const program = createProgram();
    const pibo = program.commands.find((command) => command.name() === "pibo");
    const workflows = pibo?.commands.find((command) => command.name() === "workflows");
    const start = workflows?.commands.find((command) => command.name() === "start");
    const startAsync = workflows?.commands.find((command) => command.name() === "start-async");
    const workflowsHelp = workflows?.helpInformation() ?? "";

    const startHelp = start?.helpInformation() ?? "";
    const startAsyncHelp = startAsync?.helpInformation() ?? "";

    expect(workflowsHelp).not.toContain("_run-pending");
    expect(startHelp).toContain("--owner-session-key <key>");
    expect(startHelp).toContain("--channel <name>");
    expect(startHelp).toContain("--to <target>");
    expect(startHelp).toContain("--account-id <id>");
    expect(startHelp).toContain("--thread-id <id>");
    expect(startAsyncHelp).toContain("--owner-session-key <key>");
    expect(startAsyncHelp).toContain("--thread-id <id>");
  });

  it("exposes MCP help with separated registry and OpenClaw activation semantics", () => {
    const program = createProgram();
    const pibo = program.commands.find((command) => command.name() === "pibo");
    const mcp = pibo?.commands.find((command) => command.name() === "mcp");
    const activate = mcp?.commands.find((command) => command.name() === "activate-openclaw");
    const deactivate = mcp?.commands.find((command) => command.name() === "deactivate-openclaw");
    const tools = mcp?.commands.find((command) => command.name() === "tools");

    const mcpHelp = mcp?.helpInformation() ?? "";
    const activateHelp = activate?.helpInformation() ?? "";
    const deactivateHelp = deactivate?.helpInformation() ?? "";
    const toolsHelp = tools?.helpInformation() ?? "";

    expect(mcpHelp).toContain("PIBo-MCP-Registry verwalten");
    expect(mcpHelp).toContain("activate-openclaw");
    expect(mcpHelp).toContain("deactivate-openclaw");
    expect(activateHelp).toContain("explizit in OpenClaw aktivieren");
    expect(deactivateHelp).toContain("in der PIBo-Registry lassen");
    expect(toolsHelp).toContain("registrierten PIBo-MCP-Servers");
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

  it("exposes browser-pool help", () => {
    const program = createProgram();
    const pibo = program.commands.find((command) => command.name() === "pibo");
    const browserPool = pibo?.commands.find((command) => command.name() === "browser-pool");
    const acquire = browserPool?.commands.find((command) => command.name() === "acquire");
    const renew = browserPool?.commands.find((command) => command.name() === "renew");
    const release = browserPool?.commands.find((command) => command.name() === "release");

    const browserPoolHelp = browserPool?.helpInformation() ?? "";
    const acquireHelp = acquire?.helpInformation() ?? "";
    const renewHelp = renew?.helpInformation() ?? "";
    const releaseHelp = release?.helpInformation() ?? "";

    expect(browserPoolHelp).toContain("Dev browser profile router");
    expect(acquireHelp).toContain("--agent-id <id>");
    expect(acquireHelp).toContain("--session-key <key>");
    expect(acquireHelp).toContain("--workflow-run-id <id>");
    expect(browserPool?.commands.some((command) => command.name() === "heartbeat")).toBe(false);
    expect(renewHelp).toContain("--browser-profile <name>");
    expect(releaseHelp).toContain("--lease-id <id>");
    expect(releaseHelp).toContain("--browser-profile <name>");
  });

  it("exposes agentic find help", () => {
    const program = createProgram();
    const pibo = program.commands.find((command) => command.name() === "pibo");
    const find = pibo?.commands.find((command) => command.name() === "find");
    const findHelp = find?.helpInformation() ?? "";

    expect(findHelp).toContain(
      "Agentischer OpenCode-Finder für Docs/Code; kann dauern, zeigt stderr-Liveness",
    );
    expect(findHelp).toContain("Usage:  pibo find [options] [prompt]");
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
