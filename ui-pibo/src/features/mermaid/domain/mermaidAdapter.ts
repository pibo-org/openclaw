export type NodeShape =
  | "rectangle"
  | "rounded"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "double-circle"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "parallelogram-alt"
  | "trapezoid"
  | "trapezoid-alt"
  | "asymmetric"
  | "docs"
  | "lin-docs";

export type DiagramKind =
  | "flowchart"
  | "sequenceDiagram"
  | "classDiagram"
  | "stateDiagram"
  | "erDiagram"
  | "gantt"
  | "pie"
  | "journey"
  | "gitGraph"
  | "mindmap"
  | "timeline"
  | "quadrantChart"
  | "requirementDiagram"
  | "c4Diagram"
  | "block-beta"
  | "architecture-beta"
  | "xyChart-beta"
  | "sankey-beta"
  | "unknown";

export type EditableDiagramType = "flowchart" | "sequence" | "class" | "state" | "er" | "generic";

export interface DiagramDefinition {
  kind: Exclude<DiagramKind, "unknown">;
  label: string;
  headerPattern: RegExp;
  starter: string;
  editor: EditableDiagramType;
}

export interface PreservedSyntax {
  id: string;
  line: string;
  reason: string;
}

export interface BaseDiagramModel {
  kind: Exclude<DiagramKind, "unknown">;
  header: string;
  leading?: PreservedSyntax[];
  preserved: PreservedSyntax[];
  warnings: string[];
}

export interface FlowNode {
  id: string;
  label: string;
  shape: NodeShape;
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  arrow: "-->" | "---" | "-.->" | "==>" | "--o" | "--x" | "<-->" | "o--o" | "x--x";
}

export interface FlowGroup {
  id: string;
  title: string;
  nodeIds: string[];
  x: number;
  y: number;
}

export interface FlowchartModel extends BaseDiagramModel {
  type: "flowchart";
  direction: "TD" | "TB" | "BT" | "LR" | "RL";
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups: FlowGroup[];
}

export interface SequenceParticipant {
  id: string;
  alias: string;
  actor: boolean;
}

export interface SequenceMessage {
  id: string;
  from: string;
  to: string;
  label: string;
  arrow: "->>" | "-->>" | "-)" | "--)" | "->" | "-->";
  activateTarget: boolean;
  deactivateTarget: boolean;
}

export interface SequenceNote {
  id: string;
  placement: "left of" | "right of" | "over";
  participant: string;
  text: string;
}

export interface SequenceBlock {
  id: string;
  kind: "loop" | "alt" | "else" | "opt" | "par" | "critical" | "break" | "end";
  label: string;
}

export interface SequenceActivation {
  id: string;
  participant: string;
  action: "activate" | "deactivate";
}

export interface SequenceStep {
  id: string;
  type: "message" | "note" | "block" | "activation" | "preserved";
}

export interface SequenceModel extends BaseDiagramModel {
  type: "sequence";
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  notes: SequenceNote[];
  blocks: SequenceBlock[];
  activations: SequenceActivation[];
  steps: SequenceStep[];
}

export interface ClassMember {
  id: string;
  name: string;
  memberType: "property" | "method";
  visibility: "+" | "-" | "#" | "~" | "";
}

export interface ClassNode {
  id: string;
  name: string;
  stereotype: string;
  members: ClassMember[];
}

export interface ClassRelation {
  id: string;
  from: string;
  to: string;
  relation: "<|--" | "*--" | "o--" | "-->" | "..>" | "--" | "..|>";
  fromCardinality: string;
  toCardinality: string;
  label: string;
}

export interface ClassModel extends BaseDiagramModel {
  type: "class";
  classes: ClassNode[];
  relations: ClassRelation[];
}

export interface StateNode {
  id: string;
  label: string;
  parentId: string;
}

