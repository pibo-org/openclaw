import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  WorkflowRunRecord,
  WorkflowWorktreeBinding,
  WorkflowWorktreeSentinel,
} from "./types.js";

export const WORKFLOW_WORKTREE_SENTINEL_FILENAME = ".openclaw-workflow.json";

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function workflowsStateDir() {
  const homeDir = process.env.HOME?.trim() || homedir();
  const stateRoot = process.env.XDG_STATE_HOME?.trim() || path.join(homeDir, ".local", "state");
  return path.join(stateRoot, "pibo-workflows");
}

export function workflowRunsDir() {
  return path.join(workflowsStateDir(), "runs");
}

export function workflowArtifactsDir(runId: string) {
  return path.join(workflowsStateDir(), "artifacts", runId);
}

export function workflowOwnedWorktreesDir() {
  return path.join(workflowsStateDir(), "worktrees");
}

export function workflowWorktreeBindingsDir() {
  return path.join(workflowsStateDir(), "worktree-bindings");
}

export function workflowRunPath(runId: string) {
  return path.join(workflowRunsDir(), `${runId}.json`);
}

export function workflowWorktreeBindingPath(runId: string) {
  return path.join(workflowWorktreeBindingsDir(), `${runId}.json`);
}

export function workflowArtifactPath(runId: string, filename: string) {
  return path.join(workflowArtifactsDir(runId), filename);
}

export function workflowTraceEventLogPath(runId: string) {
  return workflowArtifactPath(runId, "trace.jsonl");
}

export function workflowTraceSummaryPath(runId: string) {
  return workflowArtifactPath(runId, "trace.summary.json");
}

export function writeWorkflowArtifact(runId: string, filename: string, content: string) {
  ensureDir(workflowArtifactsDir(runId));
  const fullPath = workflowArtifactPath(runId, filename);
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

export function writeRunRecord(record: WorkflowRunRecord) {
  ensureDir(workflowRunsDir());
  fs.writeFileSync(workflowRunPath(record.runId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function readRunRecord(runId: string): WorkflowRunRecord | null {
  const filePath = workflowRunPath(runId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkflowRunRecord;
}

export function listRunRecords(): WorkflowRunRecord[] {
  ensureDir(workflowRunsDir());
  return fs
    .readdirSync(workflowRunsDir())
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(
          fs.readFileSync(path.join(workflowRunsDir(), name), "utf8"),
        ) as WorkflowRunRecord,
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function writeWorkflowWorktreeBinding(binding: WorkflowWorktreeBinding) {
  ensureDir(workflowWorktreeBindingsDir());
  fs.writeFileSync(
    workflowWorktreeBindingPath(binding.runId),
    `${JSON.stringify(binding, null, 2)}\n`,
    "utf8",
  );
}

export function readWorkflowWorktreeBinding(runId: string): WorkflowWorktreeBinding | null {
  const filePath = workflowWorktreeBindingPath(runId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkflowWorktreeBinding;
}

export function listWorkflowWorktreeBindings(): WorkflowWorktreeBinding[] {
  ensureDir(workflowWorktreeBindingsDir());
  return fs
    .readdirSync(workflowWorktreeBindingsDir())
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(
          fs.readFileSync(path.join(workflowWorktreeBindingsDir(), name), "utf8"),
        ) as WorkflowWorktreeBinding,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function pathMatchesBinding(candidatePath: string, bindingPath?: string) {
  if (!bindingPath) {
    return false;
  }
  const candidate = path.resolve(candidatePath);
  const owner = path.resolve(bindingPath);
  return candidate === owner || candidate.startsWith(`${owner}${path.sep}`);
}

export function findWorkflowWorktreeBindingByPath(
  targetPath: string,
): WorkflowWorktreeBinding | null {
  return (
    listWorkflowWorktreeBindings().find(
      (binding) =>
        pathMatchesBinding(targetPath, binding.worktreePath) ||
        pathMatchesBinding(targetPath, binding.integrationWorktreePath),
    ) ?? null
  );
}

export function writeWorkflowWorktreeSentinelFile(
  worktreePath: string,
  sentinel: WorkflowWorktreeSentinel,
) {
  fs.writeFileSync(
    path.join(worktreePath, WORKFLOW_WORKTREE_SENTINEL_FILENAME),
    `${JSON.stringify(sentinel, null, 2)}\n`,
    "utf8",
  );
}

export function readWorkflowWorktreeSentinelFile(
  worktreePath: string,
): WorkflowWorktreeSentinel | null {
  const sentinelPath = path.join(worktreePath, WORKFLOW_WORKTREE_SENTINEL_FILENAME);
  if (!fs.existsSync(sentinelPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as WorkflowWorktreeSentinel;
}

export function findWorkflowWorktreeSentinelByPath(targetPath: string): {
  sentinel: WorkflowWorktreeSentinel;
  sentinelPath: string;
} | null {
  let cursor = path.resolve(targetPath);
  if (fs.existsSync(cursor) && !fs.statSync(cursor).isDirectory()) {
    cursor = path.dirname(cursor);
  }
  for (;;) {
    const sentinelPath = path.join(cursor, WORKFLOW_WORKTREE_SENTINEL_FILENAME);
    if (fs.existsSync(sentinelPath)) {
      return {
        sentinel: JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as WorkflowWorktreeSentinel,
        sentinelPath,
      };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}
