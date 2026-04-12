import fs from "node:fs";
import path from "node:path";
import type { WorkflowTraceEvent } from "../types.js";

export function appendWorkflowTraceEventJsonl(eventLogPath: string, event: WorkflowTraceEvent) {
  fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
  fs.appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
}