export interface StateTransition {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface StateModel extends BaseDiagramModel {
  type: "state";
  states: StateNode[];
  transitions: StateTransition[];
}

export interface ErAttribute {
  id: string;
  type: string;
  name: string;
  key: string;
  comment: string;
}

export interface ErEntity {
  id: string;
  name: string;
  attributes: ErAttribute[];
}

export interface ErRelationship {
  id: string;
  from: string;
  to: string;
  cardinality: string;
  label: string;
}

export interface ErModel extends BaseDiagramModel {
  type: "er";
  entities: ErEntity[];
  relationships: ErRelationship[];
}

export interface GenericEntry {
  id: string;
  text: string;
}

export interface GenericDiagramModel extends BaseDiagramModel {
  type: "generic";
  entries: GenericEntry[];
  note: string;
}

export type DiagramModel =
  | FlowchartModel
  | SequenceModel
  | ClassModel
  | StateModel
  | ErModel
  | GenericDiagramModel;

const NODE_ID = "[A-Za-z0-9_][A-Za-z0-9_-]*";
const DEFAULT_POSITIONS = [
  [80, 80],
  [280, 80],
  [480, 80],
  [80, 230],
  [280, 230],
  [480, 230],
  [180, 380],
  [400, 380],
] as const;

export const DIAGRAM_REGISTRY: DiagramDefinition[] = [
  {
    kind: "flowchart",
    label: "Flowchart",
    headerPattern: /^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i,
    editor: "flowchart",
    starter: `flowchart TD
  A[Start] --> B{Decision}
  B -- Yes --> C([Build])
  B -- No --> D((Stop))
  subgraph Team
    C
  end
  classDef accent fill:#eef7ff,stroke:#2878bd
  class C accent`,
  },
  {
    kind: "sequenceDiagram",
    label: "Sequence",
    headerPattern: /^sequenceDiagram\b/i,
    editor: "sequence",
    starter: `sequenceDiagram
  participant Alice
  actor Bob
  Alice->>Bob: Request
  activate Bob
  Bob-->>Alice: Response
  Note over Alice,Bob: Preserved collaboration context`,
  },
  {
    kind: "classDiagram",
    label: "Class",
    headerPattern: /^classDiagram\b/i,
    editor: "class",
    starter: `classDiagram
  class Order {
    +string id
    +total()
  }
  class Customer {
    +string name
  }
  Customer "1" --> "*" Order : places`,
  },
  {
    kind: "stateDiagram",
    label: "State",
    headerPattern: /^stateDiagram(?:-v2)?\b/i,
    editor: "state",
    starter: `stateDiagram-v2
  [*] --> Idle
  Idle --> Running: start
  Running --> Idle: stop
  Running --> [*]: finish`,
  },
  {
    kind: "erDiagram",
    label: "ER",
    headerPattern: /^erDiagram\b/i,
    editor: "er",
    starter: `erDiagram
  CUSTOMER {
    string id PK "customer id"
    string name
  }
  ORDER {
    string id PK
    float total
  }
  CUSTOMER ||--o{ ORDER : places`,
  },
  {
    kind: "gantt",
    label: "Gantt",
    headerPattern: /^gantt\b/i,
    editor: "generic",
    starter: `gantt
  title Release plan
  dateFormat  YYYY-MM-DD
  section Build
  Adapter work :a1, 2026-04-30, 3d`,
  },
  {
    kind: "pie",
    label: "Pie",
    headerPattern: /^pie\b/i,
    editor: "generic",
    starter: `pie showData
  title Diagram usage
  "Flowcharts" : 45
  "Sequence" : 25
  "Other" : 30`,
  },
  {
    kind: "journey",
    label: "Journey",
    headerPattern: /^journey\b/i,
    editor: "generic",
    starter: `journey
  title Editor workflow
  section Import
    Paste Mermaid: 4: User
  section Edit
    Adjust model: 5: User`,
  },
  {
    kind: "gitGraph",
    label: "Git Graph",
    headerPattern: /^gitGraph\b/i,
    editor: "generic",
    starter: `gitGraph
  commit id: "start"
  branch feature
  checkout feature
  commit id: "editor"
  checkout main
  merge feature`,
  },
  {
    kind: "mindmap",
    label: "Mindmap",
    headerPattern: /^mindmap\b/i,
    editor: "generic",
    starter: `mindmap
  root((Mermaid Editor))
    Import
    Edit
    Export`,
  },
  {
    kind: "timeline",
    label: "Timeline",
    headerPattern: /^timeline\b/i,
    editor: "generic",
    starter: `timeline
  title Product path
  2026-04-30 : Complete editor run
  2026-05-01 : Verification`,
  },
  {
    kind: "quadrantChart",
    label: "Quadrant",
    headerPattern: /^quadrantChart\b/i,
    editor: "generic",
    starter: `quadrantChart
  title Diagram coverage
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  Flowchart: [0.7, 0.9]
  Raw preservation: [0.3, 0.8]`,
  },
  {
    kind: "requirementDiagram",
    label: "Requirement",
    headerPattern: /^requirementDiagram\b/i,
    editor: "generic",
    starter: `requirementDiagram
  requirement editor_req {
    id: 1
    text: support import export
    risk: medium
    verifymethod: test
  }`,
  },
  {
    kind: "c4Diagram",
    label: "C4",
    headerPattern: /^(C4Context|C4Container|C4Component|C4Dynamic|c4Diagram)\b/i,
    editor: "generic",
    starter: `C4Context
  title System Context
  Person(user, "User")
  System(editor, "Mermaid Editor")
  Rel(user, editor, "Creates diagrams")`,
  },
  {
    kind: "block-beta",
    label: "Block",
    headerPattern: /^block-beta\b/i,
    editor: "generic",
    starter: `block-beta
  columns 3
  Import["Import"]
  Edit["Edit"]
  Export["Export"]`,
  },
  {
    kind: "architecture-beta",
    label: "Architecture",
    headerPattern: /^architecture-beta\b/i,
    editor: "generic",
    starter: `architecture-beta
  group app(cloud)[Editor App]
  service ui(server)[UI] in app
  service adapter(database)[Adapters] in app
  ui:R -- L:adapter`,
  },
  {
    kind: "xyChart-beta",
    label: "XY Chart",
    headerPattern: /^xychart-beta\b/i,
    editor: "generic",
    starter: `xychart-beta
  title "Coverage"
  x-axis [Flow, Sequence, Class, State, ER]
  y-axis "Support" 0 --> 100
  bar [95, 75, 75, 70, 75]`,
  },
  {
    kind: "sankey-beta",
    label: "Sankey",
    headerPattern: /^sankey-beta\b/i,
    editor: "generic",
    starter: `sankey-beta
  Import,Model,10
  Model,Preview,7
  Model,Export,10`,
  },
];

export function getDiagramDefinition(kind: DiagramKind): DiagramDefinition | undefined {
  return DIAGRAM_REGISTRY.find((definition) => definition.kind === kind);
}

export function normalizeMermaidInput(input: string): string {
  const trimmed = input.trim();
  const mermaidFence = trimmed.match(/```(?:mermaid|mmd)\s*([\s\S]*?)```/i);
  if (mermaidFence) {
    return mermaidFence[1].trim();
  }
  const genericFence = trimmed.match(/```\s*([\s\S]*?)```/);
  if (genericFence) {
    return genericFence[1].trim();
  }
  return trimmed;
}

export function detectDiagramKind(input: string): DiagramKind {
  const firstLine = firstMeaningfulLine(normalizeMermaidInput(input));
  if (!firstLine) {
    return "unknown";
  }
  return (
    DIAGRAM_REGISTRY.find((definition) => definition.headerPattern.test(firstLine))?.kind ??
    "unknown"
  );
}

export function createStarterModel(kind: Exclude<DiagramKind, "unknown">): DiagramModel {
  const definition = getDiagramDefinition(kind);
  if (!definition) {
    throw new Error(`Unsupported diagram kind: ${kind}`);
  }
  return parseMermaidInput(definition.starter);
}

export function parseMermaidInput(input: string): DiagramModel {
  const code = normalizeMermaidInput(input);
  if (!code) {
    throw new Error("Mermaid input is empty. Paste a diagram definition before importing.");
  }

  const kind = detectDiagramKind(code);
  if (kind === "unknown") {
    throw new Error(
      "Could not detect a supported Mermaid diagram type on the first non-comment line.",
    );
  }

  if (kind === "flowchart") {
    return parseFlowchart(code);
  }
  if (kind === "sequenceDiagram") {
    return parseSequence(code);
  }
  if (kind === "classDiagram") {
    return parseClass(code);
  }
  if (kind === "stateDiagram") {
    return parseState(code);
  }
  if (kind === "erDiagram") {
    return parseEr(code);
  }
  return parseGeneric(code, kind);
}

export function exportMermaid(model: DiagramModel): string {
  if (model.type === "flowchart") {
    return exportFlowchart(model);
  }
  if (model.type === "sequence") {
    return exportSequence(model);
  }
  if (model.type === "class") {
    return exportClass(model);
  }
  if (model.type === "state") {
    return exportState(model);
  }
  if (model.type === "er") {
    return exportEr(model);
  }
  return exportGeneric(model);
}

export function parseFlowchart(input: string): FlowchartModel {
  const {
    header: headerLine,
    bodyLines,
    leading,
    leadingWarnings,
  } = splitLeadingSyntax(
    input,
    /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i,
    'Flowchart input must start with a Mermaid flowchart or graph direction, for example "flowchart TD".',
  );
  const header = headerLine.match(/^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i);
  if (!header) {
    throw new Error(
      'Flowchart input must start with a Mermaid flowchart or graph direction, for example "flowchart TD".',
    );
  }

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const groups: FlowGroup[] = [];
  const preserved: PreservedSyntax[] = [];
  const warnings: string[] = [...leadingWarnings];
  const groupStack: FlowGroup[] = [];
  let nextIndex = 0;

  const addPreserved = (line: string, reason: string) => {
    preserved.push(makePreserved(line, reason));
    warnings.push(`Preserved unsupported flowchart syntax: ${line}`);
  };
  const addNode = (token: ParsedNodeToken): void => {
    const existing = nodes.get(token.id);
    if (existing) {
      if (token.label !== undefined) {
        existing.label = token.label;
      }
      if (token.shape) {
        existing.shape = token.shape;
      }
    } else {
      const [x, y] = DEFAULT_POSITIONS[nextIndex % DEFAULT_POSITIONS.length];
      const row = Math.floor(nextIndex / DEFAULT_POSITIONS.length);
      nodes.set(token.id, {
        id: token.id,
        label: token.label ?? token.id,
        shape: token.shape ?? "rectangle",
        x,
        y: y + row * 150,
      });
      nextIndex += 1;
    }
    const currentGroup = groupStack[groupStack.length - 1];
    if (currentGroup && !currentGroup.nodeIds.includes(token.id)) {
      currentGroup.nodeIds.push(token.id);
    }
  };

  bodyLines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.startsWith("%%")) {
      addPreserved(line, "comment/directive");
      return;
    }
    const subgraph = line.match(/^subgraph\s+(.+)$/i);
    if (subgraph) {
      const id = `group-${groups.length + 1}`;
      const group = {
        id,
        title: cleanLabel(subgraph[1]),
        nodeIds: [],
        x: 60 + groups.length * 36,
        y: 48 + groups.length * 36,
      };
      groups.push(group);
      groupStack.push(group);
      return;
    }
    if (/^end$/i.test(line) && groupStack.length) {
      groupStack.pop();
      return;
    }
    if (/^(classDef|class|style|linkStyle|click|accTitle|accDescr)\b/i.test(line)) {
      addPreserved(line, "style/class/directive");
      return;
    }

