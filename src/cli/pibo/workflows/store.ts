import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { WorkflowRunRecord } from "./types.js";

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function workflowsStateDir() {
  return path.join(homedir(), ".local", "state", "pibo-workflows");
}

export function workflowRunsDir() {
  return path.join(workflowsStateDir(), "runs");
}

export function workflowArtifactsDir(runId: string) {
  return path.join(workflowsStateDir(), "artifacts", runId);
}

export function workflowRunPath(runId: string) {
  return path.join(workflowRunsDir(), `${runId}.json`);
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
