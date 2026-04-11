import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerCommandGroups, type CommandGroupEntry } from "./register-command-groups.js";

describe("registerCommandGroups", () => {
  it("does not register unrelated placeholders when only the primary command should load", () => {
    const program = new Command();
    const alphaRegister = vi.fn();
    const betaRegister = vi.fn();
    const entries: CommandGroupEntry[] = [
      {
        placeholders: [{ name: "alpha", description: "alpha placeholder" }],
        register: alphaRegister,
      },
      {
        placeholders: [{ name: "beta", description: "beta placeholder" }],
        register: betaRegister,
      },
    ];

    registerCommandGroups(program, entries, {
      eager: false,
      primary: "gamma",
      registerPrimaryOnly: true,
    });

    expect(program.commands).toHaveLength(0);
    expect(alphaRegister).not.toHaveBeenCalled();
    expect(betaRegister).not.toHaveBeenCalled();
  });
});
