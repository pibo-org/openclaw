import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import browserCliMetadataPlugin from "./cli-metadata.js";
import type { OpenClawPluginApi } from "./runtime-api.js";

const cliRuntimeMocks = vi.hoisted(() => ({
  registerBrowserCli: vi.fn(),
}));

const runtimeApiImportSpy = vi.hoisted(() => vi.fn());

vi.mock("./cli-runtime.js", () => ({
  registerBrowserCli: cliRuntimeMocks.registerBrowserCli,
}));

vi.mock("./runtime-api.js", () => {
  runtimeApiImportSpy();
  return {};
});

function createApi() {
  const registerCli = vi.fn();
  const api = createTestPluginApi({
    id: "browser",
    name: "Browser",
    source: "test",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    registerCli,
  });
  return { api, registerCli };
}

describe("browser CLI metadata plugin", () => {
  it("loads the CLI-only runtime entry for browser command registration", async () => {
    const { api, registerCli } = createApi();

    browserCliMetadataPlugin.register?.(api);

    const registerCliCallback = registerCli.mock.calls[0]?.[0];
    if (typeof registerCliCallback !== "function") {
      throw new Error("expected browser CLI metadata plugin to register a CLI callback");
    }

    await registerCliCallback({ program: new Command() });

    expect(cliRuntimeMocks.registerBrowserCli).toHaveBeenCalledTimes(1);
    expect(runtimeApiImportSpy).not.toHaveBeenCalled();
  });
});
