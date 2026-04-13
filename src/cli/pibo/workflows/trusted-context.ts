import type { WorkflowOriginContext, WorkflowReportingConfig } from "./types.js";

export const WORKFLOW_TOPIC_ORIGIN_REPORTING: WorkflowReportingConfig = {
  deliveryMode: "topic_origin",
  senderPolicy: "emitting_agent",
  headerMode: "runtime_header",
  events: ["started", "blocked", "completed"],
};

export function buildTrustedWorkflowContext(params: {
  ownerSessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
}): {
  origin: WorkflowOriginContext;
  reporting: WorkflowReportingConfig;
} {
  const origin: WorkflowOriginContext = {
    ownerSessionKey: params.ownerSessionKey,
    channel: params.channel,
    to: params.to,
    ...(typeof params.accountId === "string" && params.accountId
      ? { accountId: params.accountId }
      : {}),
    ...(params.threadId != null && params.threadId !== ""
      ? { threadId: String(params.threadId) }
      : {}),
  };
  return {
    origin,
    reporting: WORKFLOW_TOPIC_ORIGIN_REPORTING,
  };
}
