import {
  abortWorkflowRun,
  describeWorkflowModule,
  getWorkflowRunStatus,
  listWorkflowModuleManifests,
  listWorkflowRuns,
  startWorkflowRun,
} from "../../cli/pibo/workflows/index.js";
import type { WorkflowRunRecord, WorkflowStartRequest } from "../../cli/pibo/workflows/types.js";

export function createRuntimePiboWorkflows() {
  return {
    async list() {
      return listWorkflowModuleManifests();
    },
    async describe(moduleId: string) {
      return describeWorkflowModule(moduleId);
    },
    async start(moduleId: string, request: WorkflowStartRequest): Promise<WorkflowRunRecord> {
      return await startWorkflowRun(moduleId, request);
    },
    async status(runId: string): Promise<WorkflowRunRecord> {
      return getWorkflowRunStatus(runId);
    },
    async abort(runId: string): Promise<WorkflowRunRecord> {
      return abortWorkflowRun(runId);
    },
    async runs(limit?: number) {
      return listWorkflowRuns(limit);
    },
  };
}
