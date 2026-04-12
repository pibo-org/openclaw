import crypto from "node:crypto";

export function createWorkflowTraceEventId(): string {
  return crypto.randomUUID();
}
