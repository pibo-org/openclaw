import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
  resolveCliExecutionStartupContext,
} from "./command-execution-startup.js";
import { findRoutedCommandForArgv } from "./program/routes.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean | ((argv: string[]) => boolean);
}) {
  const { startupPolicy } = resolveCliExecutionStartupContext({
    argv: params.argv,
    jsonOutputMode: hasFlag(params.argv, "--json"),
    env: process.env,
    routeMode: true,
    commandPathOverride: params.commandPath,
  });
  const showBanner = process.stdout.isTTY && !startupPolicy.suppressDoctorStdout;
  if (startupPolicy.suppressDoctorStdout || showBanner) {
    const version = showBanner ? (await import("../version.js")).VERSION : undefined;
    await applyCliExecutionStartupPresentation({
      argv: params.argv,
      routeLogsToStderrOnSuppress: false,
      startupPolicy,
      showBanner,
      version,
    });
  }
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;
  await ensureCliExecutionBootstrap({
    runtime: defaultRuntime,
    commandPath: params.commandPath,
    startupPolicy,
    loadPlugins: shouldLoadPlugins ?? startupPolicy.loadPlugins,
  });
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  if (!invocation.commandPath[0]) {
    return false;
  }
  const route = findRoutedCommandForArgv(argv);
  if (!route) {
    return false;
  }
  await prepareRoutedCommand({
    argv,
    commandPath: [...route.commandPath],
    loadPlugins: route.loadPlugins,
  });
  return route.run(argv);
}
