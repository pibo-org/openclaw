import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CliStartupMetadata = {
  rootHelpText?: unknown;
  piboHelpText?: unknown;
};

let cachedStartupMetadata: CliStartupMetadata | null | undefined;

function getStartupMetadataCandidatePaths(moduleUrl: string = import.meta.url): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.resolve(moduleDir, "cli-startup-metadata.json"),
    path.resolve(moduleDir, "..", "cli-startup-metadata.json"),
    path.resolve(moduleDir, "..", "..", "dist", "cli-startup-metadata.json"),
  ];
}

function loadStartupMetadata(): CliStartupMetadata | null {
  if (cachedStartupMetadata !== undefined) {
    return cachedStartupMetadata;
  }

  for (const metadataPath of getStartupMetadataCandidatePaths()) {
    try {
      const raw = fs.readFileSync(metadataPath, "utf8");
      cachedStartupMetadata = JSON.parse(raw) as CliStartupMetadata;
      return cachedStartupMetadata;
    } catch {
      // Try the next candidate path.
    }
  }

  cachedStartupMetadata = null;
  return cachedStartupMetadata;
}

function loadPrecomputedHelpText(key: "rootHelpText" | "piboHelpText"): string | null {
  const metadata = loadStartupMetadata();
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function loadPrecomputedRootHelpText(): string | null {
  return loadPrecomputedHelpText("rootHelpText");
}

export function outputPrecomputedRootHelpText(): boolean {
  const rootHelpText = loadPrecomputedRootHelpText();
  if (!rootHelpText) {
    return false;
  }
  process.stdout.write(rootHelpText);
  return true;
}

export function loadPrecomputedPiboHelpText(): string | null {
  return loadPrecomputedHelpText("piboHelpText");
}

export function outputPrecomputedPiboHelpText(): boolean {
  const piboHelpText = loadPrecomputedPiboHelpText();
  if (!piboHelpText) {
    return false;
  }
  process.stdout.write(piboHelpText);
  return true;
}

export const __testing = {
  getStartupMetadataCandidatePathsForTests(moduleUrl: string): string[] {
    return getStartupMetadataCandidatePaths(moduleUrl);
  },
  resetPrecomputedHelpTextCacheForTests(): void {
    cachedStartupMetadata = undefined;
  },
};
