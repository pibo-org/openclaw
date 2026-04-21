import { describe, expect, it, vi, beforeEach } from "vitest";

const runPiboWorkflows = vi.fn(async (_api: unknown, _args: string[]) => "");

vi.mock("./workflow-runtime.js", () => ({
  runPiboWorkflows,
}));

describe("pibo workflow bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    runPiboWorkflows.mockClear();
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

  it("deprecates /pibo workflows start so workflow mutations stay on the explicit CLI contract", async () => {
    const { handlePiboCommand } = await import("./router.js");

    const text = await handlePiboCommand(
      { logger: { info() {}, warn() {}, error() {}, debug() {} } } as never,
      {
        args: 'workflows start langgraph_worker_critic {"task":"demo"}',
        channel: "telegram",
        senderId: "tester",
      } as never,
    );

    expect(text).toContain("/pibo workflows start");
    expect(text).toContain("openclaw pibo workflows start");
    expect(text).toContain("--owner-session-key");
    expect(runPiboWorkflows).not.toHaveBeenCalled();
  });
});
