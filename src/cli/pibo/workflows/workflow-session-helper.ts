import { loadSessionEntry } from "../../../gateway/session-utils.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import type { WorkflowRunSessions } from "./types.js";
import { callWorkflowGatewayMethod } from "./workflow-gateway.js";

export type WorkflowSessionPolicy = "ephemeral" | "reusable" | "sticky" | "reset-on-reuse";

type WorkflowRoleSessionSpec = {
  role: "worker" | "critic" | "orchestrator";
  agentId: string;
  label: string;
  name?: string;
  model?: string;
  parentSessionKey?: string;
  policy?: WorkflowSessionPolicy;
};

type WorkflowSessionLifecycleDecision = {
  shouldCreate: boolean;
  shouldResetBeforeRun: boolean;
};

function normalizeSessionSegment(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "");
}

function decideWorkflowSessionLifecycle(params: {
  exists: boolean;
  policy: WorkflowSessionPolicy;
}): WorkflowSessionLifecycleDecision {
  const { exists, policy } = params;
  switch (policy) {
    case "reset-on-reuse":
      return { shouldCreate: !exists, shouldResetBeforeRun: exists };
    case "ephemeral":
    case "sticky":
    case "reusable":
    default:
      return { shouldCreate: !exists, shouldResetBeforeRun: false };
  }
}

function buildAgentScopedSessionKey(params: { agentId: string; path: string[] }): string {
  const agentId = normalizeAgentId(params.agentId);
  const path = params.path
    .map((segment) => normalizeSessionSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  if (path.length === 0) {
    throw new Error("workflow session path is required");
  }
  return ["agent", agentId, ...path].join(":");
}

export function buildWorkflowSessionKey(params: {
  agentId: string;
  runId: string;
  role: string;
  name?: string;
}): string {
  return buildAgentScopedSessionKey({
    agentId: params.agentId,
    path: ["workflow", params.runId, params.role, params.name ?? "main"],
  });
}

export function buildAcpWorkflowSessionKey(params: {
  agentId: string;
  runId: string;
  role: string;
  name?: string;
}): string {
  return buildAgentScopedSessionKey({
    agentId: params.agentId,
    path: ["acp", "workflow", params.runId, params.role, params.name ?? "main"],
  });
}

function workflowSessionExists(key: string): boolean {
  try {
    return Boolean(loadSessionEntry(key).entry?.sessionId);
  } catch {
    return false;
  }
}

export async function ensureWorkflowSessions(params: {
  runId: string;
  specs: WorkflowRoleSessionSpec[];
}): Promise<WorkflowRunSessions> {
  const sessions: WorkflowRunSessions = {};

  for (const spec of params.specs) {
    const key = buildWorkflowSessionKey({
      runId: params.runId,
      role: spec.role,
      name: spec.name,
      agentId: spec.agentId,
    });
    const policy = spec.policy ?? "reusable";
    const lifecycle = decideWorkflowSessionLifecycle({
      exists: workflowSessionExists(key),
      policy,
    });

    if (lifecycle.shouldCreate) {
      await callWorkflowGatewayMethod("sessions.create", {
        key,
        agentId: spec.agentId,
        label: spec.label,
        ...(typeof spec.model === "string" && spec.model.trim() ? { model: spec.model } : {}),
        ...(typeof spec.parentSessionKey === "string" && spec.parentSessionKey.trim()
          ? { parentSessionKey: spec.parentSessionKey }
          : {}),
      });
    }

    if (lifecycle.shouldResetBeforeRun) {
      await callWorkflowGatewayMethod("sessions.reset", {
        key,
        reason: "reset",
      });
    }

    if (spec.role === "worker") {
      sessions.worker = key;
      continue;
    }
    if (spec.role === "critic") {
      sessions.critic = key;
      continue;
    }
    sessions.orchestrator = key;
  }

  return sessions;
}
