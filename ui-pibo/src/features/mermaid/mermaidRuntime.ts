type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;

export async function getMermaid(): Promise<MermaidApi> {
  if (typeof window === "undefined") {
    throw new Error("Mermaid rendering is only available in the browser.");
  }

  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "default",
    });
    return mermaid;
  });

  return mermaidPromise;
}
