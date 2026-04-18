import type { WorkflowModule } from "../types.js";
import { codexControllerWorkflowModule } from "./codex-controller.js";
import { langgraphWorkerCriticModule } from "./langgraph-worker-critic.js";
import { noopWorkflowModule } from "./noop.js";
import { selfRalphWorkflowModule } from "./self-ralph.js";

const modules = [
  noopWorkflowModule,
  langgraphWorkerCriticModule,
  codexControllerWorkflowModule,
  selfRalphWorkflowModule,
] as const;

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
