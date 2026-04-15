import fs from "node:fs/promises";
import path from "node:path";
import { listAgentEntries, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  ensureCodexWorkspaceSkillsSymlink,
  type CodexWorkspaceSkillsSymlinkStatus,
} from "../agents/workspace.js";
import { type RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { shortenHomePath } from "../utils.js";
import { requireValidConfig } from "./agents.command-shared.js";

export type AgentsRepairSummary = {
  created: number;
  repaired: number;
  alreadyCorrect: number;
  skippedMissing: number;
  failed: number;
};

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

function listConfiguredAgentWorkspaces(
  cfg: Parameters<typeof resolveAgentWorkspaceDir>[0],
): string[] {
  const entries = listAgentEntries(cfg);
  const ids =
    entries.length > 0
      ? entries.map((entry) => normalizeAgentId(entry.id))
      : [normalizeAgentId(resolveDefaultAgentId(cfg))];
  const seen = new Set<string>();
  const workspaces: string[] = [];

  for (const id of ids) {
    const workspace = path.resolve(resolveAgentWorkspaceDir(cfg, id));
    if (seen.has(workspace)) {
      continue;
    }
    seen.add(workspace);
    workspaces.push(workspace);
  }

  return workspaces;
}

function formatRepairSummary(summary: AgentsRepairSummary): string {
  const parts = [
    `created ${summary.created}`,
    `repaired ${summary.repaired}`,
    `already correct ${summary.alreadyCorrect}`,
  ];
  if (summary.skippedMissing > 0) {
    parts.push(`skipped missing ${summary.skippedMissing}`);
  }
  return `Codex skills symlink: ${parts.join(", ")}.`;
}

function applyStatusCount(
  summary: AgentsRepairSummary,
  status: CodexWorkspaceSkillsSymlinkStatus,
): void {
  if (status === "created") {
    summary.created += 1;
    return;
  }
  if (status === "repaired") {
    summary.repaired += 1;
    return;
  }
  summary.alreadyCorrect += 1;
}

export async function agentsRepairCommand(runtime: RuntimeEnv = defaultRuntime) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const summary: AgentsRepairSummary = {
    created: 0,
    repaired: 0,
    alreadyCorrect: 0,
    skippedMissing: 0,
    failed: 0,
  };
  const failures: string[] = [];

  for (const workspace of listConfiguredAgentWorkspaces(cfg)) {
    if (!(await pathExists(workspace))) {
      summary.skippedMissing += 1;
      continue;
    }
    try {
      applyStatusCount(summary, await ensureCodexWorkspaceSkillsSymlink(workspace));
    } catch (err) {
      summary.failed += 1;
      failures.push(`${shortenHomePath(workspace)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  runtime.log(formatRepairSummary(summary));

  if (failures.length > 0) {
    runtime.error(
      [
        `Failed to repair Codex skills symlink in ${failures.length} workspace${failures.length === 1 ? "" : "s"}:`,
        ...failures.map((entry) => `- ${entry}`),
      ].join("\n"),
    );
    runtime.exit(1);
  }

  return summary;
}
