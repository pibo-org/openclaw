import fs from "node:fs";
import path from "node:path";
import { get_encoding } from "tiktoken";

const DEFAULT_MAX_TOKENS = 2000;
const TODO_FILENAME = "TODO.md";
const TOKENIZER_NAME = "cl100k_base";

const TODO_TEMPLATE = `# TODO.md

This file is the operational task list for this workspace.

## Rules
- Keep entries short and actionable.
- Prefer current, relevant tasks over historical clutter.
- Remove or rewrite stale items.
- Check token size regularly.
- If the list grows too large, compact it before adding more.
- Change a task's status in place instead of moving whole entries around.

## Status values
- active
- next
- waiting
- blocked
- someday
- done

## Tasks
| Status | Task |
| --- | --- |
| next | |
`;

const encoding = get_encoding(TOKENIZER_NAME);

function resolveWorkspaceDir(custom?: string) {
  return path.resolve(custom || process.cwd());
}

function resolveTodoPath(workspaceDir: string) {
  return path.join(workspaceDir, TODO_FILENAME);
}

function fileExists(filePath: string) {
  return fs.existsSync(filePath);
}

function readUtf8(filePath: string) {
  return fs.readFileSync(filePath, "utf8");
}

function writeUtf8(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, "utf8");
}

function countTokens(text: string) {
  if (!text.trim()) return 0;
  return encoding.encode(text).length;
}

function percent(value: number, max: number) {
  if (max <= 0) return "0%";
  return `${Math.round((value / max) * 100)}%`;
}

function normalizeStatus(raw: string) {
  return raw.trim().toLowerCase();
}

function parseTasks(content: string) {
  const lines = content.split(/\r?\n/);
  const tasks: Array<{ status: string; task: string }> = [];

  for (const line of lines) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (!match) continue;

    const status = normalizeStatus(match[1]);
    const task = match[2].trim();

    if (status === "status" || status === "---") continue;
    if (!task) continue;

    tasks.push({ status, task });
  }

  return tasks;
}

function summarizeTasks(tasks: Array<{ status: string; task: string }>) {
  const counts = new Map<string, number>();

  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) || 0) + 1);
  }

  return counts;
}

function readTodoState(opts: { workspace?: string; max?: number }) {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const todoPath = resolveTodoPath(workspaceDir);
  const max = opts.max ?? DEFAULT_MAX_TOKENS;
  const exists = fileExists(todoPath);
  const content = exists ? readUtf8(todoPath) : "";
  const tokens = exists ? countTokens(content) : 0;
  const tasks = exists ? parseTasks(content) : [];
  const statusCounts = summarizeTasks(tasks);

  return {
    workspaceDir,
    todoPath,
    max,
    exists,
    tokens,
    withinBudget: exists ? tokens <= max : false,
    tasks,
    statusCounts,
  };
}

export async function todoInit(opts: { workspace?: string }) {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const todoPath = resolveTodoPath(workspaceDir);

  if (fileExists(todoPath)) {
    console.log(`⚠️ ${TODO_FILENAME} existiert bereits: ${todoPath}`);
    return;
  }

  writeUtf8(todoPath, TODO_TEMPLATE);
  console.log(`✅ ${TODO_FILENAME} erstellt: ${todoPath}`);
}

export function todoTokens(opts: { workspace?: string; max?: number }) {
  const state = readTodoState(opts);
  if (!state.exists) {
    console.error(`TODO.md nicht gefunden: ${state.todoPath}`);
    process.exit(1);
  }
  console.log(`Datei: ${state.todoPath}`);
  console.log(`Tokenizer: ${TOKENIZER_NAME}`);
  console.log(`Tokens: ${state.tokens}`);
  console.log(`Limit: ${state.max}`);
  console.log(`Auslastung: ${percent(state.tokens, state.max)}`);
}

export function todoCheck(opts: { workspace?: string; max?: number }) {
  const state = readTodoState(opts);
  if (!state.exists) {
    console.error(`TODO.md nicht gefunden: ${state.todoPath}`);
    process.exit(1);
  }
  if (!state.withinBudget) {
    console.error(`TODO.md exceeds token budget: ${state.tokens} > ${state.max}. Compact or rewrite the list before continuing.`);
    process.exit(1);
  }
  console.log(`OK: TODO.md is within token budget (${state.tokens}/${state.max}).`);
}

export function todoStatus(opts: { workspace?: string; max?: number }) {
  const state = readTodoState(opts);
  console.log(`Workspace: ${state.workspaceDir}`);
  console.log(`TODO.md: ${state.todoPath}`);
  console.log(`Exists: ${state.exists ? "yes" : "no"}`);
  console.log(`Tokenizer: ${TOKENIZER_NAME}`);
  console.log(`Tokens: ${state.tokens}`);
  console.log(`Limit: ${state.max}`);
  console.log(`Within budget: ${state.withinBudget ? "yes" : "no"}`);

  if (!state.exists) return;

  console.log(`Tasks: ${state.tasks.length}`);
  if (state.statusCounts.size === 0) {
    console.log("Status counts: none");
    return;
  }

  console.log("Status counts:");
  for (const [status, count] of [...state.statusCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`- ${status}: ${count}`);
  }
}

export { DEFAULT_MAX_TOKENS, TOKENIZER_NAME };
