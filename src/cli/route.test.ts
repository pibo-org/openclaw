import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const findRoutedCommandForArgvMock = vi.hoisted(() => vi.fn());
const runRouteMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("./program/routes.js", () => ({
  findRoutedCommandForArgv: findRoutedCommandForArgvMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  },
}));

describe("tryRouteCli", () => {
  let tryRouteCli: typeof import("./route.js").tryRouteCli;
  // After vi.resetModules(), reimported modules get fresh loggingState.
  // Capture the same reference that route.js uses.
  let loggingState: typeof import("../logging/state.js").loggingState;
  let originalDisableRouteFirst: string | undefined;
  let originalHideBanner: string | undefined;
  let originalForceStderr: boolean;

  beforeAll(async () => {
    ({ tryRouteCli } = await import("./route.js"));
    ({ loggingState } = await import("../logging/state.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    originalDisableRouteFirst = process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
    delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    delete process.env.OPENCLAW_HIDE_BANNER;
    originalForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
    findRoutedCommandForArgvMock.mockReturnValue({
      commandPath: ["status"],
      loadPlugins: (argv: string[]) => !argv.includes("--json"),
      run: runRouteMock,
    });
  });

  afterEach(() => {
    if (loggingState) {
      loggingState.forceConsoleToStderr = originalForceStderr;
    }
    if (originalDisableRouteFirst === undefined) {
      delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    } else {
      process.env.OPENCLAW_DISABLE_ROUTE_FIRST = originalDisableRouteFirst;
    }
    if (originalHideBanner === undefined) {
      delete process.env.OPENCLAW_HIDE_BANNER;
    } else {
      process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
    }
  });

  it("skips config guard for routed status --json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status", "--json"])).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("does not pass suppressDoctorStdout for routed non-json commands", async () => {
    await expect(tryRouteCli(["node", "openclaw", "status"])).resolves.toBe(true);

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({ scope: "channels" });
  });

  it("routes logs to stderr during plugin loading in --json mode and restores after", async () => {
    findRoutedCommandForArgvMock.mockReturnValue({
      commandPath: ["agents"],
      loadPlugins: true,
      run: runRouteMock,
    });

    // Capture the value inside the mock callback using the same loggingState
    // reference that route.js sees (both imported after vi.resetModules()).
    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await tryRouteCli(["node", "openclaw", "agents", "--json"]);

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalled();
    expect(captured[0]).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("does not route logs to stderr during plugin loading without --json", async () => {
    findRoutedCommandForArgvMock.mockReturnValue({
      commandPath: ["agents"],
      loadPlugins: true,
      run: runRouteMock,
    });

    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await tryRouteCli(["node", "openclaw", "agents"]);

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalled();
    expect(captured[0]).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes status when root options precede the command", async () => {
    await expect(tryRouteCli(["node", "openclaw", "--log-level", "debug", "status"])).resolves.toBe(
      true,
    );

    expect(findRoutedCommandForArgvMock).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "--log-level",
      "debug",
      "status",
    ]);
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({ scope: "channels" });
  });

  it("uses the full routed command path for deep pibo fast paths", async () => {
    findRoutedCommandForArgvMock.mockReturnValue({
      commandPath: ["pibo", "commands", "list"],
      run: runRouteMock,
    });

    await expect(tryRouteCli(["node", "openclaw", "pibo", "commands", "list"])).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("respects OPENCLAW_HIDE_BANNER for routed commands", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await expect(tryRouteCli(["node", "openclaw", "status"])).resolves.toBe(true);

    expect(emitCliBannerMock).not.toHaveBeenCalled();
  });
});
