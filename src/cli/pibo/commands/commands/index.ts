import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface PromptCommandEntry {
  name: string;
  file: string;
  description: string;
  contentPreview: string;
}

export interface PromptCommandRegistry {
  commandDir: string;
  commands: Record<string, PromptCommandEntry>;
  scannedAt: string;
}

interface PromptCommandConfig {
  commandDir: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "pibo");
const CONFIG_PATH = path.join(CONFIG_DIR, "commands.json");
const DEFAULT_COMMAND_DIR = path.join(os.homedir(), ".config", "pibo", "commands");

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function ensureCommandDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureConfigDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function loadConfig(): PromptCommandConfig {
  const existing = readJsonFile<Partial<PromptCommandRegistry> & Partial<PromptCommandConfig>>(CONFIG_PATH);
  const commandDir = existing?.commandDir || DEFAULT_COMMAND_DIR;
  return { commandDir };
}

function saveConfig(config: PromptCommandConfig): void {
  writeJsonFile(CONFIG_PATH, config);
}

export function loadRegistry(): PromptCommandRegistry {
  const config = loadConfig();
  return buildRegistry(config.commandDir);
}

export function setCommandDir(dirInput: string): PromptCommandRegistry {
  const dir = path.resolve(dirInput.replace(/^~(?=$|\/)/, os.homedir()));
  ensureCommandDir(dir);
  saveConfig({ commandDir: dir });
  return buildRegistry(dir);
}

function extractFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!match) return {};
  const obj: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (key) obj[key] = value;
  }
  return obj;
}

function extractDescription(markdown: string): string {
  const fm = extractFrontmatter(markdown);
  if (fm.description) return fm.description.slice(0, 160);
  const body = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*/m, "");
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    return line.slice(0, 160);
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

function toCommandName(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function buildRegistry(commandDir: string): PromptCommandRegistry {
  ensureCommandDir(commandDir);

  const files = fs
    .readdirSync(commandDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));

  const commands: Record<string, PromptCommandEntry> = {};

  for (const file of files) {
    const abs = path.join(commandDir, file.name);
    const markdown = fs.readFileSync(abs, "utf8");
    const name = toCommandName(file.name);
    if (!name) continue;
    commands[name] = {
      name,
      file: abs,
      description: extractDescription(markdown),
      contentPreview: extractPreview(markdown),
    };
  }

  return {
    commandDir,
    commands,
    scannedAt: new Date().toISOString(),
  };
}

export function listCommands(): PromptCommandRegistry {
  return loadRegistry();
}

export function getCommandDir(): string {
  return loadConfig().commandDir;
}

export function getCommand(name: string): PromptCommandEntry | null {
  const registry = loadRegistry();
  return registry.commands[name] ?? null;
}

export function getCommandPrompt(name: string): { entry: PromptCommandEntry; content: string } | null {
  const entry = getCommand(name);
  if (!entry) return null;
  const content = fs.readFileSync(entry.file, "utf8");
  return { entry, content };
}

export function formatRegistrySummary(registry: PromptCommandRegistry): string {
  const names = Object.keys(registry.commands).sort();
  const lines: string[] = [];
  lines.push(`Command dir: ${registry.commandDir}`);
  lines.push(`Scan: ${registry.scannedAt}`);
  lines.push(`Anzahl: ${names.length}`);
  if (names.length > 0) {
    lines.push("");
    for (const name of names) {
      const entry = registry.commands[name];
      lines.push(`- ${name}: ${entry.description}`);
    }
  }
  return lines.join("\n");
}