    const parsedEdge = parseEdgeLine(line);
    if (parsedEdge) {
      addNode(parsedEdge.source);
      addNode(parsedEdge.target);
      edges.push({
        id: `edge-${edges.length + 1}`,
        source: parsedEdge.source.id,
        target: parsedEdge.target.id,
        label: parsedEdge.label,
        arrow: parsedEdge.arrow,
      });
      return;
    }

    const node = parseNodeToken(line);
    if (node) {
      addNode(node);
      return;
    }

    if (looksMalformedFlow(line)) {
      throw new Error(
        `Could not parse flowchart line ${lineIndex + 2}: "${line}". Check for missing node IDs, invalid arrows, or unmatched brackets.`,
      );
    }

    addPreserved(line, "unmodeled flowchart statement");
  });

  return {
    type: "flowchart",
    kind: "flowchart",
    header: `flowchart ${header[1].toUpperCase()}`,
    leading,
    direction: header[1].toUpperCase() as FlowchartModel["direction"],
    nodes: Array.from(nodes.values()),
    edges,
    groups,
    preserved,
    warnings,
  };
}

export function parseSequence(input: string): SequenceModel {
  const { header, bodyLines, leading, leadingWarnings } = splitLeadingSyntax(
    input,
    /^sequenceDiagram\b/i,
    'Sequence input must start with "sequenceDiagram".',
  );
  if (!header || !/^sequenceDiagram\b/i.test(header)) {
    throw new Error('Sequence input must start with "sequenceDiagram".');
  }
  const participants = new Map<string, SequenceParticipant>();
  const messages: SequenceMessage[] = [];
  const notes: SequenceNote[] = [];
  const blocks: SequenceBlock[] = [];
  const activations: SequenceActivation[] = [];
  const steps: SequenceStep[] = [];
  const preserved: PreservedSyntax[] = [];
  const warnings: string[] = [...leadingWarnings];

  const ensureParticipant = (id: string) => {
    const clean = id.trim();
    if (!clean || participants.has(clean)) {
      return;
    }
    participants.set(clean, { id: clean, alias: clean, actor: false });
  };

  bodyLines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.startsWith("%%") || /^(rect|end rect|autonumber)\b/i.test(line)) {
      const item = makePreserved(line, "sequence directive");
      preserved.push(item);
      steps.push({ id: item.id, type: "preserved" });
      warnings.push(`Preserved sequence syntax: ${line}`);
      return;
    }
    const activation = line.match(/^(activate|deactivate)\s+([A-Za-z0-9_][\w-]*)$/i);
    if (activation) {
      const id = `activation-${activations.length + 1}`;
      ensureParticipant(activation[2]);
      activations.push({
        id,
        participant: activation[2],
        action: activation[1].toLowerCase() as SequenceActivation["action"],
      });
      steps.push({ id, type: "activation" });
      return;
    }
    const participant = line.match(
      /^(participant|actor)\s+([A-Za-z0-9_][\w-]*)(?:\s+as\s+(.+))?$/i,
    );
    if (participant) {
      participants.set(participant[2], {
        id: participant[2],
        alias: cleanLabel(participant[3] ?? participant[2]),
        actor: participant[1].toLowerCase() === "actor",
      });
      return;
    }
    const message = line.match(/^(.+?)\s*(-->>|->>|--\)|-\)|-->|->)([+-]?)\s*(.+?)\s*:\s*(.*)$/);
    if (message) {
      const from = message[1].trim();
      const to = message[4].trim();
      ensureParticipant(from);
      ensureParticipant(to);
      const id = `message-${messages.length + 1}`;
      messages.push({
        id,
        from,
        to,
        arrow: message[2] as SequenceMessage["arrow"],
        label: message[5].trim(),
        activateTarget: message[3] === "+",
        deactivateTarget: message[3] === "-",
      });
      steps.push({ id, type: "message" });
      return;
    }
    const note = line.match(/^Note\s+(left of|right of|over)\s+(.+?)\s*:\s*(.+)$/i);
    if (note) {
      const participantId = note[2].trim();
      participantId.split(",").forEach(ensureParticipant);
      const id = `note-${notes.length + 1}`;
      notes.push({
        id,
        placement: note[1].toLowerCase() as SequenceNote["placement"],
        participant: participantId,
        text: note[3].trim(),
      });
      steps.push({ id, type: "note" });
      return;
    }
    const block = line.match(/^(loop|alt|else|opt|par|critical|break|end)\b\s*(.*)$/i);
    if (block) {
      const id = `block-${blocks.length + 1}`;
      blocks.push({
        id,
        kind: block[1].toLowerCase() as SequenceBlock["kind"],
        label: block[2].trim(),
      });
      steps.push({ id, type: "block" });
      return;
    }
    const item = makePreserved(line, "unmodeled sequence statement");
    preserved.push(item);
    steps.push({ id: item.id, type: "preserved" });
    warnings.push(`Preserved sequence syntax: ${line}`);
  });

  return {
    type: "sequence",
    kind: "sequenceDiagram",
    header,
    leading,
    participants: Array.from(participants.values()),
    messages,
    notes,
    blocks,
    activations,
    steps,
    preserved,
    warnings,
  };
}

