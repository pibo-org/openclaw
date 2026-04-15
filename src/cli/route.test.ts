import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryRouteCli } from "./route.js";

const resolveCliExecutionStartupContextMock = vi.hoisted(() => vi.fn());
const applyCliExecutionStartupPresentationMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliExecutionBootstrapMock = vi.hoisted(() => vi.fn(async () => {}));
const findRoutedCommandForArgvMock = vi.hoisted(() => vi.fn());
const resolveCliArgvInvocationMock = vi.hoisted(() => vi.fn());

vi.mock("./command-execution-startup.js", () => ({
  resolveCliExecutionStartupContext: resolveCliExecutionStartupContextMock,
  applyCliExecutionStartupPresentation: applyCliExecutionStartupPresentationMock,
  ensureCliExecutionBootstrap: ensureCliExecutionBootstrapMock,
}));

vi.mock("./program/routes.js", () => ({
  findRoutedCommandForArgv: findRoutedCommandForArgvMock,
}));

vi.mock("./argv-invocation.js", () => ({
  resolveCliArgvInvocation: resolveCliArgvInvocationMock,
}));

describe("route.prepare", () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    resolveCliArgvInvocationMock.mockReturnValue({
      hasHelpOrVersion: false,
      commandPath: ["pibo", "workflows", "list"],
    });
    resolveCliExecutionStartupContextMock.mockReturnValue({
      startupPolicy: {
        suppressDoctorStdout: false,
        loadPlugins: false,
      },
    });
    findRoutedCommandForArgvMock.mockReturnValue({
      commandPath: ["pibo", "workflows", "list"],
      run: vi.fn(async () => true),
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
  });

  it("skips presentation setup for non-banner routes", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "pibo", "workflows", "list"]),
    ).resolves.toBe(true);

    expect(applyCliExecutionStartupPresentationMock).not.toHaveBeenCalled();
    expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledTimes(1);
  });

  it("keeps presentation setup when doctor stdout is suppressed", async () => {
    resolveCliExecutionStartupContextMock.mockReturnValueOnce({
      startupPolicy: {
        suppressDoctorStdout: true,
        loadPlugins: false,
      },
    });

    await expect(
      tryRouteCli(["node", "openclaw", "pibo", "workflows", "list", "--json"]),
    ).resolves.toBe(true);

    expect(applyCliExecutionStartupPresentationMock).toHaveBeenCalledTimes(1);
  });
});
