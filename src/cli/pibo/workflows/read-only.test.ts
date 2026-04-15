import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workflowsDescribe, workflowsList } from "./read-only.js";

describe("pibo workflows read-only", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists workflow manifests without importing the runtime graph", () => {
    workflowsList({ json: false });

    expect(stdoutSpy.mock.calls.map(([line]) => line)).toEqual([
      "- codex_controller: Runs a persistent Codex ACP worker under a controller loop that keeps going, finishes cleanly, or escalates real blockers.",
      "- langgraph_worker_critic: Führt einen expliziten Worker/Critic-Loop mit `langgraph` als Worker und `critic` als Review-Agent aus.",
      "- noop: Minimal referenzierbares Workflow-Modul zum Testen von start/status/describe/runs.",
    ]);
  });

  it("describes a workflow manifest as json", () => {
    workflowsDescribe("codex_controller", { json: true });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { moduleId: string };
    expect(payload.moduleId).toBe("codex_controller");
  });

  it("exits on unknown workflow modules", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    expect(() => workflowsDescribe("does_not_exist", { json: false })).toThrow(
      "process.exit:1",
    );
    expect(stderrSpy).toHaveBeenCalledWith("Workflow-Modul nicht gefunden: does_not_exist");

    exitSpy.mockRestore();
  });
});
