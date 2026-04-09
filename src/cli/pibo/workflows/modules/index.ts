import type { WorkflowModule } from "../types.js";
import { langgraphWorkerCriticModule } from "./langgraph-worker-critic.js";
import { noopWorkflowModule } from "./noop.js";

const modules = [noopWorkflowModule, langgraphWorkerCriticModule] as const;

const moduleMap = new Map<string, WorkflowModule>(
  modules.map((entry) => [entry.manifest.moduleId, entry]),
);

export function listWorkflowModules(): WorkflowModule[] {
  return [...moduleMap.values()].toSorted((left, right) =>
    left.manifest.moduleId.localeCompare(right.manifest.moduleId),
  );
}

export function getWorkflowModule(moduleId: string): WorkflowModule | undefined {
  return moduleMap.get(moduleId);
}
