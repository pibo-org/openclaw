import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderBundledRootHelpText,
  renderSourceCronHelpText,
  renderSourcePiboHelpText,
  renderSourcePiboWorkflowsHelpText,
  writeCliStartupMetadata,
} from "../../scripts/write-cli-startup-metadata.ts";
import { createScriptTestHarness } from "./test-helpers.js";

describe("write-cli-startup-metadata", () => {
  const { createTempDir } = createScriptTestHarness();

  it("captures bundled root help text from the CLI program", async () => {
    const tempDist = createTempDir("openclaw-root-help-bundle-");
    writeFileSync(
      path.join(tempDist, "root-help-test.js"),
      [
        "export async function outputRootHelp() {",
        '  process.stdout.write("Usage: openclaw\\n");',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const rootHelpText = await renderBundledRootHelpText(tempDist);

    expect(rootHelpText).toContain("Usage:");
    expect(rootHelpText).toContain("openclaw");
  });

  it("captures source pibo help text from the CLI program", async () => {
    const piboHelpText = await renderSourcePiboHelpText();

    expect(piboHelpText).toContain("Usage:");
    expect(piboHelpText).toContain("PIBo CLI modules ported into OpenClaw");
  });

  it("captures source cron and pibo workflows help text from the CLI program", async () => {
    const cronHelpText = await renderSourceCronHelpText();
    const piboWorkflowsHelpText = await renderSourcePiboWorkflowsHelpText();

    expect(cronHelpText).toContain("Usage:");
    expect(cronHelpText).toContain("cron");
    expect(piboWorkflowsHelpText).toContain("Usage:");
    expect(piboWorkflowsHelpText).toContain("workflows");
  });

  it("writes startup metadata with populated root help text", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");

    mkdirSync(distDir, { recursive: true });
    mkdirSync(path.join(extensionsDir, "matrix"), { recursive: true });
    writeFileSync(
      path.join(extensionsDir, "matrix", "package.json"),
      JSON.stringify({
        openclaw: {
          channel: {
            id: "matrix",
            order: 120,
            label: "Matrix",
          },
        },
      }),
      "utf8",
    );

    await writeCliStartupMetadata({ distDir, outputPath, extensionsDir });

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      channelOptions: string[];
      rootHelpText: string;
      piboHelpText: string;
      cronHelpText: string;
      piboWorkflowsHelpText: string;
    };
    expect(written.channelOptions).toContain("matrix");
    expect(written.rootHelpText).toContain("Usage:");
    expect(written.rootHelpText).toContain("openclaw");
    expect(written.piboHelpText).toContain("Usage:");
    expect(written.piboHelpText).toContain("PIBo CLI modules ported into OpenClaw");
    expect(written.cronHelpText).toContain("Usage:");
    expect(written.piboWorkflowsHelpText).toContain("Usage:");
  });
});