export function parseClass(input: string): ClassModel {
  const { header, bodyLines, leading, leadingWarnings } = splitLeadingSyntax(
    input,
    /^classDiagram\b/i,
    'Class input must start with "classDiagram".',
  );
  if (!header || !/^classDiagram\b/i.test(header)) {
    throw new Error('Class input must start with "classDiagram".');
  }
  const classes = new Map<string, ClassNode>();
  const relations: ClassRelation[] = [];
  const preserved: PreservedSyntax[] = [];
  const warnings: string[] = [...leadingWarnings];
  let currentClass: ClassNode | null = null;

  const ensureClass = (name: string): ClassNode => {
    const clean = name.trim().replace(/^"|"$/g, "");
    const existing = classes.get(clean);
    if (existing) {
      return existing;
    }
    const next = { id: clean, name: clean, stereotype: "", members: [] };
    classes.set(clean, next);
    return next;
  };

  bodyLines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.startsWith("%%")) {
      preserved.push(makePreserved(line, "comment/directive"));
      warnings.push(`Preserved class syntax: ${line}`);
      return;
    }
    const classStart = line.match(/^class\s+([A-Za-z0-9_][\w-]*)(?:\s*\{)?$/);
    if (classStart) {
      currentClass = ensureClass(classStart[1]);
      if (!line.endsWith("{")) {
        currentClass = null;
      }
      return;
    }
    if (line === "}") {
      currentClass = null;
      return;
    }
    if (currentClass) {
      currentClass.members.push(parseClassMember(line, currentClass.members.length));
      return;
    }
    const stereotype = line.match(/^<<(.+)>>\s+([A-Za-z0-9_][\w-]*)$/);
    if (stereotype) {
      ensureClass(stereotype[2]).stereotype = stereotype[1].trim();
      return;
    }
    const member = line.match(/^([A-Za-z0-9_][\w-]*)\s*:\s*(.+)$/);
    if (member) {
      const target = ensureClass(member[1]);
      target.members.push(parseClassMember(member[2], target.members.length));
      return;
    }
    const relation = line.match(
      /^(.+?)\s+(".*?"\s*)?(<\|--|\*--|o--|-->|..>|--|..\|>)\s+(".*?"\s*)?(.+?)(?:\s*:\s*(.*))?$/,
    );
    if (relation) {
      const from = cleanRelationEndpoint(relation[1]);
      const to = cleanRelationEndpoint(relation[5]);
      ensureClass(from);
      ensureClass(to);
      relations.push({
        id: `relation-${relations.length + 1}`,
        from,
        to,
        relation: relation[3] as ClassRelation["relation"],
        fromCardinality: cleanLabel(relation[2]?.trim() ?? ""),
        toCardinality: cleanLabel(relation[4]?.trim() ?? ""),
        label: cleanLabel(relation[6] ?? ""),
      });
      return;
    }
    preserved.push(makePreserved(line, "unmodeled class statement"));
    warnings.push(`Preserved class syntax: ${line}`);
  });

  return {
    type: "class",
    kind: "classDiagram",
    header,
    leading,
    classes: Array.from(classes.values()),
    relations,
    preserved,
    warnings,
  };
}

