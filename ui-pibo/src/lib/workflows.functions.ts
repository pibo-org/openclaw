import { createServerFn } from "@tanstack/react-start";
import { readWorkflowRunDetailPage, readWorkflowsDashboardPage } from "#/lib/workflows.server";
import type { WorkflowDashboardQuery, WorkflowDetailQuery } from "#/lib/workflows.shared";

function validateDashboardInput(data: Partial<WorkflowDashboardQuery> | undefined) {
  return data ?? {};
}

function validateDetailInput(
  data: { runId: string; query?: Partial<WorkflowDetailQuery> } | undefined,
) {
  if (!data || typeof data.runId !== "string" || !data.runId.trim()) {
    throw new Error("Workflow-Run-ID fehlt.");
  }
  return {
    runId: data.runId.trim(),
    query: data.query ?? {},
  };
}

export const getWorkflowsDashboardPage = createServerFn({ method: "GET" })
  .inputValidator(validateDashboardInput)
  .handler(async ({ data }) => {
    return readWorkflowsDashboardPage(data);
  });

export const getWorkflowRunDetailPage = createServerFn({ method: "GET" })
  .inputValidator(validateDetailInput)
  .handler(async ({ data }) => {
    return readWorkflowRunDetailPage(data.runId, data.query);
  });
