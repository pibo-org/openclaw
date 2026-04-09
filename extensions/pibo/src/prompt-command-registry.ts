import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PromptCommandBehavior = "mode" | "execute" | "one-shot";

export type PromptCommandMeta = {
  title?: string;
  description?: string;
  behavior?: PromptCommandBehavior;
  confirmation?: string;
  native_name?: string;
};

export type PromptCommandEntry = {
  name: string;
  file: string;
  description: string;
  contentPreview: string;
  meta: PromptCommandMeta;
};

export type PromptCommandRegistry = {
  commandDir: string;
  commands: Record<string, PromptCommandEntry>;
  scannedAt: string;
};

type PromptCommandConfig = {
  commandDir: string;
};

const REGISTRY_PATH = path.join(os.homedir(), ".config", "pibo", "commands.json");
const DEFAULT_COMMAND_DIR = path.join(os.homedir(), ".config", "pibo", "commands");

function readConfig(): PromptCommandConfig | null {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<PromptCommandRegistry> & Partial<PromptCommandConfig>;
  return {
    commandDir: parsed.commandDir || DEFAULT_COMMAND_DIR,
  };
}

function extractFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!match) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function parseBehavior(raw: string | undefined): PromptCommandBehavior {
  switch (raw?.trim().toLowerCase()) {
    case "execute":
      return "execute";
    case "one-shot":
      return "one-shot";
    default:
      return "mode";
  }
}

function extractDescription(markdown: string): string {
  const frontmatter = extractFrontmatter(markdown);
  if (frontmatter.description) {
    return frontmatter.description.slice(0, 160);
  }
  const body = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*/m, "");
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("#")) {
      return line.slice(0, 160);
    }
  }
  return "Kein Beschreibungstext gefunden.";
}

function extractPreview(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" ")
    .slice(0, 280);
}

export function extractMeta(markdown: string): PromptCommandMeta {
  const frontmatter = extractFrontmatter(markdown);
  return {
    title: frontmatter.title,
    description: frontmatter.description,
    behavior: parseBehavior(frontmatter.behavior),
    confirmation: frontmatter.confirmation,
    native_name: frontmatter.native_name,
  };
}

export function toCommandName(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function buildRegistry(commandDir: string): PromptCommandRegistry {
  fs.mkdirSync(commandDir, { recursive: true });

  const commands: Record<string, PromptCommandEntry> = {};
  const files = fs
    .readdirSync(commandDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .toSorted((a, b) => a.name.localeCompare(b.name, "de"));

  for (const file of files) {
    const filePath = path.join(commandDir, file.name);
    const markdown = fs.readFileSync(filePath, "utf8");
    const name = toCommandName(file.name);
    if (!name) {
      continue;
    }
    commands[name] = {
      name,
      file: filePath,
      description: extractDescription(markdown),
      contentPreview: extractPreview(markdown),
      meta: extractMeta(markdown),
    };
  }

  return {
    commandDir,
    commands,
    scannedAt: new Date().toISOString(),
  };
}

export function loadRegistry(): PromptCommandRegistry {
  const config = readConfig();
  return buildRegistry(config?.commandDir || DEFAULT_COMMAND_DIR);
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/^\/+/, "");
}

export function listCommandAliases(name: string, meta: PromptCommandMeta): string[] {
  const aliases = new Set<string>();
  aliases.add(normalizeAlias(name));
  if (name.includes("-")) {
    aliases.add(name.replace(/-/g, "_"));
  }
  const nativeName = meta.native_name?.trim();
  if (nativeName) {
    aliases.add(normalizeAlias(nativeName));
    aliases.add(normalizeAlias(nativeName).replace(/_/g, "-"));
  }
  return [...aliases].filter(Boolean);
}

export function buildNativeNames(
  name: string,
  meta: PromptCommandMeta,
): { default?: string } | undefined {
  const alias = listCommandAliases(name, meta).find(
    (candidate) => candidate !== normalizeAlias(name),
  );
  return alias ? { default: alias } : undefined;
}