export function parseState(input: string): StateModel {
  const { header, bodyLines, leading, leadingWarnings } = splitLeadingSyntax(
    input,
    /^stateDiagram(?:-v2)?\b/i,
    'State input must start with "stateDiagram" or "stateDiagram-v2".',
  );
  if (!header || !/^stateDiagram(?:-v2)?\b/i.test(header)) {
    throw new Error('State input must start with "stateDiagram" or "stateDiagram-v2".');
  }
  const states = new Map<string, StateNode>();
  const transitions: StateTransition[] = [];
  const preserved: PreservedSyntax[] = [];
  const warnings: string[] = [...leadingWarnings];
  let parentId = "";

  const ensureState = (id: string, label = id) => {
    if (id === "[*]") {
      return;
    }
    const clean = id.trim();
    if (!states.has(clean)) {
      states.set(clean, { id: clean, label: cleanLabel(label), parentId });
    }
  };

  bodyLines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.startsWith("%%")) {
      preserved.push(makePreserved(line, "comment/directive"));
      warnings.push(`Preserved state syntax: ${line}`);
      return;
    }
    const composite =
      line.match(/^state\s+(.+?)\s+as\s+([A-Za-z0-9_][\w-]*)(?:\s*\{)?$/i) ??
      line.match(/^state\s+([A-Za-z0-9_][\w-]*)(?:\s*\{)?$/i);
    if (composite) {
      const label = composite.length === 3 ? composite[1] : composite[1];
      const id = composite.length === 3 ? composite[2] : composite[1];
      ensureState(id, label);
      if (line.endsWith("{")) {
        parentId = id;
      }
      return;
    }
    if (line === "}") {
      parentId = "";
      return;
    }
    const transition = line.match(/^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.*))?$/);
    if (transition) {
      const from = transition[1].trim();
      const to = transition[2].trim();
      ensureState(from);
      ensureState(to);
      transitions.push({
        id: `transition-${transitions.length + 1}`,
        from,
        to,
        label: transition[3]?.trim() ?? "",
      });
      return;
    }
    const alias = line.match(/^([A-Za-z0-9_][\w-]*)\s*:\s*(.+)$/);
    if (alias) {
      ensureState(alias[1], alias[2]);
      return;
    }
    preserved.push(makePreserved(line, "unmodeled state statement"));
    warnings.push(`Preserved state syntax: ${line}`);
  });

  return {
    type: "state",
    kind: "stateDiagram",
    header,
    leading,
    states: Array.from(states.values()),
    transitions,
    preserved,
    warnings,
  };
}

export function parseEr(input: string): ErModel {
  const { header, bodyLines, leading, leadingWarnings } = splitLeadingSyntax(
    input,
    /^erDiagram\b/i,
    'ER input must start with "erDiagram".',
  );
  if (!header || !/^erDiagram\b/i.test(header)) {
    throw new Error('ER input must start with "erDiagram".');
  }
  const entities = new Map<string, ErEntity>();
  const relationships: ErRelationship[] = [];
  const preserved: PreservedSyntax[] = [];
  const warnings: string[] = [...leadingWarnings];
  let currentEntity: ErEntity | null = null;

  const ensureEntity = (name: string): ErEntity => {
    const clean = name.trim();
    const existing = entities.get(clean);
    if (existing) {
      return existing;
    }
    const next = { id: clean, name: clean, attributes: [] };
    entities.set(clean, next);
    return next;
  };

  bodyLines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.startsWith("%%")) {
      preserved.push(makePreserved(line, "comment/directive"));
      warnings.push(`Preserved ER syntax: ${line}`);
      return;
    }
    const entityStart = line.match(/^([A-Za-z0-9_][\w-]*)\s*\{$/);
    if (entityStart) {
      currentEntity = ensureEntity(entityStart[1]);
      return;
    }
    if (line === "}") {
      currentEntity = null;
      return;
    }
    if (currentEntity) {
      currentEntity.attributes.push(parseErAttribute(line, currentEntity.attributes.length));
      return;
    }
    const relationship = line.match(
      /^([A-Za-z0-9_][\w-]*)\s+([|o}{][|o}{]--[|o}{][|o}{])\s+([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$/,
    );
    if (relationship) {
      ensureEntity(relationship[1]);
      ensureEntity(relationship[3]);
      relationships.push({
        id: `relationship-${relationships.length + 1}`,
        from: relationship[1],
        to: relationship[3],
        cardinality: relationship[2],
        label: relationship[4].trim(),
      });
      return;
    }
    preserved.push(makePreserved(line, "unmodeled ER statement"));
    warnings.push(`Preserved ER syntax: ${line}`);
  });

  return {
    type: "er",
    kind: "erDiagram",
    header,
    leading,
    entities: Array.from(entities.values()),
    relationships,
    preserved,
    warnings,
  };
}

