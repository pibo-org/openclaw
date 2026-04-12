import { describe, expect, it } from "vitest";
import {
  handlePiboRawSessionToolGuard,
  shouldBlockPiboRawSessionTool,
} from "./raw-session-tool-guard.js";

describe("pibo raw session tool guard", () => {
  it("blocks raw session tools for the main PIBO agent", () => {
    expect(
      shouldBlockPiboRawSessionTool({
        agentId: "main",
        toolName: "sessions_spawn",
      }),
    ).toBe(true);
    expect(
      shouldBlockPiboRawSessionTool({
        agentId: "main",
        toolName: "sessions_send",
      }),
    ).toBe(true);
    expect(
      shouldBlockPiboRawSessionTool({
        agentId: "main",
        toolName: "subagents",
      }),
    ).toBe(true);
  });

  it("does not block unrelated tools or other agents", () => {
    expect(
      shouldBlockPiboRawSessionTool({
        agentId: "main",
        toolName: "sessions_list",
      }),
    ).toBe(false);
    expect(
      shouldBlockPiboRawSessionTool({
        agentId: "langgraph",
        toolName: "sessions_spawn",
      }),
    ).toBe(false);
  });

  it("falls back to the session key when ctx.agentId is absent", () => {
    const result = handlePiboRawSessionToolGuard(
      {
        toolName: "sessions_send",
        params: {},
      },
      {
        toolName: "sessions_send",
        sessionKey: "agent:main:telegram:group:-1003736645971:topic:3336",
      },
    );

    expect(result).toEqual({
      block: true,
      blockReason:
        'Raw session tool "sessions_send" is disabled for PIBO agent "main". Use the PIBO orchestration layer instead of direct session tools.',
    });
  });

  it("returns nothing when no block is needed", () => {
    const result = handlePiboRawSessionToolGuard(
      {
        toolName: "sessions_list",
        params: {},
      },
      {
        toolName: "sessions_list",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    );

    expect(result).toBeUndefined();
  });
});
