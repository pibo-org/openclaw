import {
  BookOpen,
  Circle,
  Copy,
  Diamond,
  Download,
  FileUp,
  Link2,
  MousePointer2,
  Plus,
  Redo2,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DIAGRAM_REGISTRY,
  createStarterModel,
  exportMermaid,
  getDiagramDefinition,
  normalizeMermaidInput,
  parseMermaidInput,
} from "./domain/mermaidAdapter";
import type {
  ClassMember,
  ClassModel,
  ClassRelation,
  DiagramKind,
  DiagramModel,
  ErAttribute,
  ErModel,
  ErRelationship,
  FlowEdge,
  FlowGroup,
  FlowNode,
  FlowchartModel,
  GenericDiagramModel,
  NodeShape,
  SequenceActivation,
  SequenceBlock,
  SequenceMessage,
  SequenceModel,
  SequenceNote,
  StateModel,
} from "./domain/mermaidAdapter";
import {
  createDiagramRecord,
  defaultDiagramName,
  loadWorkspace,
  saveWorkspace,
  updateWorkspaceDiagram,
} from "./domain/workspaceStorage";
import type { PersistedDiagram, PersistedWorkspace } from "./domain/workspaceStorage";
import { getMermaid } from "./mermaidRuntime";

type Selection =
  | { type: "flow-node"; id: string }
  | { type: "flow-edge"; id: string }
  | { type: "flow-group"; id: string }
  | { type: "sequence-participant"; id: string }
  | { type: "sequence-message"; id: string }
  | { type: "sequence-note"; id: string }
  | { type: "sequence-block"; id: string }
  | { type: "sequence-activation"; id: string }
  | { type: "class-node"; id: string }
  | { type: "class-relation"; id: string }
  | { type: "state-node"; id: string }
  | { type: "state-transition"; id: string }
  | { type: "er-entity"; id: string }
  | { type: "er-relationship"; id: string }
  | { type: "generic-entry"; id: string }
  | null;

type ToolMode = "select" | "connect";
type HistoryState = {
  past: DiagramModel[];
  present: DiagramModel;
  future: DiagramModel[];
};

const NODE_WIDTH = 132;
const NODE_HEIGHT = 58;

const SHAPES: Array<{
  shape: NodeShape;
  label: string;
  icon: React.ReactNode;
}> = [
  { shape: "rectangle", label: "Rectangle", icon: <Square size={18} /> },
  { shape: "rounded", label: "Rounded", icon: <Plus size={18} /> },
  { shape: "stadium", label: "Stadium", icon: <Plus size={18} /> },
  { shape: "subroutine", label: "Subroutine", icon: <Square size={18} /> },
  { shape: "cylinder", label: "Cylinder", icon: <Circle size={18} /> },
  { shape: "circle", label: "Circle", icon: <Circle size={18} /> },
  {
    shape: "double-circle",
    label: "Double circle",
    icon: <Circle size={18} />,
  },
  { shape: "diamond", label: "Diamond", icon: <Diamond size={18} /> },
  { shape: "hexagon", label: "Hexagon", icon: <Diamond size={18} /> },
  {
    shape: "parallelogram",
    label: "Parallelogram",
    icon: <Square size={18} />,
  },
  { shape: "trapezoid", label: "Trapezoid", icon: <Square size={18} /> },
  { shape: "asymmetric", label: "Asymmetric", icon: <Square size={18} /> },
  { shape: "docs", label: "Docs", icon: <Square size={18} /> },
  { shape: "lin-docs", label: "Lined docs", icon: <Square size={18} /> },
];

