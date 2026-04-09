import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface LocalSyncTarget {
  name: string;
  path: string;
  repo: string;
  branch: string;
  enabled: boolean;
  ignoreGlobs: string[];
  serviceName: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalSyncRegistry {
  version: string;
  createdAt: string;
  updatedAt: string;
  targets: LocalSyncTarget[];
}

const CONFIG_PATH = join(homedir(), ".config", "pibo-local-sync.json");

function defaultRegistry(): LocalSyncRegistry {
  const now = new Date().toISOString();
  return {
    version: "0.1.0",
    createdAt: now,
    updatedAt: now,
    targets: [],
  };
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function readRegistry(): LocalSyncRegistry {
  if (!existsSync(CONFIG_PATH)) {
    return defaultRegistry();
  }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LocalSyncRegistry;
    return {
      version: parsed.version || "0.1.0",
      createdAt: parsed.createdAt || new Date().toISOString(),
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      targets: Array.isArray(parsed.targets) ? parsed.targets : [],
    };
  } catch {
    return defaultRegistry();
  }
}

export function writeRegistry(registry: LocalSyncRegistry) {
  registry.updatedAt = new Date().toISOString();
  mkdirSync(join(homedir(), ".config"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(registry, null, 2));
}

export function getTarget(name: string): LocalSyncTarget | undefined {
  return readRegistry().targets.find((t) => t.name === name);
}

export function upsertTarget(target: LocalSyncTarget) {
  const registry = readRegistry();
  const idx = registry.targets.findIndex((t) => t.name === target.name);
  if (idx >= 0) {
    registry.targets[idx] = target;
  } else {
    registry.targets.push(target);
  }
  writeRegistry(registry);
}

export function removeTarget(name: string): LocalSyncTarget | null {
  const registry = readRegistry();
  const idx = registry.targets.findIndex((t) => t.name === name);
  if (idx < 0) {
    return null;
  }
  const [removed] = registry.targets.splice(idx, 1);
  writeRegistry(registry);
  return removed;
}
