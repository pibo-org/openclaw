import {
  createStarterModel,
  detectDiagramKind,
  exportMermaid,
  parseMermaidInput,
} from "./mermaidAdapter";
import type { DiagramKind, DiagramModel } from "./mermaidAdapter";

export const WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_STORAGE_KEY = "mermaid-editor.workspace.v1";
export const WORKSPACE_CORRUPT_BACKUP_KEY = "mermaid-editor.workspace.v1.corrupt-backup";
export const WORKSPACE_RECOVERY_NOTICE_KEY = "mermaid-editor.workspace.v1.recovery-notice";

export interface PersistedDiagram {
  id: string;
  name: string;
  kind: Exclude<DiagramKind, "unknown">;
  createdAt: string;
  updatedAt: string;
  code: string;
  model: DiagramModel;
}

export interface PersistedWorkspace {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  currentDiagramId: string;
  diagrams: PersistedDiagram[];
}

export interface WorkspaceLoadResult {
  workspace: PersistedWorkspace;
  recoveryMessage: string;
}

type LocalStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createDiagramRecord(
  model: DiagramModel,
  name = defaultDiagramName(model.kind),
  now = new Date(),
): PersistedDiagram {
  const timestamp = now.toISOString();
  return {
    id: createDiagramId(),
    name,
    kind: model.kind,
    createdAt: timestamp,
    updatedAt: timestamp,
    code: exportMermaid(model),
    model,
  };
}

export function createInitialWorkspace(now = new Date()): PersistedWorkspace {
  const diagram = createDiagramRecord(createStarterModel("flowchart"), "Starter Flowchart", now);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    currentDiagramId: diagram.id,
    diagrams: [diagram],
  };
}

export function loadWorkspace(
  storage: LocalStorageLike = window.localStorage,
): WorkspaceLoadResult {
  let raw: string | null = null;
  let recoveryNotice = "";
  try {
    recoveryNotice = storage.getItem(WORKSPACE_RECOVERY_NOTICE_KEY) ?? "";
    raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) {
      return {
        workspace: createInitialWorkspace(),
        recoveryMessage: recoveryNotice,
      };
    }
    return {
      workspace: migrateWorkspace(JSON.parse(raw)),
      recoveryMessage: recoveryNotice,
    };
  } catch (error) {
    const workspace = createInitialWorkspace();
    const recoveryMessage = `Workspace storage was reset because saved data could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
    try {
      if (raw) {
        storage.setItem(
          WORKSPACE_CORRUPT_BACKUP_KEY,
          JSON.stringify({
            capturedAt: new Date().toISOString(),
            payload: raw,
          }),
        );
      }
      storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
      storage.setItem(WORKSPACE_RECOVERY_NOTICE_KEY, recoveryMessage);
    } catch {
      // The app can still run from the recovered in-memory workspace.
    }
    return {
      workspace,
      recoveryMessage,
    };
  }
}

export function saveWorkspace(
  workspace: PersistedWorkspace,
  storage: LocalStorageLike = window.localStorage,
): string {
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return "";
  } catch (error) {
    return `Autosave failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function clearWorkspace(storage: LocalStorageLike = window.localStorage): void {
  storage.removeItem(WORKSPACE_STORAGE_KEY);
}

export function migrateWorkspace(input: unknown): PersistedWorkspace {
  if (!input || typeof input !== "object") {
    throw new Error("workspace payload is not an object");
  }
  const candidate = input as Partial<PersistedWorkspace> & { version?: number };
  const version = candidate.schemaVersion ?? candidate.version;
  if (version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`unsupported workspace schema version ${String(version)}`);
  }
  if (!Array.isArray(candidate.diagrams) || candidate.diagrams.length === 0) {
    throw new Error("workspace has no diagrams");
  }

  const diagrams = candidate.diagrams.map((diagram, index) =>
    normalizeDiagramRecord(diagram, index),
  );
  const currentDiagramId = diagrams.some((diagram) => diagram.id === candidate.currentDiagramId)
    ? String(candidate.currentDiagramId)
    : diagrams[0].id;
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    currentDiagramId,
    diagrams,
  };
}

export function updateWorkspaceDiagram(
  workspace: PersistedWorkspace,
  diagramId: string,
  model: DiagramModel,
  now = new Date(),
): PersistedWorkspace {
  const code = exportMermaid(model);
  let changed = false;
  const diagrams = workspace.diagrams.map((diagram) => {
    if (diagram.id !== diagramId) {
      return diagram;
    }
    if (diagram.code === code && diagram.kind === model.kind) {
      return diagram;
    }
    changed = true;
    return {
      ...diagram,
      kind: model.kind,
      model,
      code,
      updatedAt: now.toISOString(),
    };
  });
  return changed ? { ...workspace, diagrams } : workspace;
}

export function defaultDiagramName(kind: DiagramKind): string {
  const label =
    kind === "sequenceDiagram"
      ? "Sequence"
      : kind === "classDiagram"
        ? "Class"
        : kind === "stateDiagram"
          ? "State"
          : kind === "erDiagram"
            ? "ER"
            : kind;
  return `${label} diagram`;
}

function normalizeDiagramRecord(input: unknown, index: number): PersistedDiagram {
  if (!input || typeof input !== "object") {
    throw new Error(`diagram ${index + 1} is not an object`);
  }
  const raw = input as Partial<Omit<PersistedDiagram, "kind">> & {
    kind?: string;
  };
  const code =
    typeof raw.code === "string" && raw.code.trim()
      ? raw.code
      : raw.model
        ? exportMermaid(raw.model)
        : "";
  const model = raw.model && typeof raw.model === "object" ? raw.model : parseMermaidInput(code);
  const rawKind = typeof raw.kind === "string" ? raw.kind : "";
  const kind =
    rawKind && rawKind !== "unknown"
      ? (rawKind as Exclude<DiagramKind, "unknown">)
      : detectDiagramKind(code);
  if (kind === "unknown") {
    throw new Error(`diagram ${index + 1} has an unknown Mermaid kind`);
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : createDiagramId(),
    name:
      typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : defaultDiagramName(kind),
    kind,
    createdAt: validDateOrNow(raw.createdAt),
    updatedAt: validDateOrNow(raw.updatedAt),
    code: code || exportMermaid(model),
    model,
  };
}

function validDateOrNow(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return new Date().toISOString();
}

function createDiagramId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `diagram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
