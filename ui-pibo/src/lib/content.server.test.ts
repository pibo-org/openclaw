import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalStorageDir = process.env.PIBO_STORAGE_DIR;
let testDir = "";

beforeEach(async () => {
  testDir = await mkdtemp(path.join(os.tmpdir(), "webapp-content-server-"));
  process.chdir(testDir);
  process.env.PIBO_STORAGE_DIR = path.join(testDir, "test-storage");
  vi.resetModules();
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (typeof originalStorageDir === "string") {
    process.env.PIBO_STORAGE_DIR = originalStorageDir;
  } else {
    delete process.env.PIBO_STORAGE_DIR;
  }
  vi.resetModules();
  await rm(testDir, { recursive: true, force: true });
});

describe("content.server trash workflow", () => {
  it("moves deleted documents into trash and restores them with a unique name on conflict", async () => {
    const content = await import("./content.server");

    await content.ensureStorage();
    await mkdir(path.join(testDir, "test-storage", "docs", "journal"), {
      recursive: true,
    });
    await writeFile(
      path.join(testDir, "test-storage", "docs", "journal", "alpha.md"),
      "# Alpha",
      "utf8",
    );

    const deleted = await content.deleteDocument({
      documentPath: "journal/alpha",
      activeDocumentPath: "journal/alpha",
      selectedFolderPath: "journal",
    });

    expect(
      await pathExists(path.join(testDir, "test-storage", "docs", "journal", "alpha.md")),
    ).toBe(false);
    expect(deleted.trashCount).toBe(1);

    await writeFile(
      path.join(testDir, "test-storage", "docs", "journal", "alpha.md"),
      "# Conflict",
      "utf8",
    );

    const trashItems = await content.listTrashItems();
    const restored = await content.restoreTrashItem({ id: trashItems[0].id });

    expect(restored.restoredPath).toBe("journal/alpha-2");
    expect(restored.activeDocument?.path).toBe("journal/alpha-2");
    expect(
      await pathExists(path.join(testDir, "test-storage", "docs", "journal", "alpha-2.md")),
    ).toBe(true);
    expect(await content.getTrashCount()).toBe(0);
  });

  it("empties trash and purges expired entries only after retention", async () => {
    const content = await import("./content.server");

    await content.ensureStorage();
    await mkdir(path.join(testDir, "test-storage", "docs", "folder"), {
      recursive: true,
    });
    await writeFile(
      path.join(testDir, "test-storage", "docs", "folder", "note.md"),
      "# Note",
      "utf8",
    );

    await content.deleteDirectory({
      directoryPath: "folder",
      activeDocumentPath: null,
      selectedFolderPath: "folder",
    });

    let trashItems = await content.listTrashItems();
    expect(trashItems).toHaveLength(1);

    const metaPath = path.join(
      testDir,
      "test-storage",
      "trash",
      "meta",
      `${trashItems[0].id}.json`,
    );
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
      purgeAfter: string;
    };
    meta.purgeAfter = new Date(Date.now() - 1000).toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

    expect(await content.listTrashItems()).toHaveLength(0);

    await mkdir(path.join(testDir, "test-storage", "docs", "folder-two"), {
      recursive: true,
    });
    await writeFile(
      path.join(testDir, "test-storage", "docs", "folder-two", "note.md"),
      "# Note",
      "utf8",
    );
    await content.deleteDirectory({
      directoryPath: "folder-two",
      activeDocumentPath: null,
      selectedFolderPath: null,
    });

    trashItems = await content.listTrashItems();
    expect(trashItems).toHaveLength(1);

    const emptied = await content.emptyTrash();
    expect(emptied.trashCount).toBe(0);
    expect(await content.listTrashItems()).toHaveLength(0);
  });
});

describe("content.server tree mutations", () => {
  it("moves the active document into another folder and resolves name conflicts", async () => {
    const content = await import("./content.server");

    await content.ensureStorage();
    await mkdir(path.join(testDir, "test-storage", "docs", "source"), {
      recursive: true,
    });
    await mkdir(path.join(testDir, "test-storage", "docs", "target"), {
      recursive: true,
    });
    await writeFile(
      path.join(testDir, "test-storage", "docs", "source", "note.md"),
      "# Source",
      "utf8",
    );
    await writeFile(
      path.join(testDir, "test-storage", "docs", "target", "note.md"),
      "# Existing",
      "utf8",
    );

    const moved = await content.moveDocument({
      documentPath: "source/note",
      destinationDirectoryPath: "target",
      activeDocumentPath: "source/note",
      selectedFolderPath: "source",
    });

    expect(moved.activeDocument?.path).toBe("target/note-2");
    expect(moved.selectedFolderPath).toBe("target");
    expect(await pathExists(path.join(testDir, "test-storage", "docs", "source", "note.md"))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(testDir, "test-storage", "docs", "target", "note-2.md")),
    ).toBe(true);
  });

  it("moves a directory and rewrites selected folder and active document paths", async () => {
    const content = await import("./content.server");

    await content.ensureStorage();
    await mkdir(path.join(testDir, "test-storage", "docs", "projects"), {
      recursive: true,
    });
    await mkdir(path.join(testDir, "test-storage", "docs", "archive"), {
      recursive: true,
    });
    await writeFile(
      path.join(testDir, "test-storage", "docs", "projects", "spec.md"),
      "# Spec",
      "utf8",
    );

    const moved = await content.moveDirectory({
      directoryPath: "projects",
      destinationDirectoryPath: "archive",
      activeDocumentPath: "projects/spec",
      selectedFolderPath: "projects",
    });

    expect(moved.activeDocument?.path).toBe("archive/projects/spec");
    expect(moved.selectedFolderPath).toBe("archive/projects");
    expect(
      await pathExists(
        path.join(testDir, "test-storage", "docs", "archive", "projects", "spec.md"),
      ),
    ).toBe(true);
  });

  it("renames documents and directories while keeping active selections consistent", async () => {
    const content = await import("./content.server");

    await content.ensureStorage();
    await mkdir(path.join(testDir, "test-storage", "docs", "journal"), {
      recursive: true,
    });
    await writeFile(
      path.join(testDir, "test-storage", "docs", "journal", "daily-note.md"),
      "# Daily",
      "utf8",
    );
    await writeFile(
      path.join(testDir, "test-storage", "docs", "journal", "renamed-note.md"),
      "# Existing",
      "utf8",
    );

    const renamedDocument = await content.renameDocument({
      documentPath: "journal/daily-note",
      name: "Renamed Note",
      activeDocumentPath: "journal/daily-note",
      selectedFolderPath: "journal",
    });

    expect(renamedDocument.activeDocument?.path).toBe("journal/renamed-note-2");
    expect(renamedDocument.selectedFolderPath).toBe("journal");

    const renamedDirectory = await content.renameDirectory({
      directoryPath: "journal",
      name: "Archive",
      activeDocumentPath: "journal/renamed-note-2",
      selectedFolderPath: "journal",
    });

    expect(renamedDirectory.activeDocument?.path).toBe("archive/renamed-note-2");
    expect(renamedDirectory.selectedFolderPath).toBe("archive");
    expect(
      await pathExists(path.join(testDir, "test-storage", "docs", "archive", "renamed-note-2.md")),
    ).toBe(true);
  });
});

async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
