import { describe, expect, it } from "vitest";
import {
  DIAGRAM_REGISTRY,
  detectDiagramKind,
  exportMermaid,
  parseClass,
  parseEr,
  parseFlowchart,
  parseMermaidInput,
  parseSequence,
  parseState,
} from "./mermaidAdapter";

describe("diagram registry", () => {
  it("detects every registered Mermaid diagram kind from its starter example", () => {
    for (const definition of DIAGRAM_REGISTRY) {
      expect(detectDiagramKind(definition.starter), definition.kind).toBe(definition.kind);
    }
  });

  it("roundtrips every registered diagram without dropping modeled or preserved lines", () => {
    for (const definition of DIAGRAM_REGISTRY) {
      const model = parseMermaidInput(`${definition.starter}\n  %% preserved comment`);
      const exported = exportMermaid(model);
      expect(exported, definition.kind).toContain("%% preserved comment");
      expect(detectDiagramKind(exported), definition.kind).toBe(definition.kind);
    }
  });
});

describe("flowchart adapter", () => {
  it("imports nodes, edges, expanded shapes, subgraphs, and preserved styling", () => {
    const model = parseFlowchart(`
      flowchart LR
        subgraph Core
          A[Start] --> B{Ready?}
          B --> C@{ shape: cyl, label: "Store" }
        end
        C -.-> D(((Done)))
        classDef accent fill:#f9f,stroke:#333
    `);

    expect(model.direction).toBe("LR");
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].nodeIds).toEqual(expect.arrayContaining(["A", "B", "C"]));
    expect(model.nodes.find((node) => node.id === "C")?.shape).toBe("cylinder");
    expect(model.nodes.find((node) => node.id === "D")?.shape).toBe("double-circle");
    expect(model.edges).toHaveLength(3);
    expect(model.preserved[0].line).toContain("classDef accent");
    expect(exportMermaid(model)).toContain("subgraph Core");
    expect(exportMermaid(model)).toContain("classDef accent");
  });

  it("throws a useful error for malformed flowchart edges", () => {
    expect(() =>
      parseFlowchart(`
        flowchart TD
          A[Start] -->
      `),
    ).toThrow(/Could not parse flowchart line/);
  });
});

