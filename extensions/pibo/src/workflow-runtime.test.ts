import { describe, expect, it } from "vitest";
import { runPiboWorkflows } from "./workflow-runtime.js";

describe("pibo workflow runtime cli bridge", () => {
  it("treats --json as input for start-async and still returns human text", async () => {
    const text = await runPiboWorkflows(
      {
        runtime: {
          piboWorkflows: {
            startAsync: async (_moduleId: string, request: { input?: unknown }) => ({
              runId: "run-async-1",
              moduleId: "noop",
              status: "pending",
              echoedInput: request.input,
            }),
          },
        },
      } as never,
      ["start-async", "noop", "--json", '{"prompt":"demo"}'],
    );

    expect(text).toContain("Run asynchron gestartet: run-async-1");
    expect(text).toContain("Status: pending");
    expect(text).not.toContain('"runId"');
  });

  it("renders wait as JSON only when output-json is requested", async () => {
    const text = await runPiboWorkflows(
      {
        runtime: {
          piboWorkflows: {
            wait: async () => ({
              status: "timeout" as const,
            }),
          },
        },
      } as never,
      ["wait", "run-1", "--output-json"],
    );

    expect(JSON.parse(text)).toEqual({ status: "timeout" });
  });

  it("renders progress through the compact runtime surface", async () => {
    const text = await runPiboWorkflows(
      {
        runtime: {
          piboWorkflows: {
            progress: async () => ({
              runId: "run-1",
              moduleId: "noop",
              status: "running",
              isTerminal: false,
              currentRound: 2,
              maxRounds: 5,
              traceLevel: 1,
              eventCount: 9,
              artifactCount: 1,
              startedAt: "2026-04-12T12:00:00.000Z",
              updatedAt: "2026-04-12T12:01:00.000Z",
              terminalReason: null,
              currentStepId: "round-2",
              activeRole: "controller",
              lastCompletedRole: "worker",
              lastArtifactPath: "/tmp/round-2-worker.txt",
              lastArtifactName: "round-2-worker.txt",
              lastEventSeq: 9,
              lastEventKind: "role_turn_started",
              lastEventAt: "2026-04-12T12:01:00.000Z",
              lastEventSummary: "Controller turn 2 started.",
              sessions: {},
              humanSummary: "Run laeuft Runde 2; aktive Rolle: controller.",
            }),
          },
        },
      } as never,
      ["progress", "run-1"],
    );

    expect(text).toContain("Status: running");
    expect(text).toContain("Active role: controller");
    expect(text).toContain("Summary: Run laeuft Runde 2; aktive Rolle: controller.");
  });

  it("filters trace events through the runtime bridge", async () => {
    const text = await runPiboWorkflows(
      {
        runtime: {
          piboWorkflows: {
            traceEvents: async (_runId: string, query?: { limit?: number; role?: string }) => {
              expect(query).toMatchObject({ limit: 2, role: "controller" });
              return [
                {
                  seq: 8,
                  ts: "2026-04-12T12:00:00.000Z",
                  kind: "role_turn_started",
                  role: "controller",
                  summary: "Controller started.",
                },
              ];
            },
          },
        },
      } as never,
      ["trace-events", "run-1", "--limit", "2", "--role", "controller"],
    );

    expect(text).toContain("#8");
    expect(text).toContain("role_turn_started");
    expect(text).toContain("Controller started.");
  });
});