export default function App() {
  const initialLoad = useMemo(() => loadWorkspace(), []);
  const [workspace, setWorkspace] = useState(initialLoad.workspace);
  const initialDiagram =
    initialLoad.workspace.diagrams.find(
      (diagram) => diagram.id === initialLoad.workspace.currentDiagramId,
    ) ?? initialLoad.workspace.diagrams[0];
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: structuredClone(initialDiagram.model),
    future: [],
  });
  const [codeInput, setCodeInput] = useState(() => exportMermaid(initialDiagram.model));
  const [selection, setSelection] = useState<Selection>(null);
  const [mode, setMode] = useState<ToolMode>("select");
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [recoveryMessage] = useState(initialLoad.recoveryMessage);
  const [storageError, setStorageError] = useState("");
  const [status, setStatus] = useState(initialLoad.recoveryMessage || "Ready");
  const [dragging, setDragging] = useState<{
    id: string;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const model = history.present;
  const exportedCode = useMemo(() => exportMermaid(model), [model]);
  const dirtyCode = codeInput !== exportedCode;
  const definition = getDiagramDefinition(model.kind);
  const preserved = model.preserved;
  const currentDiagram =
    workspace.diagrams.find((diagram) => diagram.id === workspace.currentDiagramId) ??
    workspace.diagrams[0];

  useEffect(() => {
    setCodeInput(exportedCode);
  }, [exportedCode]);

  useEffect(() => {
    setWorkspace((current) => {
      const next = updateWorkspaceDiagram(current, current.currentDiagramId, model);
      if (next === current) {
        return current;
      }
      const error = saveWorkspace(next);
      setStorageError(error);
      return next;
    });
  }, [exportedCode, model]);

  const persistWorkspace = useCallback(
    (updater: (current: PersistedWorkspace) => PersistedWorkspace) => {
      setWorkspace((current) => {
        const next = updater(current);
        const error = saveWorkspace(next);
        setStorageError(error);
        return next;
      });
    },
    [],
  );

  const commitModel = useCallback((nextModel: DiagramModel, message = "Updated diagram") => {
    setHistory((current) => ({
      past: [...current.past, current.present],
      present: nextModel,
      future: [],
    }));
    setStatus(message);
  }, []);

  const mutateModel = useCallback(
    (updater: (draft: DiagramModel) => void, message?: string) => {
      const draft = structuredClone(model);
      updater(draft);
      commitModel(draft, message);
    },
    [commitModel, model],
  );

  const replaceFromCode = async (
    input: string,
    message: string,
    asNewDiagram = false,
    importedName?: string,
  ) => {
    setImportError("");
    setPreviewError("");
    try {
      const normalized = normalizeMermaidInput(input);
      const mermaid = await getMermaid();
      await mermaid.parse(normalized);
      const nextModel = parseMermaidInput(normalized);
      if (asNewDiagram) {
        const diagram = createDiagramRecord(
          nextModel,
          importedName?.trim() || defaultDiagramName(nextModel.kind),
        );
        persistWorkspace((current) => ({
          ...current,
          currentDiagramId: diagram.id,
          diagrams: [...current.diagrams, diagram],
        }));
        setHistory({
          past: [],
          present: structuredClone(nextModel),
          future: [],
        });
        setStatus(message);
      } else {
        commitModel(nextModel, message);
      }
      setSelection(null);
      setMode("select");
      setConnectSource(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
      setStatus("Import failed");
    }
  };

  const undo = () => {
    setHistory((current) => {
      if (current.past.length === 0) {
        return current;
      }
      const previous = current.past[current.past.length - 1];
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
    setSelection(null);
    setStatus("Undid last change");
  };

  const redo = () => {
    setHistory((current) => {
      if (current.future.length === 0) {
        return current;
      }
      const next = current.future[0];
      return {
        past: [...current.past, current.present],
        present: next,
        future: current.future.slice(1),
      };
    });
    setSelection(null);
    setStatus("Redid change");
  };

  const newDiagram = (kind: Exclude<DiagramKind, "unknown">) => {
    const nextModel = createStarterModel(kind);
    const diagram = createDiagramRecord(nextModel, defaultDiagramName(kind));
    persistWorkspace((current) => ({
      ...current,
      currentDiagramId: diagram.id,
      diagrams: [...current.diagrams, diagram],
    }));
    setHistory({
      past: [],
      present: structuredClone(nextModel),
      future: [],
    });
    setStatus(`Created ${getDiagramDefinition(kind)?.label ?? kind}`);
    setSelection(null);
    setImportError("");
  };

  const selectDiagram = (diagramId: string) => {
    const diagram = workspace.diagrams.find((item) => item.id === diagramId);
    if (!diagram) {
      return;
    }
    persistWorkspace((current) => ({ ...current, currentDiagramId: diagramId }));
    setHistory({
      past: [],
      present: structuredClone(diagram.model),
      future: [],
    });
    setSelection(null);
    setMode("select");
    setConnectSource(null);
    setImportError("");
    setStatus(`Opened ${diagram.name}`);
  };

  const renameDiagram = (diagramId: string, name: string) => {
    persistWorkspace((current) => ({
      ...current,
      diagrams: current.diagrams.map((diagram) =>
        diagram.id === diagramId
          ? { ...diagram, name, updatedAt: new Date().toISOString() }
          : diagram,
      ),
    }));
  };

  const duplicateDiagram = (diagramId: string) => {
    const source = workspace.diagrams.find((diagram) => diagram.id === diagramId);
    if (!source) {
      return;
    }
    const copy = createDiagramRecord(structuredClone(source.model), `${source.name} copy`);
    persistWorkspace((current) => ({
      ...current,
      currentDiagramId: copy.id,
      diagrams: [...current.diagrams, copy],
    }));
    setHistory({
      past: [],
      present: structuredClone(copy.model),
      future: [],
    });
    setSelection(null);
    setStatus(`Duplicated ${source.name}`);
  };

  const deleteDiagram = (diagramId: string) => {
    const target = workspace.diagrams.find((diagram) => diagram.id === diagramId);
    if (!target) {
      return;
    }
    if (!window.confirm(`Delete "${target.name}" from this browser workspace?`)) {
      return;
    }
    const remaining = workspace.diagrams.filter((diagram) => diagram.id !== diagramId);
    const nextDiagrams = remaining.length
      ? remaining
      : [createDiagramRecord(createStarterModel("flowchart"), "Starter Flowchart")];
    const nextCurrent = workspace.currentDiagramId === diagramId ? nextDiagrams[0] : currentDiagram;
    persistWorkspace(() => ({
      ...workspace,
      currentDiagramId: nextCurrent.id,
      diagrams: nextDiagrams,
    }));
    if (workspace.currentDiagramId === diagramId) {
      setHistory({
        past: [],
        present: structuredClone(nextCurrent.model),
        future: [],
      });
      setSelection(null);
    }
    setStatus(`Deleted ${target.name}`);
  };

  const addFlowNode = (shape: NodeShape, x = 180, y = 160) => {
    if (model.type !== "flowchart") {
      return;
    }
    const nextNumber = model.nodes.length + 1;
    const id = uniqueId(
      `N${nextNumber}`,
      model.nodes.map((node) => node.id),
    );
    mutateModel((draft) => {
      if (draft.type !== "flowchart") {
        return;
      }
      draft.nodes.push({ id, label: `Node ${nextNumber}`, shape, x, y });
    }, "Added flowchart node");
    setSelection({ type: "flow-node", id });
  };

  const addFlowEdge = (source: string, target: string) => {
    if (source === target) {
      return;
    }
    mutateModel((draft) => {
      if (draft.type !== "flowchart") {
        return;
      }
      draft.edges.push({
        id: `edge-${Date.now()}`,
        source,
        target,
        label: "",
        arrow: "-->",
      });
    }, "Added flowchart edge");
  };

  const addFlowGroup = () => {
    if (model.type !== "flowchart") {
      return;
    }
    const id = `group-${Date.now()}`;
    mutateModel((draft) => {
      if (draft.type !== "flowchart") {
        return;
      }
      draft.groups.push({
        id,
        title: `Group ${draft.groups.length + 1}`,
        nodeIds: draft.nodes.slice(0, 1).map((node) => node.id),
        x: 54,
        y: 54,
      });
    }, "Added flowchart group");
    setSelection({ type: "flow-group", id });
  };

  const duplicateSelection = () => {
    if (!selection) {
      return;
    }
    mutateModel((draft) => {
      if (selection.type === "flow-node" && draft.type === "flowchart") {
        const node = draft.nodes.find((item) => item.id === selection.id);
        if (node) {
          draft.nodes.push({
            ...node,
            id: uniqueId(
              `${node.id}_copy`,
              draft.nodes.map((item) => item.id),
            ),
            x: node.x + 32,
            y: node.y + 32,
          });
        }
      }
      if (selection.type === "generic-entry" && draft.type === "generic") {
        const entry = draft.entries.find((item) => item.id === selection.id);
        if (entry) {
          draft.entries.push({ ...entry, id: `entry-${Date.now()}` });
        }
      }
    }, "Duplicated selection");
  };

  const deleteSelection = () => {
    if (!selection) {
      return;
    }
    mutateModel((draft) => {
      if (draft.type === "flowchart") {
        if (selection.type === "flow-node") {
          draft.nodes = draft.nodes.filter((node) => node.id !== selection.id);
          draft.edges = draft.edges.filter(
            (edge) => edge.source !== selection.id && edge.target !== selection.id,
          );
          draft.groups.forEach((group) => {
            group.nodeIds = group.nodeIds.filter((id) => id !== selection.id);
          });
        }
        if (selection.type === "flow-edge") {
          draft.edges = draft.edges.filter((edge) => edge.id !== selection.id);
        }
        if (selection.type === "flow-group") {
          draft.groups = draft.groups.filter((group) => group.id !== selection.id);
        }
      }
      if (draft.type === "sequence") {
        if (selection.type === "sequence-participant") {
          draft.participants = draft.participants.filter(
            (participant) => participant.id !== selection.id,
          );
        }
        if (selection.type === "sequence-message") {
          draft.messages = draft.messages.filter((message) => message.id !== selection.id);
        }
        if (selection.type === "sequence-note") {
          draft.notes = draft.notes.filter((note) => note.id !== selection.id);
        }
        if (selection.type === "sequence-block") {
          draft.blocks = draft.blocks.filter((block) => block.id !== selection.id);
        }
        if (selection.type === "sequence-activation") {
          draft.activations = draft.activations.filter(
            (activation) => activation.id !== selection.id,
          );
        }
        if (selection.type.startsWith("sequence-")) {
          draft.steps = draft.steps.filter((step) => step.id !== selection.id);
        }
      }
      if (draft.type === "class") {
        if (selection.type === "class-node") {
          draft.classes = draft.classes.filter((classNode) => classNode.id !== selection.id);
        }
        if (selection.type === "class-relation") {
          draft.relations = draft.relations.filter((relation) => relation.id !== selection.id);
        }
      }
      if (draft.type === "state") {
        if (selection.type === "state-node") {
          draft.states = draft.states.filter((state) => state.id !== selection.id);
        }
        if (selection.type === "state-transition") {
          draft.transitions = draft.transitions.filter(
            (transition) => transition.id !== selection.id,
          );
        }
      }
      if (draft.type === "er") {
        if (selection.type === "er-entity") {
          draft.entities = draft.entities.filter((entity) => entity.id !== selection.id);
        }
        if (selection.type === "er-relationship") {
          draft.relationships = draft.relationships.filter(
            (relationship) => relationship.id !== selection.id,
          );
        }
      }
      if (draft.type === "generic" && selection.type === "generic-entry") {
        draft.entries = draft.entries.filter((entry) => entry.id !== selection.id);
      }
    }, "Deleted selection");
    setSelection(null);
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(exportedCode);
    setStatus("Copied Mermaid code");
  };

  const importFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    const text = await file.text();
    setCodeInput(text);
    await replaceFromCode(
      text,
      `Imported ${file.name} as a new saved diagram`,
      true,
      diagramNameFromFile(file.name),
    );
  };

  const selectFlowNode = (nodeId: string) => {
    setSelection({ type: "flow-node", id: nodeId });
  };

  const handleNodePointerDown = (event: React.PointerEvent, node: FlowNode) => {
    event.stopPropagation();
    if (mode === "connect") {
      if (!connectSource) {
        setConnectSource(node.id);
        setSelection({ type: "flow-node", id: node.id });
      } else {
        addFlowEdge(connectSource, node.id);
        setSelection(null);
        setConnectSource(null);
        setMode("select");
      }
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setSelection({ type: "flow-node", id: node.id });
    setDragging({
      id: node.id,
      offsetX: event.clientX - rect.left - node.x,
      offsetY: event.clientY - rect.top - node.y,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !canvasRef.current || model.type !== "flowchart") {
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(
      8,
      Math.min(event.clientX - rect.left - dragging.offsetX, rect.width - NODE_WIDTH - 8),
    );
    const y = Math.max(
      8,
      Math.min(event.clientY - rect.top - dragging.offsetY, rect.height - NODE_HEIGHT - 8),
    );
    setHistory((current) => {
      if (current.present.type !== "flowchart") {
        return current;
      }
      const next = structuredClone(current.present);
      const node = next.nodes.find((item) => item.id === dragging.id);
      if (!node) {
        return current;
      }
      node.x = Math.round(x);
      node.y = Math.round(y);
      return { ...current, present: next };
    });
  };

  const commitDrag = () => {
    if (dragging) {
      setStatus("Moved node");
    }
    setDragging(null);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const shape = event.dataTransfer.getData("application/x-node-shape");
    if (!shape || model.type !== "flowchart" || !canvasRef.current) {
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    addFlowNode(
      shape as NodeShape,
      event.clientX - rect.left - NODE_WIDTH / 2,
      event.clientY - rect.top - NODE_HEIGHT / 2,
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Mermaid Editor</h1>
          <p>
            {currentDiagram.name} - {definition?.label ?? model.kind} -{" "}
            {dirtyCode ? "code edits pending apply" : recoveryMessage || storageError || status}
          </p>
        </div>
        <div className="topbar-actions">
          <select
            aria-label="New diagram type"
            value={model.kind}
            onChange={(event) => newDiagram(event.target.value as Exclude<DiagramKind, "unknown">)}
          >
            {DIAGRAM_REGISTRY.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
          <button onClick={undo} disabled={history.past.length === 0} title="Undo">
            <Undo2 size={17} />
          </button>
          <button onClick={redo} disabled={history.future.length === 0} title="Redo">
            <Redo2 size={17} />
          </button>
          <button
            className="primary"
            onClick={() => replaceFromCode(codeInput, "Imported Mermaid code")}
          >
            Apply code
          </button>
          <button
            onClick={() =>
              replaceFromCode(codeInput, "Imported Mermaid code as a new saved diagram", true)
            }
          >
            Import as new
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="palette">
          <section className="library-section">
            <div className="panel-heading">
              <h2>
                <BookOpen size={15} /> Library
              </h2>
              <span className="status-pill">{workspace.diagrams.length}</span>
            </div>
            <div className="diagram-list">
              {workspace.diagrams.map((diagram) => (
                <DiagramLibraryItem
                  key={diagram.id}
                  diagram={diagram}
                  active={diagram.id === workspace.currentDiagramId}
                  onSelect={selectDiagram}
                  onRename={renameDiagram}
                  onDuplicate={duplicateDiagram}
                  onDelete={deleteDiagram}
                />
              ))}
            </div>
            {recoveryMessage && (
              <div className="error-box" role="alert">
                {recoveryMessage}
              </div>
            )}
            {storageError && <div className="error-box">{storageError}</div>}
          </section>
          <h2>Palette</h2>
          <button
            className={mode === "select" ? "tool active" : "tool"}
            onClick={() => setMode("select")}
          >
            <MousePointer2 size={18} /> Select
          </button>
          <button
            className={mode === "connect" ? "tool active" : "tool"}
            onClick={() => setMode("connect")}
            disabled={model.type !== "flowchart"}
          >
            <Link2 size={18} /> Connect
          </button>
          {model.type === "flowchart" && (
            <>
              <label className="compact-field">
                Direction
                <select
                  value={model.direction}
                  onChange={(event) =>
                    mutateModel((draft) => {
                      if (draft.type === "flowchart") {
                        draft.direction = event.target.value as FlowchartModel["direction"];
                      }
                    }, "Changed flowchart direction")
                  }
                >
                  <option value="TD">TD</option>
                  <option value="TB">TB</option>
                  <option value="BT">BT</option>
                  <option value="LR">LR</option>
                  <option value="RL">RL</option>
                </select>
              </label>
              <div className="palette-group shape-list">
                {SHAPES.map((shape) => (
                  <NodeTool
                    key={shape.shape}
                    icon={shape.icon}
                    label={shape.label}
                    shape={shape.shape}
                    onAdd={addFlowNode}
                  />
                ))}
              </div>
              <button className="tool" onClick={addFlowGroup}>
                <Plus size={18} /> Group
              </button>
            </>
          )}
          <h2>Examples</h2>
          <div className="gallery">
            {DIAGRAM_REGISTRY.map((entry) => (
              <button key={entry.kind} onClick={() => newDiagram(entry.kind)}>
                {entry.label}
              </button>
            ))}
          </div>
        </aside>

        <section
          className="canvas-panel"
          ref={canvasRef}
          onPointerMove={handleCanvasMove}
          onPointerUp={commitDrag}
          onPointerLeave={commitDrag}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          onPointerDown={() => setSelection(null)}
        >
          <DiagramCanvas
            model={model}
            selection={selection}
            connectSource={connectSource}
            mutateModel={mutateModel}
            setSelection={setSelection}
            onNodePointerDown={handleNodePointerDown}
            onNodeKeyboardSelect={selectFlowNode}
          />
        </section>

        <aside className="inspector">
          <div className="panel-heading">
            <h2>Inspector</h2>
            <div className="icon-row">
              <button
                title="Duplicate selection"
                onClick={duplicateSelection}
                disabled={!selection}
              >
                <Copy size={16} />
              </button>
              <button title="Delete selection" onClick={deleteSelection} disabled={!selection}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>
          <Inspector
            model={model}
            selection={selection}
            mutateModel={mutateModel}
            setSelection={setSelection}
          />
          <section className="preserved-panel">
            <h2>Preserved Syntax</h2>
            {preserved.length === 0 ? (
              <p className="empty-state">No preserved raw syntax for this diagram.</p>
            ) : (
              preserved.map((item) => (
                <div className="preserved-line" key={item.id}>
                  <span>{item.reason}</span>
                  <code>{item.line}</code>
                </div>
              ))
            )}
          </section>
        </aside>

        <section className="code-panel">
          <div className="panel-heading">
            <h2>Mermaid Code</h2>
            <div className="icon-row">
              <input
                ref={fileInputRef}
                className="hidden-file"
                type="file"
                accept=".mmd,.mermaid,.md,text/markdown,text/plain"
                onChange={(event) => importFile(event.target.files?.[0])}
              />
              <button title="Import file" onClick={() => fileInputRef.current?.click()}>
                <FileUp size={16} />
              </button>
              <button title="Copy Mermaid" onClick={copyCode}>
                <Copy size={16} />
              </button>
              <button title="Download .mmd" onClick={() => downloadMermaid(exportedCode)}>
                <Download size={16} />
              </button>
            </div>
          </div>
          <textarea
            aria-label="Mermaid code"
            value={codeInput}
            spellCheck={false}
            onChange={(event) => setCodeInput(event.target.value)}
          />
          {dirtyCode && (
            <div className="dirty-box">
              Code panel has unapplied edits. Use Apply code to re-import and update the structured
              editor.
            </div>
          )}
          {importError && <div className="error-box">{importError}</div>}
        </section>

        <section className="preview-panel">
          <div className="panel-heading">
            <h2>Preview</h2>
            <span className={previewError ? "status-pill danger" : "status-pill"}>
              {previewError ? "Preview error" : "Rendered"}
            </span>
          </div>
          <MermaidPreview code={exportedCode} onError={setPreviewError} />
          {previewError && <div className="error-box">{previewError}</div>}
        </section>
      </main>
    </div>
  );
}

function DiagramLibraryItem({
  diagram,
  active,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
}: {
  diagram: PersistedDiagram;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className={active ? "diagram-item active" : "diagram-item"}>
      <button className="diagram-open" onClick={() => onSelect(diagram.id)}>
        <strong>{diagram.name}</strong>
        <span>{getDiagramDefinition(diagram.kind)?.label ?? diagram.kind}</span>
      </button>
      <input
        aria-label={`Rename ${diagram.name}`}
        value={diagram.name}
        onChange={(event) => onRename(diagram.id, event.target.value)}
      />
      <div className="icon-row">
        <button title={`Duplicate ${diagram.name}`} onClick={() => onDuplicate(diagram.id)}>
          <Copy size={15} />
        </button>
        <button title={`Delete ${diagram.name}`} onClick={() => onDelete(diagram.id)}>
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

function NodeTool({
  icon,
  label,
  shape,
  onAdd,
}: {
  icon: React.ReactNode;
  label: string;
  shape: NodeShape;
  onAdd: (shape: NodeShape) => void;
}) {
  return (
    <button
      className="node-tool"
      draggable
      onClick={() => onAdd(shape)}
      onDragStart={(event) => event.dataTransfer.setData("application/x-node-shape", shape)}
    >
      {icon}
      {label}
    </button>
  );
}

function DiagramCanvas({
  model,
  selection,
  connectSource,
  mutateModel,
  setSelection,
  onNodePointerDown,
  onNodeKeyboardSelect,
}: {
  model: DiagramModel;
  selection: Selection;
  connectSource: string | null;
  mutateModel: (updater: (draft: DiagramModel) => void, message?: string) => void;
  setSelection: (selection: Selection) => void;
  onNodePointerDown: (event: React.PointerEvent, node: FlowNode) => void;
  onNodeKeyboardSelect: (nodeId: string) => void;
}) {
  if (model.type === "flowchart") {
    return (
      <FlowCanvas
        model={model}
        selection={selection}
        connectSource={connectSource}
        setSelection={setSelection}
        onNodePointerDown={onNodePointerDown}
        onNodeKeyboardSelect={onNodeKeyboardSelect}
      />
    );
  }
  if (model.type === "sequence") {
    return (
      <SequenceEditor
        model={model}
        mutateModel={mutateModel}
        setSelection={setSelection}
        selection={selection}
      />
    );
  }
  if (model.type === "class") {
    return (
      <ClassEditor
        model={model}
        mutateModel={mutateModel}
        setSelection={setSelection}
        selection={selection}
      />
    );
  }
  if (model.type === "state") {
    return (
      <StateEditor
        model={model}
        mutateModel={mutateModel}
        setSelection={setSelection}
        selection={selection}
      />
    );
  }
  if (model.type === "er") {
    return (
      <ErEditor
        model={model}
        mutateModel={mutateModel}
        setSelection={setSelection}
        selection={selection}
      />
    );
  }
  return (
    <GenericEditor
      model={model}
      mutateModel={mutateModel}
      setSelection={setSelection}
      selection={selection}
    />
  );
}

function FlowCanvas({
  model,
  selection,
  connectSource,
  setSelection,
  onNodePointerDown,
  onNodeKeyboardSelect,
}: {
  model: FlowchartModel;
  selection: Selection;
  connectSource: string | null;
  setSelection: (selection: Selection) => void;
  onNodePointerDown: (event: React.PointerEvent, node: FlowNode) => void;
  onNodeKeyboardSelect: (nodeId: string) => void;
}) {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  return (
    <>
      {model.groups.map((group) => (
        <FlowGroupBox
          key={group.id}
          group={group}
          nodes={model.nodes}
          selected={selection?.type === "flow-group" && selection.id === group.id}
          onSelect={() => setSelection({ type: "flow-group", id: group.id })}
        />
      ))}
      <svg className="edge-layer" aria-label="Flowchart connections">
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
          </marker>
        </defs>
        {model.edges.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) {
            return null;
          }
          const x1 = source.x + NODE_WIDTH / 2;
          const y1 = source.y + NODE_HEIGHT / 2;
          const x2 = target.x + NODE_WIDTH / 2;
          const y2 = target.y + NODE_HEIGHT / 2;
          return (
            <g
              key={edge.id}
              className={
                selection?.type === "flow-edge" && selection.id === edge.id
                  ? "edge selected"
                  : "edge"
              }
              onClick={(event) => {
                event.stopPropagation();
                setSelection({ type: "flow-edge", id: edge.id });
              }}
            >
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                markerEnd={edge.arrow === "---" ? undefined : "url(#arrowhead)"}
              />
              {edge.label && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {model.nodes.map((node) => (
        <div
          key={node.id}
          className={[
            "flow-node",
            node.shape,
            selection?.type === "flow-node" && selection.id === node.id ? "selected" : "",
            connectSource === node.id ? "connect-source" : "",
          ].join(" ")}
          style={{ left: node.x, top: node.y }}
          role="button"
          tabIndex={0}
          aria-label={`Select flowchart node ${node.id}: ${node.label}`}
          onPointerDown={(event) => onNodePointerDown(event, node)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onNodeKeyboardSelect(node.id);
            }
          }}
        >
          <span className="node-id">{node.id}</span>
          <span>{node.label}</span>
        </div>
      ))}
    </>
  );
}

function FlowGroupBox({
  group,
  nodes,
  selected,
  onSelect,
}: {
  group: FlowGroup;
  nodes: FlowNode[];
  selected: boolean;
  onSelect: () => void;
}) {
  const groupNodes = nodes.filter((node) => group.nodeIds.includes(node.id));
  const minX = Math.min(group.x, ...groupNodes.map((node) => node.x - 24));
  const minY = Math.min(group.y, ...groupNodes.map((node) => node.y - 38));
  const maxX = Math.max(group.x + 220, ...groupNodes.map((node) => node.x + NODE_WIDTH + 24));
  const maxY = Math.max(group.y + 150, ...groupNodes.map((node) => node.y + NODE_HEIGHT + 24));
  return (
    <button
      className={selected ? "flow-group selected" : "flow-group"}
      style={{ left: minX, top: minY, width: maxX - minX, height: maxY - minY }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {group.title}
    </button>
  );
}

function SequenceEditor({
  model,
  mutateModel,
  setSelection,
  selection,
}: StructuredProps<SequenceModel>) {
  const addParticipant = () =>
    mutateModel((draft) => {
      if (draft.type !== "sequence") {
        return;
      }
      const id = uniqueId(
        `Actor${draft.participants.length + 1}`,
        draft.participants.map((item) => item.id),
      );
      draft.participants.push({ id, alias: id, actor: false });
    }, "Added sequence participant");
  const addMessage = () =>
    mutateModel((draft) => {
      if (draft.type !== "sequence") {
        return;
      }
      const from = draft.participants[0]?.id ?? "Alice";
      const to = draft.participants[1]?.id ?? from;
      const id = `message-${Date.now()}`;
      draft.messages.push({
        id,
        from,
        to,
        arrow: "->>",
        label: "message",
        activateTarget: false,
        deactivateTarget: false,
      });
      draft.steps.push({ id, type: "message" });
    }, "Added sequence message");
  const addNote = () =>
    mutateModel((draft) => {
      if (draft.type !== "sequence") {
        return;
      }
      const participant = draft.participants[0]?.id ?? "Alice";
      const id = `note-${Date.now()}`;
      draft.notes.push({ id, placement: "over", participant, text: "note" });
      draft.steps.push({ id, type: "note" });
    }, "Added sequence note");
  const addBlock = () =>
    mutateModel((draft) => {
      if (draft.type !== "sequence") {
        return;
      }
      const timestamp = Date.now();
      const participant = draft.participants[0]?.id ?? "Alice";
      const openId = `block-${timestamp}`;
      const noteId = `note-${timestamp}`;
      const closeId = `block-${timestamp}-end`;
      draft.blocks.push({ id: openId, kind: "loop", label: "condition" });
      draft.notes.push({
        id: noteId,
        placement: "over",
        participant,
        text: "fragment body",
      });
      draft.blocks.push({ id: closeId, kind: "end", label: "" });
      draft.steps.push(
        { id: openId, type: "block" },
        { id: noteId, type: "note" },
        { id: closeId, type: "block" },
      );
    }, "Added sequence fragment");
  const addActivation = () =>
    mutateModel((draft) => {
      if (draft.type !== "sequence") {
        return;
      }
      const participant = draft.participants[0]?.id ?? "Alice";
      const id = `activation-${Date.now()}`;
      draft.activations.push({ id, participant, action: "activate" });
      draft.steps.push({ id, type: "activation" });
    }, "Added sequence activation");
  return (
    <div className="structured-editor sequence-board">
      <EditorToolbar
        title="Sequence editor"
        onAddPrimary={addParticipant}
        primaryLabel="Participant"
        onAddSecondary={addMessage}
        secondaryLabel="Message"
      />
      <div className="sequence-actions">
        <button onClick={addNote}>
          <Plus size={16} /> Note
        </button>
        <button onClick={addBlock}>
          <Plus size={16} /> Fragment
        </button>
        <button onClick={addActivation}>
          <Plus size={16} /> Activation
        </button>
      </div>
      <div className="participant-row">
        {model.participants.map((participant) => (
          <button
            key={participant.id}
            className={
              selection?.type === "sequence-participant" && selection.id === participant.id
                ? "participant selected"
                : "participant"
            }
            onClick={() => setSelection({ type: "sequence-participant", id: participant.id })}
          >
            <strong>{participant.alias}</strong>
            <span>{participant.actor ? "actor" : "participant"}</span>
          </button>
        ))}
      </div>
      <div className="message-list">
        {model.steps.map((step) => (
          <SequenceStepRow
            key={`${step.type}-${step.id}`}
            model={model}
            step={step}
            selection={selection}
            setSelection={setSelection}
          />
        ))}
      </div>
    </div>
  );
}

function SequenceStepRow({
  model,
  step,
  selection,
  setSelection,
}: {
  model: SequenceModel;
  step: SequenceModel["steps"][number];
  selection: Selection;
  setSelection: (selection: Selection) => void;
}) {
  if (step.type === "message") {
    const message = model.messages.find((item) => item.id === step.id);
    if (!message) {
      return null;
    }
    const activation = message.activateTarget ? "+" : message.deactivateTarget ? "-" : "";
    return (
      <button
        className={
          selection?.type === "sequence-message" && selection.id === message.id
            ? "message-row selected"
            : "message-row"
        }
        onClick={() => setSelection({ type: "sequence-message", id: message.id })}
      >
        <span>{message.from}</span>
        <span>
          {message.arrow}
          {activation}
        </span>
        <span>{message.to}</span>
        <strong>{message.label}</strong>
      </button>
    );
  }
  if (step.type === "note") {
    const note = model.notes.find((item) => item.id === step.id);
    if (!note) {
      return null;
    }
    return (
      <button
        className={
          selection?.type === "sequence-note" && selection.id === note.id
            ? "note-row selected"
            : "note-row"
        }
        onClick={() => setSelection({ type: "sequence-note", id: note.id })}
      >
        Note {note.placement} {note.participant}: {note.text}
      </button>
    );
  }
  if (step.type === "block") {
    const block = model.blocks.find((item) => item.id === step.id);
    if (!block) {
      return null;
    }
    return (
      <button
        className={
          selection?.type === "sequence-block" && selection.id === block.id
            ? "block-row selected"
            : "block-row"
        }
        onClick={() => setSelection({ type: "sequence-block", id: block.id })}
      >
        {block.kind} {block.label}
      </button>
    );
  }
  if (step.type === "activation") {
    const activation = model.activations.find((item) => item.id === step.id);
    if (!activation) {
      return null;
    }
    return (
      <button
        className={
          selection?.type === "sequence-activation" && selection.id === activation.id
            ? "block-row selected"
            : "block-row"
        }
        onClick={() => setSelection({ type: "sequence-activation", id: activation.id })}
      >
        {activation.action} {activation.participant}
      </button>
    );
  }
  const preserved = model.preserved.find((item) => item.id === step.id);
  return preserved ? (
    <div className="preserved-line">
      <span>{preserved.reason}</span>
      <code>{preserved.line}</code>
    </div>
  ) : null;
}

function ClassEditor({ model, mutateModel, setSelection, selection }: StructuredProps<ClassModel>) {
  return (
    <div className="structured-editor">
      <EditorToolbar
        title="Class editor"
        primaryLabel="Class"
        secondaryLabel="Relation"
        onAddPrimary={() =>
          mutateModel((draft) => {
            if (draft.type === "class") {
              draft.classes.push({
                id: `Class${Date.now()}`,
                name: `Class${draft.classes.length + 1}`,
                stereotype: "",
                members: [],
              });
            }
          }, "Added class")
        }
        onAddSecondary={() =>
          mutateModel((draft) => {
            if (draft.type === "class" && draft.classes.length >= 2) {
              draft.relations.push({
                id: `relation-${Date.now()}`,
                from: draft.classes[0].name,
                to: draft.classes[1].name,
                relation: "-->",
                fromCardinality: "",
                toCardinality: "",
                label: "uses",
              });
            }
          }, "Added class relation")
        }
      />
      <div className="card-grid">
        {model.classes.map((classNode) => (
          <button
            key={classNode.id}
            className={
              selection?.type === "class-node" && selection.id === classNode.id
                ? "class-card selected"
                : "class-card"
            }
            onClick={() => setSelection({ type: "class-node", id: classNode.id })}
          >
            <strong>{classNode.name}</strong>
            {classNode.stereotype && <span>&lt;&lt;{classNode.stereotype}&gt;&gt;</span>}
            {classNode.members.map((member) => (
              <code key={member.id}>
                {member.visibility}
                {member.name}
              </code>
            ))}
          </button>
        ))}
      </div>
      <RelationList
        relations={model.relations}
        selectedType="class-relation"
        selection={selection}
        setSelection={setSelection}
      />
    </div>
  );
}

function StateEditor({ model, mutateModel, setSelection, selection }: StructuredProps<StateModel>) {
  return (
    <div className="structured-editor">
      <EditorToolbar
        title="State editor"
        primaryLabel="State"
        secondaryLabel="Transition"
        onAddPrimary={() =>
          mutateModel((draft) => {
            if (draft.type === "state") {
              draft.states.push({
                id: `State${draft.states.length + 1}`,
                label: `State ${draft.states.length + 1}`,
                parentId: "",
              });
            }
          }, "Added state")
        }
        onAddSecondary={() =>
          mutateModel((draft) => {
            if (draft.type === "state") {
              draft.transitions.push({
                id: `transition-${Date.now()}`,
                from: draft.states[0]?.id ?? "[*]",
                to: draft.states[1]?.id ?? "[*]",
                label: "next",
              });
            }
          }, "Added transition")
        }
      />
      <div className="state-map">
        {model.states.map((state) => (
          <button
            key={state.id}
            className={
              selection?.type === "state-node" && selection.id === state.id
                ? "state-node selected"
                : "state-node"
            }
            onClick={() => setSelection({ type: "state-node", id: state.id })}
          >
            {state.label}
            <span>{state.id}</span>
          </button>
        ))}
      </div>
      <RelationList
        relations={model.transitions.map((transition) => ({
          id: transition.id,
          from: transition.from,
          to: transition.to,
          label: transition.label,
          relation: "-->",
        }))}
        selectedType="state-transition"
        selection={selection}
        setSelection={setSelection}
      />
    </div>
  );
}

function ErEditor({ model, mutateModel, setSelection, selection }: StructuredProps<ErModel>) {
  return (
    <div className="structured-editor">
      <EditorToolbar
        title="ER editor"
        primaryLabel="Entity"
        secondaryLabel="Relationship"
        onAddPrimary={() =>
          mutateModel((draft) => {
            if (draft.type === "er") {
              draft.entities.push({
                id: `ENTITY_${Date.now()}`,
                name: `ENTITY_${draft.entities.length + 1}`,
                attributes: [],
              });
            }
          }, "Added ER entity")
        }
        onAddSecondary={() =>
          mutateModel((draft) => {
            if (draft.type === "er" && draft.entities.length >= 2) {
              draft.relationships.push({
                id: `relationship-${Date.now()}`,
                from: draft.entities[0].name,
                to: draft.entities[1].name,
                cardinality: "||--o{",
                label: "relates",
              });
            }
          }, "Added ER relationship")
        }
      />
      <div className="card-grid">
        {model.entities.map((entity) => (
          <button
            key={entity.id}
            className={
              selection?.type === "er-entity" && selection.id === entity.id
                ? "class-card selected"
                : "class-card"
            }
            onClick={() => setSelection({ type: "er-entity", id: entity.id })}
          >
            <strong>{entity.name}</strong>
            {entity.attributes.map((attribute) => (
              <code key={attribute.id}>
                {attribute.type} {attribute.name} {attribute.key}
              </code>
            ))}
          </button>
        ))}
      </div>
      <RelationList
        relations={model.relationships.map((relationship) => ({
          id: relationship.id,
          from: relationship.from,
          to: relationship.to,
          label: relationship.label,
          relation: relationship.cardinality,
        }))}
        selectedType="er-relationship"
        selection={selection}
        setSelection={setSelection}
      />
    </div>
  );
}

function GenericEditor({
  model,
  mutateModel,
  setSelection,
  selection,
}: StructuredProps<GenericDiagramModel>) {
  return (
    <div className="structured-editor">
      <EditorToolbar
        title={`${getDiagramDefinition(model.kind)?.label ?? model.kind} line editor`}
        primaryLabel="Line"
        onAddPrimary={() =>
          mutateModel((draft) => {
            if (draft.type === "generic") {
              draft.entries.push({
                id: `entry-${Date.now()}`,
                text: "new entry",
              });
            }
          }, "Added Mermaid line")
        }
      />
      <p className="empty-state">{model.note}</p>
      <div className="generic-lines">
        {model.entries.map((entry) => (
          <button
            key={entry.id}
            className={
              selection?.type === "generic-entry" && selection.id === entry.id
                ? "generic-line selected"
                : "generic-line"
            }
            onClick={() => setSelection({ type: "generic-entry", id: entry.id })}
          >
            <code>{entry.text}</code>
          </button>
        ))}
      </div>
    </div>
  );
}

type StructuredProps<T extends DiagramModel> = {
  model: T;
  mutateModel: (updater: (draft: DiagramModel) => void, message?: string) => void;
  setSelection: (selection: Selection) => void;
  selection: Selection;
};

function EditorToolbar({
  title,
  primaryLabel,
  secondaryLabel,
  onAddPrimary,
  onAddSecondary,
}: {
  title: string;
  primaryLabel: string;
  secondaryLabel?: string;
  onAddPrimary: () => void;
  onAddSecondary?: () => void;
}) {
  return (
    <div className="editor-toolbar">
      <h2>{title}</h2>
      <div className="icon-row">
        <button onClick={onAddPrimary}>
          <Plus size={16} /> {primaryLabel}
        </button>
        {secondaryLabel && onAddSecondary && (
          <button onClick={onAddSecondary}>
            <Plus size={16} /> {secondaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function RelationList({
  relations,
  selectedType,
  selection,
  setSelection,
}: {
  relations: Array<{
    id: string;
    from: string;
    to: string;
    relation: string;
    label: string;
  }>;
  selectedType: "class-relation" | "state-transition" | "er-relationship";
  selection: Selection;
  setSelection: (selection: Selection) => void;
}) {
  return (
    <div className="relation-list">
      {relations.map((relation) => (
        <button
          key={relation.id}
          className={
            selection?.type === selectedType && selection.id === relation.id
              ? "relation-row selected"
              : "relation-row"
          }
          onClick={() => setSelection({ type: selectedType, id: relation.id } as Selection)}
        >
          {relation.from} <span>{relation.relation}</span> {relation.to}{" "}
          {relation.label && <strong>{relation.label}</strong>}
        </button>
      ))}
    </div>
  );
}

function Inspector({
  model,
  selection,
  mutateModel,
  setSelection,
}: {
  model: DiagramModel;
  selection: Selection;
  mutateModel: (updater: (draft: DiagramModel) => void, message?: string) => void;
  setSelection: (selection: Selection) => void;
}) {
  if (!selection) {
    return (
      <p className="empty-state">Select an element to edit its structured Mermaid properties.</p>
    );
  }

  if (model.type === "flowchart") {
    const node =
      selection.type === "flow-node"
        ? model.nodes.find((item) => item.id === selection.id)
        : undefined;
    const edge =
      selection.type === "flow-edge"
        ? model.edges.find((item) => item.id === selection.id)
        : undefined;
    const group =
      selection.type === "flow-group"
        ? model.groups.find((item) => item.id === selection.id)
        : undefined;
    if (node) {
      return (
        <FlowNodeInspector
          node={node}
          model={model}
          mutateModel={mutateModel}
          setSelection={setSelection}
        />
      );
    }
    if (edge) {
      return <FlowEdgeInspector edge={edge} model={model} mutateModel={mutateModel} />;
    }
    if (group) {
      return <FlowGroupInspector group={group} model={model} mutateModel={mutateModel} />;
    }
  }

  if (model.type === "sequence") {
    return <SequenceInspector model={model} selection={selection} mutateModel={mutateModel} />;
  }
  if (model.type === "class") {
    return <ClassInspector model={model} selection={selection} mutateModel={mutateModel} />;
  }
  if (model.type === "state") {
    return <StateInspector model={model} selection={selection} mutateModel={mutateModel} />;
  }
  if (model.type === "er") {
    return <ErInspector model={model} selection={selection} mutateModel={mutateModel} />;
  }
  if (model.type === "generic" && selection.type === "generic-entry") {
    const entry = model.entries.find((item) => item.id === selection.id);
    if (!entry) {
      return null;
    }
    return (
      <div className="form-stack">
        <label>
          Mermaid line
          <textarea
            value={entry.text}
            onChange={(event) =>
              mutateModel((draft) => {
                if (draft.type === "generic") {
                  draft.entries.find((item) => item.id === entry.id)!.text = event.target.value;
                }
              }, "Edited line")
            }
          />
        </label>
      </div>
    );
  }
  return <p className="empty-state">No inspector fields for this selection.</p>;
}

function FlowNodeInspector({
  node,
  model,
  mutateModel,
  setSelection,
}: {
  node: FlowNode;
  model: FlowchartModel;
  mutateModel: (updater: (draft: DiagramModel) => void, message?: string) => void;
  setSelection: (selection: Selection) => void;
}) {
  const update = (patch: Partial<FlowNode>) =>
    mutateModel((draft) => {
      if (draft.type !== "flowchart") {
        return;
      }
      const target = draft.nodes.find((item) => item.id === node.id);
      if (!target) {
        return;
      }
      const oldId = target.id;
      Object.assign(target, patch);
      if (patch.id && patch.id !== oldId) {
        target.id = uniqueId(
          patch.id.replace(/[^A-Za-z0-9_-]/g, "_"),
          draft.nodes.filter((item) => item !== target).map((item) => item.id),
        );
        draft.edges.forEach((edge) => {
          if (edge.source === oldId) {
            edge.source = target.id;
          }
          if (edge.target === oldId) {
            edge.target = target.id;
          }
        });
        draft.groups.forEach((group) => {
          group.nodeIds = group.nodeIds.map((id) => (id === oldId ? target.id : id));
        });
        setSelection({ type: "flow-node", id: target.id });
      }
    }, "Edited flowchart node");
  return (
    <div className="form-stack">
      <label>
        ID
        <input value={node.id} onChange={(event) => update({ id: event.target.value.trim() })} />
      </label>
      <label>
        Label
        <input value={node.label} onChange={(event) => update({ label: event.target.value })} />
      </label>
      <label>
        Shape
        <select
          value={node.shape}
          onChange={(event) => update({ shape: event.target.value as NodeShape })}
        >
          {SHAPES.map((shape) => (
            <option key={shape.shape} value={shape.shape}>
              {shape.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Group
        <select
          value={model.groups.find((group) => group.nodeIds.includes(node.id))?.id ?? ""}
          onChange={(event) =>
            mutateModel((draft) => {
              if (draft.type !== "flowchart") {
                return;
              }
              draft.groups.forEach((group) => {
                group.nodeIds = group.nodeIds.filter((id) => id !== node.id);
                if (group.id === event.target.value) {
                  group.nodeIds.push(node.id);
                }
              });
            }, "Changed node group")
          }
        >
          <option value="">None</option>
          {model.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.title}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        <label>
          X
          <input
            type="number"
            value={node.x}
            onChange={(event) => update({ x: Number(event.target.value) })}
          />
        </label>
        <label>
          Y
          <input
            type="number"
            value={node.y}
            onChange={(event) => update({ y: Number(event.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}

function FlowEdgeInspector({
  edge,
  model,
  mutateModel,
}: {
  edge: FlowEdge;
  model: FlowchartModel;
  mutateModel: (updater: (draft: DiagramModel) => void, message?: string) => void;
}) {
  const update = (patch: Partial<FlowEdge>) =>
    mutateModel((draft) => {
      if (draft.type === "flowchart") {
        Object.assign(draft.edges.find((item) => item.id === edge.id)!, patch);
      }
    }, "Edited flowchart edge");
  return (
    <div className="form-stack">
      <label>
        Source
        <select value={edge.source} onChange={(event) => update({ source: event.target.value })}>
          {model.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target
        <select value={edge.target} onChange={(event) => update({ target: event.target.value })}>
          {model.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Label
        <input value={edge.label} onChange={(event) => update({ label: event.target.value })} />
      </label>
      <label>
        Arrow
        <select
          value={edge.arrow}
          onChange={(event) => update({ arrow: event.target.value as FlowEdge["arrow"] })}
        >
          {["-->", "---", "-.->", "==>", "--o", "--x", "<-->", "o--o", "x--x"].map((arrow) => (
            <option key={arrow} value={arrow}>
              {arrow}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function FlowGroupInspector({
  group,
  model,
  mutateModel,
}: {
  group: FlowGroup;
  model: FlowchartModel;
  mutateModel: (updater: (draft: DiagramModel) => void, message?: string) => void;
}) {
  return (
    <div className="form-stack">
      <label>
        Title
        <input
          value={group.title}
          onChange={(event) =>
            mutateModel((draft) => {
              if (draft.type === "flowchart") {
                draft.groups.find((item) => item.id === group.id)!.title = event.target.value;
              }
            }, "Edited group")
          }
        />
      </label>
      <label>
        Nodes
        <select
          multiple
          value={group.nodeIds}
          onChange={(event) =>
            mutateModel((draft) => {
              if (draft.type === "flowchart") {
                draft.groups.find((item) => item.id === group.id)!.nodeIds = Array.from(
                  event.target.selectedOptions,
                ).map((option) => option.value);
              }
            }, "Edited group nodes")
          }
        >
          {model.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function SequenceInspector({ model, selection, mutateModel }: InspectorProps<SequenceModel>) {
  const participant =
    selection?.type === "sequence-participant"
      ? model.participants.find((item) => item.id === selection.id)
      : undefined;
  const message =
    selection?.type === "sequence-message"
      ? model.messages.find((item) => item.id === selection.id)
      : undefined;
  const note =
    selection?.type === "sequence-note"
      ? model.notes.find((item) => item.id === selection.id)
      : undefined;
  const block =
    selection?.type === "sequence-block"
      ? model.blocks.find((item) => item.id === selection.id)
      : undefined;
  const activation =
    selection?.type === "sequence-activation"
      ? model.activations.find((item) => item.id === selection.id)
      : undefined;
  if (participant) {
    return (
      <div className="form-stack">
        <label>
          ID
          <input
            value={participant.id}
            onChange={(event) =>
              updateSequenceParticipant(mutateModel, participant.id, {
                id: event.target.value,
              })
            }
          />
        </label>
        <label>
          Alias
          <input
            value={participant.alias}
            onChange={(event) =>
              updateSequenceParticipant(mutateModel, participant.id, {
                alias: event.target.value,
              })
            }
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={participant.actor}
            onChange={(event) =>
              updateSequenceParticipant(mutateModel, participant.id, {
                actor: event.target.checked,
              })
            }
          />{" "}
          Actor
        </label>
      </div>
    );
  }
  if (message) {
    return (
      <div className="form-stack">
        <label>
          From
          <select
            value={message.from}
            onChange={(event) =>
              updateSequenceMessage(mutateModel, message.id, {
                from: event.target.value,
              })
            }
          >
            {model.participants.map((participantItem) => (
              <option key={participantItem.id} value={participantItem.id}>
                {participantItem.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <select
            value={message.to}
            onChange={(event) =>
              updateSequenceMessage(mutateModel, message.id, {
                to: event.target.value,
              })
            }
          >
            {model.participants.map((participantItem) => (
              <option key={participantItem.id} value={participantItem.id}>
                {participantItem.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Arrow
          <select
            value={message.arrow}
            onChange={(event) =>
              updateSequenceMessage(mutateModel, message.id, {
                arrow: event.target.value as SequenceMessage["arrow"],
              })
            }
          >
            {["->>", "-->>", "-)", "--)", "->", "-->"].map((arrow) => (
              <option key={arrow} value={arrow}>
                {arrow}
              </option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input
            value={message.label}
            onChange={(event) =>
              updateSequenceMessage(mutateModel, message.id, {
                label: event.target.value,
              })
            }
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={message.activateTarget}
            onChange={(event) =>
              updateSequenceMessage(mutateModel, message.id, {
                activateTarget: event.target.checked,
                deactivateTarget: event.target.checked ? false : message.deactivateTarget,
              })
            }
          />{" "}
          Activate target
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={message.deactivateTarget}
            onChange={(event) =>
              updateSequenceMessage(mutateModel, message.id, {
                deactivateTarget: event.target.checked,
                activateTarget: event.target.checked ? false : message.activateTarget,
              })
            }
          />{" "}
          Deactivate target
        </label>
      </div>
    );
  }
  if (note) {
    return (
      <div className="form-stack">
        <label>
          Placement
          <select
            value={note.placement}
            onChange={(event) =>
              updateSequenceNote(mutateModel, note.id, {
                placement: event.target.value as SequenceNote["placement"],
              })
            }
          >
            {["left of", "right of", "over"].map((placement) => (
              <option key={placement}>{placement}</option>
            ))}
          </select>
        </label>
        <label>
          Participant
          <input
            value={note.participant}
            onChange={(event) =>
              updateSequenceNote(mutateModel, note.id, {
                participant: event.target.value,
              })
            }
          />
        </label>
        <label>
          Text
          <input
            value={note.text}
            onChange={(event) =>
              updateSequenceNote(mutateModel, note.id, {
                text: event.target.value,
              })
            }
          />
        </label>
      </div>
    );
  }
  if (block) {
    return (
      <div className="form-stack">
        <label>
          Fragment
          <select
            value={block.kind}
            onChange={(event) =>
              updateSequenceBlock(mutateModel, block.id, {
                kind: event.target.value as SequenceBlock["kind"],
              })
            }
          >
            {["loop", "alt", "else", "opt", "par", "critical", "break", "end"].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input
            value={block.label}
            onChange={(event) =>
              updateSequenceBlock(mutateModel, block.id, {
                label: event.target.value,
              })
            }
          />
        </label>
      </div>
    );
  }
  if (activation) {
    return (
      <div className="form-stack">
        <label>
          Action
          <select
            value={activation.action}
            onChange={(event) =>
              updateSequenceActivation(mutateModel, activation.id, {
                action: event.target.value as SequenceActivation["action"],
              })
            }
          >
            {["activate", "deactivate"].map((action) => (
              <option key={action}>{action}</option>
            ))}
          </select>
        </label>
        <label>
          Participant
          <select
            value={activation.participant}
            onChange={(event) =>
              updateSequenceActivation(mutateModel, activation.id, {
                participant: event.target.value,
              })
            }
          >
            {model.participants.map((participantItem) => (
              <option key={participantItem.id} value={participantItem.id}>
                {participantItem.id}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }
  return (
    <p className="empty-state">Select a participant, message, note, fragment, or activation.</p>
  );
}

function ClassInspector({ model, selection, mutateModel }: InspectorProps<ClassModel>) {
  const classNode =
    selection?.type === "class-node"
      ? model.classes.find((item) => item.id === selection.id)
      : undefined;
  const relation =
    selection?.type === "class-relation"
      ? model.relations.find((item) => item.id === selection.id)
      : undefined;
  if (classNode) {
    return <ClassNodeForm classNode={classNode} mutateModel={mutateModel} />;
  }
  if (relation) {
    return (
      <ClassRelationForm
        relation={relation}
        classes={model.classes.map((item) => item.name)}
        mutateModel={mutateModel}
      />
    );
  }
  return <p className="empty-state">Select a class or relation.</p>;
}

function ClassNodeForm({
  classNode,
  mutateModel,
}: {
  classNode: ClassModel["classes"][number];
  mutateModel: InspectorMutator;
}) {
  return (
    <div className="form-stack">
      <label>
        Name
        <input
          value={classNode.name}
          onChange={(event) =>
            mutateModel((draft) => {
              if (draft.type === "class") {
                draft.classes.find((item) => item.id === classNode.id)!.name = event.target.value;
              }
            }, "Edited class name")
          }
        />
      </label>
      <label>
        Stereotype
        <input
          value={classNode.stereotype}
          onChange={(event) =>
            mutateModel((draft) => {
              if (draft.type === "class") {
                draft.classes.find((item) => item.id === classNode.id)!.stereotype =
                  event.target.value;
              }
            }, "Edited stereotype")
          }
        />
      </label>
      <MemberEditor
        members={classNode.members}
        onAdd={() =>
          mutateModel((draft) => {
            if (draft.type === "class") {
              draft.classes
                .find((item) => item.id === classNode.id)!
                .members.push({
                  id: `member-${Date.now()}`,
                  name: "string value",
                  memberType: "property",
                  visibility: "+",
                });
            }
          }, "Added class member")
        }
        onChange={(memberId, patch) =>
          mutateModel((draft) => {
            if (draft.type === "class") {
              Object.assign(
                draft.classes
                  .find((item) => item.id === classNode.id)!
                  .members.find((member) => member.id === memberId)!,
                patch,
              );
            }
          }, "Edited class member")
        }
      />
    </div>
  );
}

function ClassRelationForm({
  relation,
  classes,
  mutateModel,
}: {
  relation: ClassRelation;
  classes: string[];
  mutateModel: InspectorMutator;
}) {
  const update = (patch: Partial<ClassRelation>) =>
    mutateModel((draft) => {
      if (draft.type === "class") {
        Object.assign(draft.relations.find((item) => item.id === relation.id)!, patch);
      }
    }, "Edited class relation");
  return (
    <div className="form-stack">
      <label>
        From
        <select value={relation.from} onChange={(event) => update({ from: event.target.value })}>
          {classes.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <label>
        From cardinality
        <input
          value={relation.fromCardinality}
          onChange={(event) => update({ fromCardinality: event.target.value })}
        />
      </label>
      <label>
        Relation
        <select
          value={relation.relation}
          onChange={(event) =>
            update({
              relation: event.target.value as ClassRelation["relation"],
            })
          }
        >
          {["<|--", "*--", "o--", "-->", "..>", "--", "..|>"].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label>
        To cardinality
        <input
          value={relation.toCardinality}
          onChange={(event) => update({ toCardinality: event.target.value })}
        />
      </label>
      <label>
        To
        <select value={relation.to} onChange={(event) => update({ to: event.target.value })}>
          {classes.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <label>
        Label
        <input value={relation.label} onChange={(event) => update({ label: event.target.value })} />
      </label>
    </div>
  );
}

function StateInspector({ model, selection, mutateModel }: InspectorProps<StateModel>) {
  const state =
    selection?.type === "state-node"
      ? model.states.find((item) => item.id === selection.id)
      : undefined;
  const transition =
    selection?.type === "state-transition"
      ? model.transitions.find((item) => item.id === selection.id)
      : undefined;
  if (state) {
    return (
      <div className="form-stack">
        <label>
          ID
          <input
            value={state.id}
            onChange={(event) => updateStateNodeId(mutateModel, state.id, event.target.value)}
          />
        </label>
        <label>
          Label
          <input
            value={state.label}
            onChange={(event) =>
              mutateModel((draft) => {
                if (draft.type === "state") {
                  draft.states.find((item) => item.id === state.id)!.label = event.target.value;
                }
              }, "Edited state label")
            }
          />
        </label>
      </div>
    );
  }
  if (transition) {
    return (
      <div className="form-stack">
        <label>
          From
          <select
            value={transition.from}
            onChange={(event) =>
              updateStateTransition(mutateModel, transition.id, {
                from: event.target.value,
              })
            }
          >
            <option value="[*]">[*]</option>
            {model.states.map((item) => (
              <option key={item.id}>{item.id}</option>
            ))}
          </select>
        </label>
        <label>
          To
          <select
            value={transition.to}
            onChange={(event) =>
              updateStateTransition(mutateModel, transition.id, {
                to: event.target.value,
              })
            }
          >
            <option value="[*]">[*]</option>
            {model.states.map((item) => (
              <option key={item.id}>{item.id}</option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input
            value={transition.label}
            onChange={(event) =>
              updateStateTransition(mutateModel, transition.id, {
                label: event.target.value,
              })
            }
          />
        </label>
      </div>
    );
  }
  return <p className="empty-state">Select a state or transition.</p>;
}

function ErInspector({ model, selection, mutateModel }: InspectorProps<ErModel>) {
  const entity =
    selection?.type === "er-entity"
      ? model.entities.find((item) => item.id === selection.id)
      : undefined;
  const relationship =
    selection?.type === "er-relationship"
      ? model.relationships.find((item) => item.id === selection.id)
      : undefined;
  if (entity) {
    return (
      <div className="form-stack">
        <label>
          Name
          <input
            value={entity.name}
            onChange={(event) =>
              mutateModel((draft) => {
                if (draft.type === "er") {
                  draft.entities.find((item) => item.id === entity.id)!.name = event.target.value;
                }
              }, "Edited entity")
            }
          />
        </label>
        <AttributeEditor
          attributes={entity.attributes}
          onAdd={() =>
            mutateModel((draft) => {
              if (draft.type === "er") {
                draft.entities
                  .find((item) => item.id === entity.id)!
                  .attributes.push({
                    id: `attribute-${Date.now()}`,
                    type: "string",
                    name: "field",
                    key: "",
                    comment: "",
                  });
              }
            }, "Added attribute")
          }
          onChange={(attributeId, patch) =>
            mutateModel((draft) => {
              if (draft.type === "er") {
                Object.assign(
                  draft.entities
                    .find((item) => item.id === entity.id)!
                    .attributes.find((attribute) => attribute.id === attributeId)!,
                  patch,
                );
              }
            }, "Edited attribute")
          }
        />
      </div>
    );
  }
  if (relationship) {
    return (
      <div className="form-stack">
        <label>
          From
          <select
            value={relationship.from}
            onChange={(event) =>
              updateErRelationship(mutateModel, relationship.id, {
                from: event.target.value,
              })
            }
          >
            {model.entities.map((entityItem) => (
              <option key={entityItem.name}>{entityItem.name}</option>
            ))}
          </select>
        </label>
        <label>
          Cardinality
          <input
            value={relationship.cardinality}
            onChange={(event) =>
              updateErRelationship(mutateModel, relationship.id, {
                cardinality: event.target.value,
              })
            }
          />
        </label>
        <label>
          To
          <select
            value={relationship.to}
            onChange={(event) =>
              updateErRelationship(mutateModel, relationship.id, {
                to: event.target.value,
              })
            }
          >
            {model.entities.map((entityItem) => (
              <option key={entityItem.name}>{entityItem.name}</option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input
            value={relationship.label}
            onChange={(event) =>
              updateErRelationship(mutateModel, relationship.id, {
                label: event.target.value,
              })
            }
          />
        </label>
      </div>
    );
  }
  return <p className="empty-state">Select an entity or relationship.</p>;
}

type InspectorMutator = (updater: (draft: DiagramModel) => void, message?: string) => void;
type InspectorProps<T extends DiagramModel> = {
  model: T;
  selection: Selection;
  mutateModel: InspectorMutator;
};

function MemberEditor({
  members,
  onAdd,
  onChange,
}: {
  members: ClassMember[];
  onAdd: () => void;
  onChange: (id: string, patch: Partial<ClassMember>) => void;
}) {
  return (
    <div className="mini-list">
      <button onClick={onAdd}>
        <Plus size={16} /> Member
      </button>
      {members.map((member) => (
        <div className="mini-row" key={member.id}>
          <select
            value={member.visibility}
            onChange={(event) =>
              onChange(member.id, {
                visibility: event.target.value as ClassMember["visibility"],
              })
            }
          >
            {["+", "-", "#", "~", ""].map((item) => (
              <option key={item} value={item}>
                {item || "none"}
              </option>
            ))}
          </select>
          <input
            value={member.name}
            onChange={(event) => onChange(member.id, { name: event.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

function AttributeEditor({
  attributes,
  onAdd,
  onChange,
}: {
  attributes: ErAttribute[];
  onAdd: () => void;
  onChange: (id: string, patch: Partial<ErAttribute>) => void;
}) {
  return (
    <div className="mini-list">
      <button onClick={onAdd}>
        <Plus size={16} /> Attribute
      </button>
      {attributes.map((attribute) => (
        <div className="mini-row" key={attribute.id}>
          <input
            value={attribute.type}
            onChange={(event) => onChange(attribute.id, { type: event.target.value })}
          />
          <input
            value={attribute.name}
            onChange={(event) => onChange(attribute.id, { name: event.target.value })}
          />
          <input
            value={attribute.key}
            onChange={(event) => onChange(attribute.id, { key: event.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

function updateSequenceParticipant(
  mutateModel: InspectorMutator,
  id: string,
  patch: Partial<SequenceModel["participants"][number]>,
) {
  mutateModel((draft) => {
    if (draft.type !== "sequence") {
      return;
    }
    const participant = draft.participants.find((item) => item.id === id);
    if (!participant) {
      return;
    }
    const oldId = participant.id;
    Object.assign(participant, patch);
    if (patch.id && patch.id !== oldId) {
      draft.messages.forEach((message) => {
        if (message.from === oldId) {
          message.from = patch.id!;
        }
        if (message.to === oldId) {
          message.to = patch.id!;
        }
      });
      draft.notes.forEach((note) => {
        note.participant = note.participant
          .split(",")
          .map((item) => (item.trim() === oldId ? patch.id! : item.trim()))
          .join(",");
      });
      draft.activations.forEach((activation) => {
        if (activation.participant === oldId) {
          activation.participant = patch.id!;
        }
      });
    }
  }, "Edited participant");
}

function updateSequenceMessage(
  mutateModel: InspectorMutator,
  id: string,
  patch: Partial<SequenceMessage>,
) {
  mutateModel((draft) => {
    if (draft.type === "sequence") {
      Object.assign(draft.messages.find((item) => item.id === id)!, patch);
    }
  }, "Edited sequence message");
}

function updateSequenceNote(
  mutateModel: InspectorMutator,
  id: string,
  patch: Partial<SequenceNote>,
) {
  mutateModel((draft) => {
    if (draft.type === "sequence") {
      Object.assign(draft.notes.find((item) => item.id === id)!, patch);
    }
  }, "Edited sequence note");
}

function updateSequenceBlock(
  mutateModel: InspectorMutator,
  id: string,
  patch: Partial<SequenceBlock>,
) {
  mutateModel((draft) => {
    if (draft.type === "sequence") {
      Object.assign(draft.blocks.find((item) => item.id === id)!, patch);
    }
  }, "Edited sequence fragment");
}

function updateSequenceActivation(
  mutateModel: InspectorMutator,
  id: string,
  patch: Partial<SequenceActivation>,
) {
  mutateModel((draft) => {
    if (draft.type === "sequence") {
      Object.assign(draft.activations.find((item) => item.id === id)!, patch);
    }
  }, "Edited sequence activation");
}

function updateStateTransition(
  mutateModel: InspectorMutator,
  id: string,
  patch: Partial<StateModel["transitions"][number]>,
) {
  mutateModel((draft) => {
    if (draft.type === "state") {
      Object.assign(draft.transitions.find((item) => item.id === id)!, patch);
    }
  }, "Edited transition");
}

function updateStateNodeId(mutateModel: InspectorMutator, id: string, nextId: string) {
  mutateModel((draft) => {
    if (draft.type !== "state") {
      return;
    }
    const state = draft.states.find((item) => item.id === id);
    if (!state) {
      return;
    }
    const normalized = uniqueId(
      nextId.replace(/[^A-Za-z0-9_-]/g, "_"),
      draft.states.filter((item) => item !== state).map((item) => item.id),
    );
    const oldId = state.id;
    state.id = normalized;
    draft.transitions.forEach((transition) => {
      if (transition.from === oldId) {
        transition.from = normalized;
      }
      if (transition.to === oldId) {
        transition.to = normalized;
      }
    });
    draft.states.forEach((item) => {
      if (item.parentId === oldId) {
        item.parentId = normalized;
      }
    });
  }, "Edited state");
}

function updateErRelationship(
  mutateModel: InspectorMutator,
  id: string,
  patch: Partial<ErRelationship>,
) {
  mutateModel((draft) => {
    if (draft.type === "er") {
      Object.assign(draft.relationships.find((item) => item.id === id)!, patch);
    }
  }, "Edited ER relationship");
}

function MermaidPreview({ code, onError }: { code: string; onError: (message: string) => void }) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      const previewElement = previewRef.current;
      if (!previewElement) {
        return;
      }
      try {
        const id = `mermaid-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const mermaid = await getMermaid();
        const { svg } = await mermaid.render(id, code);
        if (!cancelled) {
          previewElement.innerHTML = svg;
          onError("");
        }
      } catch (error) {
        if (!cancelled) {
          previewElement.innerHTML = "";
          onError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [code, onError]);
  return <div className="preview-output" ref={previewRef} />;
}

function uniqueId(seed: string, existing: string[]): string {
  const normalized = seed.replace(/^[^A-Za-z0-9_]+/, "N").replace(/[^A-Za-z0-9_-]/g, "_") || "N";
  let id = normalized;
  let index = 2;
  while (existing.includes(id)) {
    id = `${normalized}_${index}`;
    index += 1;
  }
  return id;
}

function diagramNameFromFile(fileName: string): string {
  const baseName = fileName.replace(/\.(mmd|mermaid|md|markdown|txt)$/i, "").trim();
  return baseName || "Imported diagram";
}

function downloadMermaid(code: string) {
  const blob = new Blob([code], { type: "text/vnd.mermaid;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "diagram.mmd";
  anchor.click();
  URL.revokeObjectURL(url);
}
