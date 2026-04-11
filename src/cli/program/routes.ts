import { routedCommands, type RouteSpec } from "./route-specs.js";

export type { RouteSpec } from "./route-specs.js";

export function findRoutedCommand(path: string[]): RouteSpec | null {
  for (const route of routedCommands) {
    if (route.match(path)) {
      return route;
    }
  }
  return null;
}

export function findRoutedCommandForArgv(argv: string[]): RouteSpec | null {
  for (const route of routedCommands) {
    if (route.matchArgv?.(argv)) {
      return route;
    }
  }
  return findRoutedCommand(pathFromArgv(argv));
}

function pathFromArgv(argv: string[]): string[] {
  return argv.slice(2).filter((arg) => arg && !arg.startsWith("-"));
}
