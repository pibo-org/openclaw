import { describe, expect, it } from "vitest";
import { createStarterModel, parseMermaidInput } from "./mermaidAdapter";
import {
  WORKSPACE_CORRUPT_BACKUP_KEY,
  WORKSPACE_RECOVERY_NOTICE_KEY,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STORAGE_KEY,
  createDiagramRecord,
  loadWorkspace,
  migrateWorkspace,
  saveWorkspace,
  updateWorkspaceDiagram,
} from "./workspaceStorage";
import type { PersistedWorkspace } from "./workspaceStorage";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("workspace storage", () => {
  it("creates, saves, and loads a versioned workspace with multiple diagrams", () => {
    const storage = new MemoryStorage();
    const flow = createDiagramRecord(createStarterModel("flowchart"), "Flow");
    const sequence = createDiagramRecord(createStarterModel("sequenceDiagram"), "Sequence");
    const workspace: PersistedWorkspace = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      currentDiagramId: sequence.id,
      diagrams: [flow, sequence],
    };

    expect(saveWorkspace(workspace, storage)).toBe("");
    const loaded = loadWorkspace(storage);

    expect(loaded.recoveryMessage).toBe("");
    expect(loaded.workspace.currentDiagramId).toBe(sequence.id);
    expect(loaded.workspace.diagrams.map((diagram) => diagram.name)).toEqual(["Flow", "Sequence"]);
  });

  it("migrates valid records and repairs a missing current diagram id", () => {
    const diagram = createDiagramRecord(createStarterModel("classDiagram"), "Class model");
    const workspace = migrateWorkspace({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      currentDiagramId: "missing",
      diagrams: [diagram],
    });

    expect(workspace.currentDiagramId).toBe(diagram.id);
    expect(workspace.diagrams[0].kind).toBe("classDiagram");
  });

  it("recovers from corrupt local storage without throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(WORKSPACE_STORAGE_KEY, "{not json");

    const loaded = loadWorkspace(storage);

    expect(loaded.recoveryMessage).toMatch(/storage was reset/i);
    expect(loaded.workspace.diagrams).toHaveLength(1);
    expect(loaded.workspace.diagrams[0].kind).toBe("flowchart");
    expect(JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}").schemaVersion).toBe(
      WORKSPACE_SCHEMA_VERSION,
    );
    expect(JSON.parse(storage.getItem(WORKSPACE_CORRUPT_BACKUP_KEY) ?? "{}").payload).toBe(
      "{not json",
    );
    expect(storage.getItem(WORKSPACE_RECOVERY_NOTICE_KEY)).toMatch(/storage was reset/i);
    expect(loadWorkspace(storage).recoveryMessage).toMatch(/storage was reset/i);
  });

  it("updates the saved model, code, kind, and timestamp when a diagram changes", () => {
    const original = createDiagramRecord(createStarterModel("flowchart"), "Flow");
    const nextModel = parseMermaidInput(`sequenceDiagram
      participant A
      participant B
      A->>+B: Ping`);
    const workspace = updateWorkspaceDiagram(
      {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        currentDiagramId: original.id,
        diagrams: [original],
      },
      original.id,
      nextModel,
      new Date("2026-04-30T12:00:00.000Z"),
    );

    expect(workspace.diagrams[0].kind).toBe("sequenceDiagram");
    expect(workspace.diagrams[0].updatedAt).toBe("2026-04-30T12:00:00.000Z");
    expect(workspace.diagrams[0].code).toContain("A->>+B: Ping");
  });
});
