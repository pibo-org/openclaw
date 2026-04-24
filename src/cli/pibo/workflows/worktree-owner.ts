import path from "node:path";
import {
  findWorkflowWorktreeBindingByPath,
  findWorkflowWorktreeSentinelByPath,
  listWorkflowWorktreeBindings,
  readRunRecord,
  readWorkflowWorktreeBinding,
} from "./store.js";
import type {
  WorkflowRunRecord,
  WorkflowWorktreeBinding,
  WorkflowWorktreeOwnerClassification,
  WorkflowWorktreeSentinel,
} from "./types.js";

export type WorkflowWorktreeInspection = {
  query: string;
  classification: WorkflowWorktreeOwnerClassification;
  currentRunId: string | null;
  binding: WorkflowWorktreeBinding | null;
  sentinel: WorkflowWorktreeSentinel | null;
  sentinelPath: string | null;
  run: WorkflowRunRecord | null;
  reason: string;
};

function isTerminalStatus(status: WorkflowRunRecord["status"]) {
  return (
    status === "done" ||
    status === "planning_done" ||
    status === "blocked" ||
    status === "aborted" ||
    status === "failed" ||
    status === "max_rounds_reached"
  );
}

function classifyKnownWorkflowWorktree(params: {
  binding: WorkflowWorktreeBinding | null;
  sentinel: WorkflowWorktreeSentinel | null;
  run: WorkflowRunRecord | null;
  currentRunId?: string;
}): { classification: WorkflowWorktreeOwnerClassification; reason: string } {
  const ownerRunId = params.binding?.runId ?? params.sentinel?.runId;
  if (!ownerRunId) {
    return {
      classification: "unknown-worktree",
      reason: "Workflow sentinel/binding data is present but no runId could be resolved.",
    };
  }
  if (params.currentRunId && ownerRunId === params.currentRunId) {
    return {
      classification: "owned-by-current-run",
      reason: `Path is workflow-owned by current run ${ownerRunId}.`,
    };
  }
  if (!params.binding || !params.run) {
    return {
      classification: "unknown-worktree",
      reason: `Path appears workflow-owned by ${ownerRunId}, but its binding or run record is missing.`,
    };
  }
  if (isTerminalStatus(params.run.status)) {
    return {
      classification: "owned-by-terminal-run",
      reason: `Path is workflow-owned by terminal run ${ownerRunId} (${params.run.status}).`,
    };
  }
  return {
    classification: "owned-by-other-active-run",
    reason: `Path is workflow-owned by active run ${ownerRunId} (${params.run.status}).`,
  };
}

export function inspectWorkflowWorktreeOwner(
  query: string,
  opts: { currentRunId?: string } = {},
): WorkflowWorktreeInspection {
  const bindingByPath = findWorkflowWorktreeBindingByPath(query);
  const sentinelResult = findWorkflowWorktreeSentinelByPath(query);
  const sentinel = sentinelResult?.sentinel ?? null;
  const binding =
    bindingByPath ?? (sentinel?.runId ? readWorkflowWorktreeBinding(sentinel.runId) : null) ?? null;
  const runId = binding?.runId ?? sentinel?.runId ?? null;
  const run = runId ? readRunRecord(runId) : null;
  if (!binding && !sentinel) {
    return {
      query: path.resolve(query),
      classification: "not-a-workflow-worktree",
      currentRunId: opts.currentRunId ?? null,
      binding: null,
      sentinel: null,
      sentinelPath: null,
      run: null,
      reason: "No workflow binding or .openclaw-workflow.json sentinel was found for this path.",
    };
  }
  const { classification, reason } = classifyKnownWorkflowWorktree({
    binding,
    sentinel,
    run,
    currentRunId: opts.currentRunId,
  });
  return {
    query: path.resolve(query),
    classification,
    currentRunId: opts.currentRunId ?? null,
    binding,
    sentinel,
    sentinelPath: sentinelResult?.sentinelPath ?? null,
    run,
    reason,
  };
}

export function inspectWorkflowWorktreeByRunId(runId: string): WorkflowWorktreeInspection {
  const binding = readWorkflowWorktreeBinding(runId);
  const run = readRunRecord(runId);
  const query = binding?.worktreePath ?? runId;
  const sentinelResult = binding ? findWorkflowWorktreeSentinelByPath(binding.worktreePath) : null;
  const sentinel = sentinelResult?.sentinel ?? null;
  if (!binding && !run) {
    return {
      query,
      classification: "not-a-workflow-worktree",
      currentRunId: null,
      binding: null,
      sentinel,
      sentinelPath: sentinelResult?.sentinelPath ?? null,
      run: null,
      reason: `No workflow run or worktree binding was found for ${runId}.`,
    };
  }
  const { classification, reason } = classifyKnownWorkflowWorktree({
    binding,
    sentinel,
    run,
    currentRunId: runId,
  });
  return {
    query,
    classification,
    currentRunId: runId,
    binding,
    sentinel,
    sentinelPath: sentinelResult?.sentinelPath ?? null,
    run,
    reason,
  };
}

export function listKnownWorkflowWorktrees(
  opts: {
    status?: string;
    moduleId?: string;
    repo?: string;
    active?: boolean;
  } = {},
) {
  const repo = opts.repo ? path.resolve(opts.repo) : null;
  return listWorkflowWorktreeBindings().filter((binding) => {
    if (opts.status && binding.status !== opts.status) {
      return false;
    }
    if (opts.moduleId && binding.moduleId !== opts.moduleId) {
      return false;
    }
    if (repo && path.resolve(binding.sourceRepoRoot) !== repo) {
      return false;
    }
    if (opts.active && binding.status !== "active" && binding.status !== "integrating") {
      return false;
    }
    return true;
  });
}
