import Prism from "prismjs";

type PrismStatic = typeof import("prismjs").default;

declare global {
  interface Window {
    Prism?: PrismStatic;
  }

  var Prism: PrismStatic | undefined;
}

function hasPrismCore(value: unknown): value is PrismStatic {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "languages" in value && typeof value.languages === "object" && value.languages !== null;
}

const prism = hasPrismCore(globalThis.Prism) ? globalThis.Prism : Prism;

globalThis.Prism = prism;

if (typeof window !== "undefined") {
  window.Prism = prism;
}

export default prism;