export function parseGeneric(
  input: string,
  kind: Exclude<DiagramKind, "unknown">,
): GenericDiagramModel {
  const definition = getDiagramDefinition(kind);
  const { header, bodyLines, leading, leadingWarnings } = splitLeadingSyntax(
    input,
    definition?.headerPattern ?? /^$/,
    "Mermaid input is empty.",
  );
  if (!header) {
    throw new Error("Mermaid input is empty.");
  }
  const entries: GenericEntry[] = [];
  const preserved: PreservedSyntax[] = [];
  const warnings: string[] = [...leadingWarnings];

  bodyLines.forEach((rawLine) => {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      return;
    }
    if (line.trim().startsWith("%%")) {
      preserved.push(makePreserved(line.trim(), "comment/directive"));
      warnings.push(`Preserved ${kind} syntax: ${line.trim()}`);
      return;
    }
    entries.push({
      id: `entry-${entries.length + 1}`,
      text: line.replace(/^\s{0,2}/, ""),
    });
  });

  return {
    type: "generic",
    kind,
    header,
    leading,
    entries,
    preserved,
    warnings,
    note: `${definition?.label ?? kind} uses a structured line editor. Unmodeled comments/directives are preserved and exported.`,
  };
}

function exportFlowchart(model: FlowchartModel): string {
  const lines = [...formatLeading(model), `flowchart ${model.direction || "TD"}`];
  const groupedNodeIds = new Set(model.groups.flatMap((group) => group.nodeIds));
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  model.groups.forEach((group) => {
    lines.push(`  subgraph ${escapeLabel(group.title)}`);
    group.nodeIds.forEach((nodeId) => {
      const node = nodeById.get(nodeId);
      if (node) {
        lines.push(`    ${node.id}${formatNodeShape(node)}`);
      }
    });
    lines.push("  end");
  });
  model.nodes
    .filter((node) => !groupedNodeIds.has(node.id))
    .forEach((node) => lines.push(`  ${node.id}${formatNodeShape(node)}`));
  model.edges.forEach((edge) => lines.push(`  ${formatEdge(edge)}`));
  model.preserved.forEach((item) => lines.push(`  ${item.line}`));
  return lines.join("\n");
}

function exportSequence(model: SequenceModel): string {
  const lines = [...formatLeading(model), model.header || "sequenceDiagram"];
  const openBlocks: SequenceBlock["kind"][] = [];
  model.participants.forEach((participant) => {
    const type = participant.actor ? "actor" : "participant";
    const alias =
      participant.alias && participant.alias !== participant.id
        ? ` as ${escapeLabel(participant.alias)}`
        : "";
    lines.push(`  ${type} ${participant.id}${alias}`);
  });
  const steps = model.steps?.length
    ? model.steps
    : [
        ...model.blocks.map((block) => ({
          id: block.id,
          type: "block" as const,
        })),
        ...model.messages.map((message) => ({
          id: message.id,
          type: "message" as const,
        })),
        ...model.notes.map((note) => ({ id: note.id, type: "note" as const })),
        ...(model.activations ?? []).map((activation) => ({
          id: activation.id,
          type: "activation" as const,
        })),
        ...model.preserved.map((item) => ({
          id: item.id,
          type: "preserved" as const,
        })),
      ];
  steps.forEach((step) => {
    if (step.type === "block") {
      const block = model.blocks.find((item) => item.id === step.id);
      if (block) {
        lines.push(`  ${block.kind}${block.label ? ` ${escapeLabel(block.label)}` : ""}`);
        if (isSequenceOpeningBlock(block.kind)) {
          openBlocks.push(block.kind);
        }
        if (block.kind === "end" && openBlocks.length) {
          openBlocks.pop();
        }
      }
    }
    if (step.type === "message") {
      const message = model.messages.find((item) => item.id === step.id);
      if (message) {
        const activation = message.activateTarget ? "+" : message.deactivateTarget ? "-" : "";
        lines.push(
          `  ${message.from}${message.arrow}${activation}${message.to}: ${escapeLabel(message.label)}`,
        );
      }
    }
    if (step.type === "note") {
      const note = model.notes.find((item) => item.id === step.id);
      if (note) {
        lines.push(`  Note ${note.placement} ${note.participant}: ${escapeLabel(note.text)}`);
      }
    }
    if (step.type === "activation") {
      const activation = model.activations?.find((item) => item.id === step.id);
      if (activation) {
        lines.push(`  ${activation.action} ${activation.participant}`);
      }
    }
    if (step.type === "preserved") {
      const item = model.preserved.find((preserved) => preserved.id === step.id);
      if (item) {
        lines.push(`  ${item.line}`);
      }
    }
  });
  openBlocks.forEach(() => lines.push("  end"));
  return lines.join("\n");
}

function exportClass(model: ClassModel): string {
  const lines = [...formatLeading(model), model.header || "classDiagram"];
  model.classes.forEach((classNode) => {
    lines.push(`  class ${classNode.name} {`);
    classNode.members.forEach((member) => lines.push(`    ${member.visibility}${member.name}`));
    lines.push("  }");
    if (classNode.stereotype) {
      lines.push(`  <<${escapeLabel(classNode.stereotype)}>> ${classNode.name}`);
    }
  });
  model.relations.forEach((relation) => {
    const fromCardinality = formatCardinality(relation.fromCardinality);
    const toCardinality = formatCardinality(relation.toCardinality);
    lines.push(
      `  ${relation.from}${fromCardinality} ${relation.relation}${toCardinality} ${relation.to}${relation.label ? ` : ${escapeLabel(relation.label)}` : ""}`,
    );
  });
  model.preserved.forEach((item) => lines.push(`  ${item.line}`));
  return lines.join("\n");
}

