import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../config/home-env.test-harness.js";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

import { findRun } from "./index.js";

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
}

async function writePromptFiles(home: string) {
  const promptsDir = path.join(home, ".openclaw/workspace/prompts/find");
  await fs.mkdir(promptsDir, { recursive: true });
  await fs.writeFile(path.join(promptsDir, "docs.md"), "docs prompt", "utf8");
  await fs.writeFile(path.join(promptsDir, "code.md"), "code prompt", "utf8");
}

describe("pibo find", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits parent-side lifecycle messages on stderr and keeps final sections on stdout", async () => {
    vi.useFakeTimers();

    await withTempHome("openclaw-pibo-find-run-", async (home) => {
      await writePromptFiles(home);

      const docsChild = new FakeChild();
      const codeChild = new FakeChild();
      spawnMock.mockReturnValueOnce(docsChild).mockReturnValueOnce(codeChild);

      const stderrWrites: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
      });
      const stdoutLogs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        stdoutLogs.push(args.map(String).join(" "));
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit);

      const runPromise = findRun("find the finder", {});

      expect(stderrWrites.join("")).toContain("[openclaw pibo find] DOCS: started");
      expect(stderrWrites.join("")).toContain("[openclaw pibo find] CODE: started");

      vi.advanceTimersByTime(10_000);
      expect(stderrWrites.join("")).toContain("DOCS: still searching");
      expect(stderrWrites.join("")).toContain("CODE: still searching");

      docsChild.stdout.emitData("docs result\n");
      docsChild.emit("close", 0);
      await Promise.resolve();

      vi.advanceTimersByTime(10_000);
      const stderrOutput = stderrWrites.join("");
      expect(stderrOutput).toContain("DOCS: finished in");
      expect(stderrOutput).toContain("CODE: still searching");

      codeChild.stdout.emitData("code result\n");
      codeChild.emit("close", 0);

      await expect(runPromise).rejects.toThrow("process.exit:0");

      expect(stdoutLogs.join("\n")).toContain("=== DOCS ===");
      expect(stdoutLogs.join("\n")).toContain("docs result");
      expect(stdoutLogs.join("\n")).toContain("=== CODE ===");
      expect(stdoutLogs.join("\n")).toContain("code result");

      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        "opencode",
        [
          "run",
          "--agent",
          "explore",
          "-m",
          "minimax/MiniMax-M2.7-highspeed",
          expect.stringContaining("find the finder"),
        ],
        { cwd: path.join(home, "docs"), stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        "opencode",
        [
          "run",
          "--agent",
          "explore",
          "-m",
          "minimax/MiniMax-M2.7-highspeed",
          expect.stringContaining("find the finder"),
        ],
        { cwd: path.join(home, "code"), stdio: ["ignore", "pipe", "pipe"] },
      );

      stderrSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  it("fails fast with a human-readable error when opencode is missing", async () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      error: Object.assign(new Error("spawnSync opencode ENOENT"), { code: "ENOENT" }),
    });

    await withTempHome("openclaw-pibo-find-missing-opencode-", async (home) => {
      await writePromptFiles(home);

      await expect(findRun("find the finder", { docs: true })).rejects.toThrow(
        "OpenCode CLI nicht gefunden",
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  it("reports failed runs on stderr and preserves stdout error aggregation", async () => {
    await withTempHome("openclaw-pibo-find-failure-", async (home) => {
      await writePromptFiles(home);

      const docsChild = new FakeChild();
      spawnMock.mockReturnValueOnce(docsChild);

      const stderrWrites: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
      });
      const stdoutLogs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        stdoutLogs.push(args.map(String).join(" "));
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code ?? ""}`);
      }) as typeof process.exit);

      const runPromise = findRun("find the finder", { docs: true });
      docsChild.stderr.emitData("child failed\n");
      docsChild.emit("close", 2);

      await expect(runPromise).rejects.toThrow("process.exit:1");

      expect(stderrWrites.join("")).toContain("DOCS: failed in");
      expect(stdoutLogs.join("\n")).toContain("=== DOCS ===");
      expect(stdoutLogs.join("\n")).toContain("FEHLER: OpenCode exit 2");
      expect(stdoutLogs.join("\n")).toContain("child failed");

      stderrSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
