import { createRuntimeManagedSessions } from "../../../plugins/runtime/runtime-managed-sessions.js";
import type { ManagedSessionPolicy } from "../../../plugins/runtime/types.js";
import type { WorkflowRunSessions } from "./types.js";

type WorkflowRoleSessionSpec = {
  role: "worker" | "critic" | "orchestrator";
  agentId: string;
  label: string;
  name?: string;
  model?: string;
  parentSessionKey?: string;
  policy?: ManagedSessionPolicy;
};

const unavailableSubagent = {
  async run() {
    throw new Error("workflow managed-session adapter cannot run subagents directly");
  },
  async waitForRun() {
    throw new Error("workflow managed-session adapter cannot wait for subagents directly");
  },
  async getSessionMessages() {
    throw new Error("workflow managed-session adapter cannot read subagent messages directly");
  },
  async getSession() {
    throw new Error("workflow managed-session adapter cannot read subagent sessions directly");
  },
  async deleteSession() {
    throw new Error("workflow managed-session adapter cannot delete subagent sessions directly");
  },
};

const managedSessions = createRuntimeManagedSessions(unavailableSubagent);

export async function ensureWorkflowSessions(params: {
  runId: string;
  specs: WorkflowRoleSessionSpec[];
}): Promise<WorkflowRunSessions> {
  const sessions: WorkflowRunSessions = {};

  for (const spec of params.specs) {
    const ensured = await managedSessions.ensureWorkflowSession({
      flowId: params.runId,
      role: spec.role,
      name: spec.name,
      agentId: spec.agentId,
      label: spec.label,
      model: spec.model,
      parentSessionKey: spec.parentSessionKey,
      policy: spec.policy,
    });

    if (spec.role === "worker") {
      sessions.worker = ensured.key;
      continue;
    }
    if (spec.role === "critic") {
      sessions.critic = ensured.key;
      continue;
    }
    sessions.orchestrator = ensured.key;
  }

  return sessions;
}
