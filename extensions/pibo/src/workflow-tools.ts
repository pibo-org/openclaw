import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runPiboWorkflowsJson } from "./workflow-runtime.js";

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const WorkflowStartSchema = Type.Object(
  {
    moduleId: Type.String({ description: "Workflow module id, e.g. langgraph_worker_critic" }),
    input: Type.Optional(
      Type.Unknown({ description: "JSON input payload for the workflow module" }),
    ),
    maxRounds: Type.Optional(Type.Number({ description: "Optional round limit" })),
  },
  { additionalProperties: false },
);

const WorkflowStatusSchema = Type.Object(
  {
    runId: Type.String({ description: "Workflow run id" }),
  },
  { additionalProperties: false },
);

const WorkflowDescribeSchema = Type.Object(
  {
    moduleId: Type.Optional(Type.String({ description: "Optional module id" })),
  },
  { additionalProperties: false },
);

export function createPiboWorkflowStartTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_start",
    label: "PIBo Workflow Start",
    description: "Start a registered PIBO workflow module and return the persisted run record.",
    parameters: WorkflowStartSchema,
    async execute(_toolCallId, params) {
      const moduleId = typeof params.moduleId === "string" ? params.moduleId.trim() : "";
      if (!moduleId) {
        return json({ ok: false, error: "moduleId required" });
      }
      const args = ["start", moduleId, "--output-json"];
      if ("input" in params) {
        args.push("--json", JSON.stringify(params.input ?? {}));
      }
      if (typeof params.maxRounds === "number" && Number.isFinite(params.maxRounds)) {
        args.push("--max-rounds", String(params.maxRounds));
      }
      try {
        const result = await runPiboWorkflowsJson(args);
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowStatusTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_status",
    label: "PIBo Workflow Status",
    description: "Load the status of a persisted PIBO workflow run.",
    parameters: WorkflowStatusSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      try {
        const result = await runPiboWorkflowsJson(["status", runId, "--json"]);
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowAbortTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_abort",
    label: "PIBo Workflow Abort",
    description: "Abort a non-terminal PIBO workflow run when the module supports abort.",
    parameters: WorkflowStatusSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      try {
        const result = await runPiboWorkflowsJson(["abort", runId, "--json"]);
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowDescribeTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_describe",
    label: "PIBo Workflow Describe",
    description: "Describe a PIBO workflow module or list all registered modules.",
    parameters: WorkflowDescribeSchema,
    async execute(_toolCallId, params) {
      try {
        if (typeof params.moduleId === "string" && params.moduleId.trim()) {
          const result = await runPiboWorkflowsJson(["describe", params.moduleId.trim(), "--json"]);
          return json({ ok: true, result });
        }
        const result = await runPiboWorkflowsJson(["list", "--json"]);
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}
