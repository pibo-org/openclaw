import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalSyncTarget } from "./config.js";
import { generateWatcherScript, migrateLegacyWorkspaceServices } from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dirPath) => {
      await fs.rm(dirPath, { force: true, recursive: true });
    }),
  );
  tempDirs.length = 0;
});

async function mkTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importGeneratedWatcher(target: LocalSyncTarget) {
  const tempDir = await mkTempDir("openclaw-local-sync-watcher-");
  const scriptPath = path.join(tempDir, "watcher.mjs");
  await fs.writeFile(scriptPath, generateWatcherScript(target), "utf8");
  return import(`${pathToFileURL(scriptPath).href}?t=${Date.now()}`);
}

function targetFor(targetPath: string, ignoreGlobs: string[] = []): LocalSyncTarget {
  return {
    name: "workspace",
    path: targetPath,
    repo: "git@example.com:openclaw/workspace.git",
    branch: "main",
    enabled: true,
    ignoreGlobs,
    serviceName: "pibo-local-sync-workspace",
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  };
}

describe("local-sync workspace watcher generation", () => {
  it("hardcodes .git exclusion and derives non-.git ignores from .gitignore", async () => {
    const workspacePath = await mkTempDir("openclaw-workspace-");
    await fs.writeFile(
      path.join(workspacePath, ".gitignore"),
      [
        "# watcher should ignore these",
        "node_modules/",
        "*.png",
        "/root-only.md",
        "!.keep.md",
        "!.git",
      ].join("\n"),
      "utf8",
    );

    const watcher = await importGeneratedWatcher(targetFor(workspacePath));
    const rules = watcher.loadIgnoreRules(path.join(workspacePath, ".gitignore"), []);

    expect(watcher.shouldProcessFile(".git/config", rules)).toBe(false);
    expect(watcher.shouldProcessFile("nested/.git/config", rules)).toBe(false);
    expect(watcher.shouldProcessFile("node_modules/pkg/index.js", rules)).toBe(false);
    expect(watcher.shouldProcessFile("src/node_modules/pkg/index.js", rules)).toBe(false);
    expect(watcher.shouldProcessFile("image.png", rules)).toBe(false);
    expect(watcher.shouldProcessFile("root-only.md", rules)).toBe(false);
    expect(watcher.shouldProcessFile("nested/root-only.md", rules)).toBe(true);
    expect(watcher.shouldProcessFile(".keep.md", rules)).toBe(true);
    expect(watcher.shouldProcessFile("notes.md", rules)).toBe(true);
  });

  it("keeps configured non-.git ignores when no .gitignore is present", async () => {
    const workspacePath = await mkTempDir("openclaw-workspace-");
    const watcher = await importGeneratedWatcher(
      targetFor(workspacePath, [".git", ".trash", "*.pdf"]),
    );

    expect(watcher.shouldProcessFile(".git/index")).toBe(false);
    expect(watcher.shouldProcessFile(".trash/deleted.md")).toBe(false);
    expect(watcher.shouldProcessFile("paper.pdf")).toBe(false);
    expect(watcher.shouldProcessFile("paper.md")).toBe(true);
  });
});

describe("local-sync workspace legacy migration", () => {
  it("removes the old duplicate workspace service without touching the canonical service", () => {
    const commands: string[] = [];
    const removed: string[] = [];
    const notes = migrateLegacyWorkspaceServices({
      runCommand: (command) => {
        commands.push(command);
        return "";
      },
      exists: (filePath) => filePath.endsWith("pibo-workspace-watcher.service"),
      removeFile: (filePath) => {
        removed.push(filePath);
      },
      serviceFilePathFor: (serviceName) => `/tmp/${serviceName}.service`,
    });

    expect(notes).toEqual([
      "Legacy-Service pibo-workspace-watcher.service deaktiviert und entfernt",
    ]);
    expect(commands).toEqual([
      "systemctl --user disable --now pibo-workspace-watcher.service",
      "systemctl --user daemon-reload",
    ]);
    expect(removed).toEqual(["/tmp/pibo-workspace-watcher.service"]);
    expect(removed).not.toContain("/tmp/pibo-local-sync-workspace.service");
  });
});
