import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PIBO_MODULES } from "#/lib/modules";

const styles = readFileSync(`${process.cwd()}/src/features/mermaid/mermaidEditor.css`, "utf8");

describe("Mermaid Editor integration", () => {
  it("registers the Mermaid module in the PIBo module menu", () => {
    expect(PIBO_MODULES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/mermaid",
          id: "mermaid",
          runtime: "ui-pibo",
          status: "live",
        }),
      ]),
    );
  });

  it("keeps Mermaid editor styles scoped and mobile friendly", () => {
    expect(styles).toContain(".mermaid-editor-module .app-shell");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(styles).toContain("max-width: 100vw");
  });
});
