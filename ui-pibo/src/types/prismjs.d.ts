declare module "prismjs" {
  type PrismLanguage = Record<string, unknown>;

  interface PrismStatic {
    Token: unknown;
    disableWorkerMessageHandler: () => void;
    highlight: (...args: unknown[]) => string;
    highlightAll: (...args: unknown[]) => void;
    highlightAllUnder: (...args: unknown[]) => void;
    highlightElement: (...args: unknown[]) => void;
    hooks: Record<string, unknown>;
    languages: Record<string, PrismLanguage>;
    manual: boolean;
    plugins: Record<string, unknown>;
    tokenize: (...args: unknown[]) => unknown[];
    util: Record<string, unknown>;
  }

  const Prism: PrismStatic;
  export default Prism;
}