function exportState(model: StateModel): string {
  const lines = [...formatLeading(model), model.header || "stateDiagram-v2"];
  model.states.forEach((state) => {
    if (state.label !== state.id) {
      lines.push(`  ${state.id}: ${escapeLabel(state.label)}`);
    }
  });
  model.transitions.forEach((transition) =>
    lines.push(
      `  ${transition.from} --> ${transition.to}${transition.label ? `: ${escapeLabel(transition.label)}` : ""}`,
    ),
  );
  model.states
    .filter(
      (state) =>
        state.label === state.id &&
        !model.transitions.some(
          (transition) => transition.from === state.id || transition.to === state.id,
        ),
    )
    .forEach((state) => lines.push(`  state ${state.id}`));
  model.preserved.forEach((item) => lines.push(`  ${item.line}`));
  return lines.join("\n");
}

function exportEr(model: ErModel): string {
  const lines = [...formatLeading(model), model.header || "erDiagram"];
  model.entities.forEach((entity) => {
    lines.push(`  ${entity.name} {`);
    entity.attributes.forEach((attribute) => {
      const key = attribute.key ? ` ${attribute.key}` : "";
      const comment = attribute.comment ? ` "${escapeLabel(attribute.comment)}"` : "";
      lines.push(`    ${attribute.type} ${attribute.name}${key}${comment}`);
    });
    lines.push("  }");
  });
  model.relationships.forEach((relationship) =>
    lines.push(
      `  ${relationship.from} ${relationship.cardinality} ${relationship.to} : ${escapeLabel(relationship.label)}`,
    ),
  );
  model.preserved.forEach((item) => lines.push(`  ${item.line}`));
  return lines.join("\n");
}

function exportGeneric(model: GenericDiagramModel): string {
  const lines = [...formatLeading(model), model.header];
  model.entries.forEach((entry) => lines.push(`  ${entry.text}`));
  model.preserved.forEach((item) => lines.push(`  ${item.line}`));
  return lines.join("\n");
}

interface ParsedNodeToken {
  id: string;
  label?: string;
  shape?: NodeShape;
}

function parseEdgeLine(line: string):
  | {
      source: ParsedNodeToken;
      target: ParsedNodeToken;
      label: string;
      arrow: FlowEdge["arrow"];
    }
  | undefined {
  const pipeLabel = line.match(
    /^(.+?)\s*(-->|---|-\.-?>|==>|--o|--x|<-->|o--o|x--x)\|(.+?)\|\s*(.+)$/,
  );
  if (pipeLabel) {
    const source = parseNodeToken(pipeLabel[1]);
    const target = parseNodeToken(pipeLabel[4]);
    if (!source || !target) {
      return undefined;
    }
    return {
      source,
      target,
      label: pipeLabel[3].trim(),
      arrow: normalizeArrow(pipeLabel[2]),
    };
  }

  const labelled = line.match(/^(.+?)\s+--\s+(.+?)\s+-->\s+(.+)$/);
  if (labelled) {
    const source = parseNodeToken(labelled[1]);
    const target = parseNodeToken(labelled[3]);
    if (!source || !target) {
      return undefined;
    }
    return { source, target, label: labelled[2].trim(), arrow: "-->" };
  }

  const plain = line.match(/^(.+?)\s*(<-->|o--o|x--x|-\.->|==>|-->|---|--o|--x)\s*(.+)$/);
  if (!plain) {
    return undefined;
  }
  const source = parseNodeToken(plain[1]);
  const target = parseNodeToken(plain[3]);
  if (!source || !target) {
    return undefined;
  }
  return { source, target, label: "", arrow: normalizeArrow(plain[2]) };
}

function parseNodeToken(token: string): ParsedNodeToken | undefined {
  const compact = token.trim();
  const general = compact.match(
    new RegExp(
      `^(${NODE_ID})@\\{\\s*shape:\\s*([A-Za-z-]+)(?:,\\s*label:\\s*"?([^"}]+)"?)?\\s*\\}$`,
    ),
  );
  if (general) {
    return {
      id: general[1],
      shape: fromMermaidShape(general[2]),
      label: general[3] ? cleanLabel(general[3]) : undefined,
    };
  }
  const patterns: Array<[RegExp, NodeShape]> = [
    [new RegExp(`^(${NODE_ID})\\s*\\(\\(\\((.*?)\\)\\)\\)$`), "double-circle"],
    [new RegExp(`^(${NODE_ID})\\s*\\(\\((.*?)\\)\\)$`), "circle"],
    [new RegExp(`^(${NODE_ID})\\s*\\{\\{(.*?)\\}\\}$`), "hexagon"],
    [new RegExp(`^(${NODE_ID})\\s*\\{(.*?)\\}$`), "diamond"],
    [new RegExp(`^(${NODE_ID})\\s*\\[\\[(.*?)\\]\\]$`), "subroutine"],
    [new RegExp(`^(${NODE_ID})\\s*\\[\\((.*?)\\)\\]$`), "cylinder"],
    [new RegExp(`^(${NODE_ID})\\s*\\(\\[(.*?)\\]\\)$`), "stadium"],
    [new RegExp(`^(${NODE_ID})\\s*\\[(.*?)\\]$`), "rectangle"],
    [new RegExp(`^(${NODE_ID})\\s*\\((.*?)\\)$`), "rounded"],
    [new RegExp(`^(${NODE_ID})\\s*>(.*?)\\]$`), "asymmetric"],
  ];
  for (const [pattern, shape] of patterns) {
    const match = compact.match(pattern);
    if (match) {
      return { id: match[1], label: cleanLabel(match[2]), shape };
    }
  }
  if (new RegExp(`^${NODE_ID}$`).test(compact)) {
    return { id: compact };
  }
  return undefined;
}

