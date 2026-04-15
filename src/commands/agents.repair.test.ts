import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { agentsRepairCommand } from "./agents.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

describe("agents repair command", () => {
  const runtime = createTestRuntime();

  beforeEach(() => {
    readConfigFileSnapshotMock.mockReset();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("repairs existing configured workspaces and reports concise counts", async () => {
    const root = await makeTempWorkspace("openclaw-agents-repair-");
    const createdWorkspace = path.join(root, "created");
    const repairedWorkspace = path.join(root, "repaired");
    const correctWorkspace = path.join(root, "correct");
    const missingWorkspace = path.join(root, "missing");

    await fs.mkdir(createdWorkspace, { recursive: true });
    await fs.mkdir(path.join(repairedWorkspace, ".codex"), { recursive: true });
    await fs.mkdir(path.join(correctWorkspace, ".codex"), { recursive: true });
    await fs.symlink(path.join("..", "wrong-skills"), path.join(repairedWorkspace, ".codex", "skills"), "dir");
    await fs.symlink(
      path.join(correctWorkspace, "skills"),
      path.join(correctWorkspace, ".codex", "skills"),
      "dir",
    );

    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          list: [
            { id: "main", workspace: createdWorkspace },
            { id: "ops", workspace: repairedWorkspace },
            { id: "same-a", workspace: correctWorkspace },
            { id: "same-b", workspace: correctWorkspace },
            { id: "missing", workspace: missingWorkspace },
          ],
        },
      },
    });

    await agentsRepairCommand(runtime);

    expect(await fs.readlink(path.join(createdWorkspace, ".codex", "skills"))).toBe(path.join("..", "skills"));
    expect(await fs.readlink(path.join(repairedWorkspace, ".codex", "skills"))).toBe(path.join("..", "skills"));
    expect(await fs.readlink(path.join(correctWorkspace, ".codex", "skills"))).toBe(
      path.join(correctWorkspace, "skills"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Codex skills symlink: created 1, repaired 1, already correct 1, skipped missing 1.",
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves non-symlink conflicts and exits 1", async () => {
    const root = await makeTempWorkspace("openclaw-agents-repair-conflict-");
    const conflictWorkspace = path.join(root, "conflict");
    await fs.mkdir(path.join(conflictWorkspace, ".codex", "skills"), { recursive: true });

    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          list: [{ id: "main", workspace: conflictWorkspace }],
        },
      },
    });

    await agentsRepairCommand(runtime);

    expect(runtime.log).toHaveBeenCalledWith(
      "Codex skills symlink: created 0, repaired 0, already correct 0.",
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("already exists and is not a symlink"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
