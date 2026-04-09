import { describe, expect, it } from "vitest";
import { getSubCliCommandsWithSubcommands, getSubCliEntries } from "./subcli-descriptors.js";

describe("pibo subcli descriptor", () => {
  it("is advertised as a subcommand with subcommands", () => {
    expect(getSubCliEntries().some((entry) => entry.name === "pibo" && entry.hasSubcommands)).toBe(true);
    expect(getSubCliCommandsWithSubcommands()).toContain("pibo");
  });
});
