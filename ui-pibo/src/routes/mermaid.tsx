import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import MermaidEditorApp from "#/features/mermaid/MermaidEditorApp";
import mermaidEditorCss from "#/features/mermaid/mermaidEditor.css?url";

export const Route = createFileRoute("/mermaid")({
  head: () => ({
    meta: [
      {
        title: "Mermaid Editor | PIBo",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: mermaidEditorCss,
      },
    ],
  }),
  component: MermaidPage,
});

function MermaidPage() {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  return (
    <main className="mermaid-editor-module">
      {isClient ? (
        <MermaidEditorApp />
      ) : (
        <div className="app-shell">
          <header className="topbar">
            <div>
              <h1>Mermaid Editor</h1>
              <p>Loading editor workspace...</p>
            </div>
          </header>
        </div>
      )}
    </main>
  );
}