describe("major structured adapters", () => {
  it("imports and exports sequence participants, messages, notes, and blocks", () => {
    const model = parseSequence(`
      sequenceDiagram
        participant Alice
        actor Bob
        loop retry
        Alice->>Bob: Hi
        Note over Alice,Bob: Shared note
    `);

    expect(model.participants).toHaveLength(2);
    expect(model.messages[0]).toMatchObject({
      from: "Alice",
      to: "Bob",
      label: "Hi",
    });
    expect(model.blocks[0]).toMatchObject({ kind: "loop", label: "retry" });
    expect(exportMermaid(model)).toContain("Note over Alice,Bob: Shared note");
  });

  it("preserves ordered sequence fragments, activations, notes, and message activation suffixes", () => {
    const model = parseSequence(`
      sequenceDiagram
        participant Alice
        participant Bob
        loop retry
        Alice->>+Bob: Request
        activate Bob
        Note right of Bob: Working
        Bob-->>-Alice: Done
        deactivate Bob
        end
    `);

    expect(model.steps.map((step) => step.type)).toEqual([
      "block",
      "message",
      "activation",
      "note",
      "message",
      "activation",
      "block",
    ]);
    expect(model.messages[0]).toMatchObject({ activateTarget: true });
    expect(model.messages[1]).toMatchObject({ deactivateTarget: true });
    expect(model.activations).toHaveLength(2);
    expect(exportMermaid(model)).toContain(`loop retry
  Alice->>+Bob: Request
  activate Bob
  Note right of Bob: Working
  Bob-->>-Alice: Done
  deactivate Bob
  end`);
  });

  it("exports an added sequence fragment as a paired block when no end step exists", () => {
    const model = parseSequence(`
      sequenceDiagram
        participant Alice
        loop retry
        Alice->>Alice: Try again
    `);

    expect(exportMermaid(model)).toContain(`loop retry
  Alice->>Alice: Try again
  end`);
  });

  it("imports and exports classes, members, stereotypes, and relationships", () => {
    const model = parseClass(`
      classDiagram
        class Order {
          +string id
          +total()
        }
        <<Service>> Order
        Customer --> Order : places
    `);

    expect(model.classes.find((item) => item.name === "Order")?.members).toHaveLength(2);
    expect(model.classes.find((item) => item.name === "Order")?.stereotype).toBe("Service");
    expect(model.relations[0]).toMatchObject({
      from: "Customer",
      to: "Order",
      label: "places",
    });
    expect(exportMermaid(model)).toContain("Customer --> Order : places");
  });

  it("roundtrips class relationship cardinalities without dropping them", () => {
    const model = parseClass(`
      classDiagram
        class Order {
          +string id
        }
        class Customer {
          +string name
        }
        Customer "1" --> "*" Order : places
    `);

    expect(model.relations[0]).toMatchObject({
      fromCardinality: "1",
      toCardinality: "*",
      label: "places",
    });
    expect(exportMermaid(model)).toContain('Customer "1" --> "*" Order : places');
  });

  it("imports and exports state transitions including start and end states", () => {
    const model = parseState(`
      stateDiagram-v2
        [*] --> Idle
        Idle --> Running: start
        Running --> [*]: done
    `);

    expect(model.states.map((state) => state.id)).toEqual(
      expect.arrayContaining(["Idle", "Running"]),
    );
    expect(model.transitions).toHaveLength(3);
    expect(exportMermaid(model)).toContain("Idle --> Running: start");
  });

  it("imports and exports ER entities, attributes, and relationships", () => {
    const model = parseEr(`
      erDiagram
        CUSTOMER {
          string id PK "identifier"
          string name
        }
        ORDER {
          string id PK
        }
        CUSTOMER ||--o{ ORDER : places
    `);

    expect(
      model.entities.find((entity) => entity.name === "CUSTOMER")?.attributes[0],
    ).toMatchObject({ type: "string", name: "id", key: "PK" });
    expect(model.relationships[0]).toMatchObject({
      from: "CUSTOMER",
      to: "ORDER",
      cardinality: "||--o{",
      label: "places",
    });
    expect(exportMermaid(model)).toContain("CUSTOMER ||--o{ ORDER : places");
  });
});

describe("diagnostics and preservation", () => {
  it("normalizes markdown fenced Mermaid before parsing", () => {
    const model = parseMermaidInput(`
      \`\`\`mermaid
      pie showData
        "A" : 1
      \`\`\`
    `);

    expect(model.type).toBe("generic");
    expect(exportMermaid(model)).toContain('"A" : 1');
  });

  it("rejects unknown diagram headers with an actionable message", () => {
    expect(() => parseMermaidInput("notMermaid\n  A --> B")).toThrow(
      /supported Mermaid diagram type/,
    );
  });

  it("accepts and preserves leading Mermaid directives before the header", () => {
    const model = parseMermaidInput(`
      %%{init: {'theme': 'dark'}}%%
      %% leading note
      flowchart TD
        A[Start] --> B[Done]
    `);

    const exported = exportMermaid(model);
    expect(model.type).toBe("flowchart");
    expect(
      exported.startsWith("%%{init: {'theme': 'dark'}}%%\n%% leading note\nflowchart TD"),
    ).toBe(true);
    expect(exported).toContain("A --> B");
  });

  it("uses the Mermaid 11 xychart header in the XY Chart starter", () => {
    const xy = DIAGRAM_REGISTRY.find((definition) => definition.kind === "xyChart-beta");

    expect(xy?.starter).toMatch(/^xychart-beta/);
    expect(detectDiagramKind(xy?.starter ?? "")).toBe("xyChart-beta");
  });
});
