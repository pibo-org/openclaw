const DEFAULT_WORKFLOW_ABORT_REASON = "Abort requested by operator.";

export class WorkflowAbortError extends Error {
  constructor(message = DEFAULT_WORKFLOW_ABORT_REASON, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowAbortError";
  }
}

export function createWorkflowAbortError(reason?: unknown): WorkflowAbortError {
  if (reason instanceof WorkflowAbortError) {
    return reason;
  }
  if (reason instanceof Error) {
    return new WorkflowAbortError(reason.message, { cause: reason });
  }
  if (typeof reason === "string" && reason.trim()) {
    return new WorkflowAbortError(reason.trim());
  }
  return new WorkflowAbortError();
}

export function isWorkflowAbortError(error: unknown): boolean {
  return (
    error instanceof WorkflowAbortError || (error instanceof Error && error.name === "AbortError")
  );
}

export function throwIfWorkflowAbortRequested(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw createWorkflowAbortError(signal.reason);
}

export function workflowAbortReasonFromError(error: unknown): string {
  return createWorkflowAbortError(error).message;
}
