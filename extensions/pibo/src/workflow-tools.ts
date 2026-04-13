import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildTrustedWorkflowContext as buildTrustedWorkflowContextFromOrigin } from "../../../src/cli/pibo/workflows/trusted-context.js";

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

const WorkflowWaitSchema = Type.Object(
  {
    runId: Type.String({ description: "Workflow run id" }),
    timeoutMs: Type.Optional(Type.Number({ description: "Optional wait timeout in milliseconds" })),
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

const WorkflowTraceEventsSchema = Type.Object(
  {
    runId: Type.String({ description: "Workflow run id" }),
    limit: Type.Optional(Type.Number({ description: "Optional max number of newest events" })),
    sinceSeq: Type.Optional(
      Type.Number({ description: "Optional trace cursor; only return events after this seq" }),
    ),
    role: Type.Optional(Type.String({ description: "Optional role filter" })),
    kind: Type.Optional(Type.String({ description: "Optional event kind filter" })),
  },
  { additionalProperties: false },
);

const WorkflowArtifactSchema = Type.Object(
  {
    runId: Type.String({ description: "Workflow run id" }),
    name: Type.String({ description: "Artifact file name inside the run artifact directory" }),
    headLines: Type.Optional(
      Type.Number({ description: "Optional number of first lines to return" }),
    ),
    tailLines: Type.Optional(
      Type.Number({ description: "Optional number of last lines to return" }),
    ),
  },
  { additionalProperties: false },
);

export function createPiboWorkflowStartTool(_api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
    name: "pibo_workflow_start",
    label: "PIBo Workflow Start",
    description: "Start a registered PIBO workflow module and return the persisted run record.",
    parameters: WorkflowStartSchema,
    async execute(_toolCallId, params) {
      const moduleId = typeof params.moduleId === "string" ? params.moduleId.trim() : "";
      if (!moduleId) {
        return json({ ok: false, error: "moduleId required" });
      }
      try {
        const trustedContext = buildTrustedWorkflowContext(ctx);
        if (!trustedContext) {
          return json({
            ok: false,
            error:
              "PIBO workflow start requires a trusted sessionKey and delivery origin from an active chat session.",
          });
        }
        const result = await _api.runtime.piboWorkflows.start(moduleId, {
          input: "input" in params ? (params.input ?? {}) : {},
          ...(typeof params.maxRounds === "number" && Number.isFinite(params.maxRounds)
            ? { maxRounds: params.maxRounds }
            : {}),
          origin: trustedContext.origin,
          reporting: trustedContext.reporting,
        });
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

function buildTrustedWorkflowContext(ctx: OpenClawPluginToolContext) {
  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const delivery = ctx.deliveryContext;
  if (!sessionKey || !delivery?.channel || !delivery.to) {
    return null;
  }
  return buildTrustedWorkflowContextFromOrigin({
    ownerSessionKey: sessionKey,
    channel: delivery.channel,
    to: delivery.to,
    accountId:
      typeof delivery.accountId === "string" && delivery.accountId
        ? delivery.accountId
        : typeof ctx.agentAccountId === "string" && ctx.agentAccountId
          ? ctx.agentAccountId
          : undefined,
    threadId: delivery.threadId,
  });
}

export function createPiboWorkflowStartAsyncTool(_api: OpenClawPluginApi) {
  return (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
    name: "pibo_workflow_start_async",
    label: "PIBo Workflow Start Async",
    description:
      "Start a registered PIBO workflow module asynchronously and return immediately with the run record.",
    parameters: WorkflowStartSchema,
    async execute(_toolCallId, params) {
      const moduleId = typeof params.moduleId === "string" ? params.moduleId.trim() : "";
      if (!moduleId) {
        return json({ ok: false, error: "moduleId required" });
      }
      try {
        const trustedContext = buildTrustedWorkflowContext(ctx);
        if (!trustedContext) {
          return json({
            ok: false,
            error:
              "PIBO workflow async start requires a trusted sessionKey and delivery origin from an active chat session.",
          });
        }
        const result = await _api.runtime.piboWorkflows.startAsync(moduleId, {
          input: "input" in params ? (params.input ?? {}) : {},
          ...(typeof params.maxRounds === "number" && Number.isFinite(params.maxRounds)
            ? { maxRounds: params.maxRounds }
            : {}),
          origin: trustedContext.origin,
          reporting: trustedContext.reporting,
        });
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

export function createPiboWorkflowWaitTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_wait",
    label: "PIBo Workflow Wait",
    description: "Wait for a PIBO workflow run to reach a terminal state.",
    parameters: WorkflowWaitSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      try {
        const result = await _api.runtime.piboWorkflows.wait(
          runId,
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : undefined,
        );
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
        const result = await _api.runtime.piboWorkflows.status(runId);
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowProgressTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_progress",
    label: "PIBo Workflow Progress",
    description: "Load a compact operational progress snapshot for a persisted PIBO workflow run.",
    parameters: WorkflowStatusSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      try {
        const result = await _api.runtime.piboWorkflows.progress(runId);
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
        const result = await _api.runtime.piboWorkflows.abort(runId);
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
          const result = await _api.runtime.piboWorkflows.describe(params.moduleId.trim());
          return json({ ok: true, result });
        }
        const result = await _api.runtime.piboWorkflows.list();
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowTraceSummaryTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_trace_summary",
    label: "PIBo Workflow Trace Summary",
    description: "Load the compact trace summary for a persisted PIBO workflow run.",
    parameters: WorkflowStatusSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      try {
        const result = await _api.runtime.piboWorkflows.traceSummary(runId);
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowTraceEventsTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_trace_events",
    label: "PIBo Workflow Trace Events",
    description:
      "Load filtered workflow trace events without reading the full trace.jsonl manually.",
    parameters: WorkflowTraceEventsSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      try {
        const result = await _api.runtime.piboWorkflows.traceEvents(runId, {
          limit:
            typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
              ? Math.floor(params.limit)
              : undefined,
          sinceSeq:
            typeof params.sinceSeq === "number" &&
            Number.isFinite(params.sinceSeq) &&
            params.sinceSeq >= 0
              ? Math.floor(params.sinceSeq)
              : undefined,
          role:
            typeof params.role === "string" && params.role.trim() ? params.role.trim() : undefined,
          kind:
            typeof params.kind === "string" && params.kind.trim() ? params.kind.trim() : undefined,
        });
        return json({ ok: true, result: { events: result } });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowArtifactsTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_artifacts",
    label: "PIBo Workflow Artifacts",
    description: "List the artifact files for a persisted PIBO workflow run.",
    parameters: WorkflowStatusSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      try {
        const result = await _api.runtime.piboWorkflows.artifacts(runId);
        return json({ ok: true, result: { artifacts: result } });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}

export function createPiboWorkflowArtifactTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "pibo_workflow_artifact",
    label: "PIBo Workflow Artifact",
    description: "Read one workflow artifact file, optionally clipped to head or tail lines.",
    parameters: WorkflowArtifactSchema,
    async execute(_toolCallId, params) {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!runId) {
        return json({ ok: false, error: "runId required" });
      }
      if (!name) {
        return json({ ok: false, error: "name required" });
      }
      try {
        const result = await _api.runtime.piboWorkflows.readArtifact(runId, name, {
          headLines:
            typeof params.headLines === "number" &&
            Number.isFinite(params.headLines) &&
            params.headLines > 0
              ? Math.floor(params.headLines)
              : undefined,
          tailLines:
            typeof params.tailLines === "number" &&
            Number.isFinite(params.tailLines) &&
            params.tailLines > 0
              ? Math.floor(params.tailLines)
              : undefined,
        });
        return json({ ok: true, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } satisfies AnyAgentTool;
}