function formatNodeShape(node: FlowNode): string {
  const label = escapeLabel(node.label || node.id);
  if (node.shape === "rounded") {
    return `(${label})`;
  }
  if (node.shape === "stadium") {
    return `([${label}])`;
  }
  if (node.shape === "subroutine") {
    return `[[${label}]]`;
  }
  if (node.shape === "cylinder") {
    return `[(${label})]`;
  }
  if (node.shape === "circle") {
    return `((${label}))`;
  }
  if (node.shape === "double-circle") {
    return `(((${label})))`;
  }
  if (node.shape === "diamond") {
    return `{${label}}`;
  }
  if (node.shape === "hexagon") {
    return `{{${label}}}`;
  }
  if (node.shape === "asymmetric") {
    return `>${label}]`;
  }
  if (node.shape === "rectangle") {
    return `[${label}]`;
  }
  return `@{ shape: ${toMermaidShape(node.shape)}, label: "${label}" }`;
}

function formatEdge(edge: FlowEdge): string {
  if (edge.label.trim()) {
    return `${edge.source} ${edge.arrow}|${escapeLabel(edge.label.trim())}| ${edge.target}`;
  }
  return `${edge.source} ${edge.arrow} ${edge.target}`;
}

function parseClassMember(line: string, index: number): ClassMember {
  const visibilityMatch = line.trim().match(/^([+\-#~])?(.*)$/);
  return {
    id: `member-${index + 1}`,
    visibility: (visibilityMatch?.[1] as ClassMember["visibility"]) ?? "",
    name: visibilityMatch?.[2]?.trim() ?? line.trim(),
    memberType: /\)\s*$/.test(line) ? "method" : "property",
  };
}

function parseErAttribute(line: string, index: number): ErAttribute {
  const match = line.match(/^(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+"(.+)")?$/);
  return {
    id: `attribute-${index + 1}`,
    type: match?.[1] ?? "string",
    name: match?.[2] ?? line.trim(),
    key: match?.[3] ?? "",
    comment: match?.[4] ?? "",
  };
}

function cleanRelationEndpoint(value: string): string {
  return value.replace(/".*?"/g, "").trim();
}

function firstMeaningfulLine(code: string): string {
  return (
    code
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("%%")) ?? ""
  );
}

function splitLeadingSyntax(
  input: string,
  headerPattern: RegExp,
  errorMessage: string,
): {
  header: string;
  bodyLines: string[];
  leading: PreservedSyntax[];
  leadingWarnings: string[];
} {
  const rawLines = linesOf(input);
  const headerIndex = rawLines.findIndex((line) => headerPattern.test(line.trim()));
  if (headerIndex < 0) {
    throw new Error(errorMessage);
  }
  const leadingLines = rawLines.slice(0, headerIndex).map((line) => line.trim());
  const unsupported = leadingLines.find((line) => !line.startsWith("%%"));
  if (unsupported) {
    throw new Error(errorMessage);
  }
  const leading = leadingLines.map((line) => makePreserved(line, "leading comment/directive"));
  return {
    header: rawLines[headerIndex].trim(),
    bodyLines: rawLines.slice(headerIndex + 1),
    leading,
    leadingWarnings: leading.map((item) => `Preserved leading Mermaid syntax: ${item.line}`),
  };
}

function formatLeading(model: DiagramModel): string[] {
  return (model.leading ?? []).map((item) => item.line);
}

function isSequenceOpeningBlock(kind: SequenceBlock["kind"]): boolean {
  return kind !== "else" && kind !== "end";
}

function formatCardinality(value: string | undefined): string {
  return value ? ` "${escapeLabel(value)}"` : "";
}

function linesOf(input: string): string[] {
  return normalizeMermaidInput(input)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function makePreserved(line: string, reason: string): PreservedSyntax {
  return {
    id: `preserved-${Math.random().toString(36).slice(2, 10)}`,
    line,
    reason,
  };
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, "#quot;");
}

function cleanLabel(label: string): string {
  return label
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/#quot;/g, '"');
}

function normalizeArrow(arrow: string): FlowEdge["arrow"] {
  return (arrow === "-.-?>" ? "-.->" : arrow) as FlowEdge["arrow"];
}

function looksMalformedFlow(line: string): boolean {
  const bracketCount = (line.match(/[[\]{}()]/g) ?? []).length;
  return /-->|---|==>|-\.-?>|--[ox]|<-->/.test(line) || bracketCount % 2 !== 0;
}

function fromMermaidShape(shape: string): NodeShape {
  const normalized = shape.toLowerCase();
  const map: Record<string, NodeShape> = {
    rect: "rectangle",
    rounded: "rounded",
    stadium: "stadium",
    subroutine: "subroutine",
    cyl: "cylinder",
    cylinder: "cylinder",
    circle: "circle",
    dblcircle: "double-circle",
    diamond: "diamond",
    hex: "hexagon",
    lean_r: "parallelogram",
    lean_l: "parallelogram-alt",
    trap_b: "trapezoid",
    trap_t: "trapezoid-alt",
    asymmetric: "asymmetric",
    docs: "docs",
    lin_docs: "lin-docs",
  };
  return map[normalized] ?? "rectangle";
}

function toMermaidShape(shape: NodeShape): string {
  const map: Record<NodeShape, string> = {
    rectangle: "rect",
    rounded: "rounded",
    stadium: "stadium",
    subroutine: "subroutine",
    cylinder: "cyl",
    circle: "circle",
    "double-circle": "dblcircle",
    diamond: "diamond",
    hexagon: "hex",
    parallelogram: "lean_r",
    "parallelogram-alt": "lean_l",
    trapezoid: "trap_b",
    "trapezoid-alt": "trap_t",
    asymmetric: "asymmetric",
    docs: "docs",
    "lin-docs": "lin_docs",
  };
  return map[shape];
}
