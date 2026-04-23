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

    expect(stdoutSpy.mock.calls.map(([line]: [string, ...unknown[]]) => line)).toEqual([
      "- codex_controller: Runs a persistent Codex SDK worker under a controller loop that keeps going, finishes cleanly, or escalates real blockers.",
      "- langgraph_worker_critic: Führt einen expliziten Worker/Critic-Loop mit `langgraph` als Worker und `critic` als Review-Agent aus.",
      "- noop: Minimal referenzierbares Workflow-Modul zum Testen von start/status/describe/runs.",
      "- ralph_from_specs: Starts from trusted approved specs, then runs the shared Ralph PRD/backlog/execution core without a specs review gate.",
      "- self_ralph: Runs a native ideation-first self-Ralph workflow, then hands approved specs into the shared Ralph planning/execution core.",
    ]);
  });

  it("describes a workflow manifest as json", () => {
    workflowsDescribe("codex_controller", { json: true });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { moduleId: string };
    expect(payload.moduleId).toBe("codex_controller");
  });

  it("prints codex_controller context-boundary guidance in text describe output", () => {
    workflowsDescribe("codex_controller", { json: false });

    const lines = stdoutSpy.mock.calls.map(([line]: [string, ...unknown[]]) => String(line));
    expect(lines).toContain(
      "- task (string, required): original coding task passed directly to Codex; the worker only gets explicit workflow/task fields, not ambient Main/session chat, memory, or docs.",
    );
    expect(lines).toContain(
      "- workingDirectory (string, required in the low-level contract; run codex_controller defaults --cwd to pwd): absolute project/worktree path used as the persistent Codex SDK worker cwd; the worker runs here.",
    );
    expect(lines).toContain(
      "- agentId (string, optional): selects agent-workspace bootstrap for the controller (skills/system prompt) and adds that workspace as extra readable Codex context; does not change worker cwd or import full Main/session chat, memory, or docs.",
    );
  });

  it("exits on unknown workflow modules", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    expect(() => workflowsDescribe("does_not_exist", { json: false })).toThrow("process.exit:1");
    expect(stderrSpy).toHaveBeenCalledWith("Workflow-Modul nicht gefunden: does_not_exist");

    exitSpy.mockRestore();
  });
});
