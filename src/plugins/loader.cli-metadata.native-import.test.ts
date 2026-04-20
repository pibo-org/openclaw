import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import { cleanupPluginLoaderFixturesForTest, makeTempDir } from "./loader.test-fixtures.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  cleanupPluginLoaderFixturesForTest();
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("plugin loader CLI metadata native import", () => {
  it("loads bundled dist cli-metadata entries without Jiti", async () => {
    const createJiti = vi.fn(() => {
      throw new Error("Jiti should not be created for bundled dist cli-metadata");
    });
    vi.doMock("jiti", () => ({
      createJiti,
    }));

    const { loadOpenClawPluginCliRegistry } = await importFreshModule<typeof import("./loader.js")>(
      import.meta.url,
      "./loader.js?scope=cli-metadata-native-import",
    );

    const bundledRoot = makeTempDir();
    const pluginDir = path.join(bundledRoot, "bundled-native-cli");
    const cliMarker = path.join(pluginDir, "cli-loaded.txt");

    fs.mkdirSync(pluginDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;

    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/bundled-native-cli",
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "bundled-native-cli",
          configSchema: {
            type: "object",
            additionalProperties: false,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
  id: "bundled-native-cli",
  register() {
    throw new Error("full bundled entry should not load during CLI metadata capture");
  },
};`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "cli-metadata.js"),
      `import fs from "node:fs";
export default {
  id: "bundled-native-cli",
  register(api) {
    fs.writeFileSync(${JSON.stringify(cliMarker)}, "loaded", "utf-8");
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "bundled-native-cli",
          description: "Bundled native cli metadata",
          hasSubcommands: true,
        },
      ],
    });
  },
};`,
      "utf-8",
    );

    const registry = await loadOpenClawPluginCliRegistry({
      config: {
        plugins: {
          allow: ["bundled-native-cli"],
          entries: {
            "bundled-native-cli": {
              enabled: true,
            },
          },
        },
      },
    });

    expect(createJiti).not.toHaveBeenCalled();
    expect(fs.existsSync(cliMarker)).toBe(true);
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain(
      "bundled-native-cli",
    );
  });
});
