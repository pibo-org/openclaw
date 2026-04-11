import { describe, expect, it } from "vitest";
import { __testing } from "./root-help-metadata.js";

describe("root-help-metadata", () => {
  it("includes the dist-local metadata path for bundled root-help modules", () => {
    const paths = __testing.getStartupMetadataCandidatePathsForTests(
      "file:///repo/dist/root-help-metadata-ABC123.js",
    );

    expect(paths).toContain("/repo/dist/cli-startup-metadata.json");
  });

  it("keeps the source fallback path for tsx-loaded source modules", () => {
    const paths = __testing.getStartupMetadataCandidatePathsForTests(
      "file:///repo/src/cli/root-help-metadata.ts",
    );

    expect(paths).toContain("/repo/dist/cli-startup-metadata.json");
  });
});
