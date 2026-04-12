import {
  abortWorkflowRun,
  describeWorkflowModule,
  getWorkflowProgress,
  getWorkflowRunStatus,
  getWorkflowTraceEvents,
  getWorkflowTraceSummary,
  listWorkflowArtifacts,
  listWorkflowModuleManifests,
  listWorkflowRuns,
  readWorkflowArtifact,
  startWorkflowRun,
  startWorkflowRunAsync,
  waitForWorkflowRun,
} from "../../cli/pibo/workflows/index.js";
import type { WorkflowTraceEventQuery } from "../../cli/pibo/workflows/tracing/types.js";
import type {
  WorkflowArtifactContent,
  WorkflowRunRecord,
  WorkflowStartRequest,
  WorkflowWaitResult,
} from "../../cli/pibo/workflows/types.js";

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
    async startAsync(moduleId: string, request: WorkflowStartRequest): Promise<WorkflowRunRecord> {
      return await startWorkflowRunAsync(moduleId, request);
    },
    async wait(runId: string, timeoutMs?: number): Promise<WorkflowWaitResult> {
      return await waitForWorkflowRun(runId, timeoutMs);
    },
    async status(runId: string): Promise<WorkflowRunRecord> {
      return getWorkflowRunStatus(runId);
    },
    async progress(runId: string) {
      return getWorkflowProgress(runId);
    },
    async abort(runId: string): Promise<WorkflowRunRecord> {
      return abortWorkflowRun(runId);
    },
    async runs(limit?: number) {
      return listWorkflowRuns(limit);
    },
    async traceSummary(runId: string) {
      return getWorkflowTraceSummary(runId);
    },
    async traceEvents(runId: string, query?: WorkflowTraceEventQuery) {
      return getWorkflowTraceEvents(runId, query);
    },
    async artifacts(runId: string) {
      return listWorkflowArtifacts(runId);
    },
    async readArtifact(
      runId: string,
      name: string,
      opts?: { headLines?: number; tailLines?: number },
    ): Promise<WorkflowArtifactContent> {
      return readWorkflowArtifact(runId, name, opts);
    },
  };
}
