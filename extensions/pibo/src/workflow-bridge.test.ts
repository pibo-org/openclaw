import { describe, expect, it, vi, beforeEach } from "vitest";

const runPiboWorkflows = vi.fn(async (_api: unknown, _args: string[]) => "");
const runPiboWorkflowsJson = vi.fn(async (_api: unknown, _args: string[]) => ({}));

vi.mock("./workflow-runtime.js", () => ({
  runPiboWorkflows,
  runPiboWorkflowsJson,
}));

describe("pibo workflow bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    runPiboWorkflows.mockClear();
    runPiboWorkflowsJson.mockClear();
  });

  it("routes /pibo workflows list through the generic pibo-cli workflow bridge", async () => {
    runPiboWorkflows.mockResolvedValueOnce("workflow list output");
    const { handlePiboCommand } = await import("./router.js");

    const text = await handlePiboCommand(
      { logger: { info() {}, warn() {}, error() {}, debug() {} } } as never,
      { args: "workflows list", channel: "telegram", senderId: "tester" } as never,
    );

    expect(text).toBe("workflow list output");
    expect(runPiboWorkflows).toHaveBeenCalledWith(expect.anything(), ["list"]);
  });

  it("exposes pibo_workflow_start as a generic tool bridge", async () => {
    const { createPiboWorkflowStartTool } = await import("./workflow-tools.js");

    const start = vi.fn(async () => ({ runId: "run-1", status: "done" }));
    const tool = createPiboWorkflowStartTool({
      runtime: { piboWorkflows: { start } },
    } as never)({
      sessionKey: "agent:main:telegram:group:-100123:topic:333",
      deliveryContext: {
        channel: "telegram",
        to: "group:-100123",
        accountId: "telegram-default",
        threadId: "333",
      },
    } as never);
    const result = (await tool.execute("call-1", {
      moduleId: "langgraph_worker_critic",
      input: { task: "demo", successCriteria: ["done"] },
      maxRounds: 2,
    })) as {
      details: { ok: boolean; result?: { runId?: string } };
    };

    expect(start).toHaveBeenCalledWith(
      "langgraph_worker_critic",
      expect.objectContaining({
        input: { task: "demo", successCriteria: ["done"] },
        maxRounds: 2,
        origin: expect.objectContaining({
          ownerSessionKey: "agent:main:telegram:group:-100123:topic:333",
          channel: "telegram",
          to: "group:-100123",
          accountId: "telegram-default",
          threadId: "333",
        }),
      }),
    );
    expect(result.details.ok).toBe(true);
    expect(result.details.result?.runId).toBe("run-1");
  });
});
