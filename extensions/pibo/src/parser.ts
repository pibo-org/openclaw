export interface ParsedArgs {
  module: string;
  submodules: string[];
  command: string;
  argument?: string;
  flags: Record<string, string>;
}

export function parseCommandArgs(args: string, knownPaths: string[] = []): ParsedArgs {
  const trimmed = args.trim();
  if (!trimmed) {
    return { module: "", submodules: [], command: "", argument: undefined, flags: {} };
  }

  const tokens = trimmed.split(/\s+/);
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const flagName = token.slice(2);
      const next = tokens[index + 1];
      if (next && !next.startsWith("--")) {
        flags[flagName] = next;
        index += 2;
      } else {
        flags[flagName] = "true";
        index += 1;
      }
      continue;
    }
    positional.push(token);
    index += 1;
  }

  if (positional.length === 0) {
    return { module: "", submodules: [], command: "", argument: undefined, flags };
  }

  let bestPathEnd = 0;
  for (const knownPath of knownPaths) {
    const parts = knownPath.split("/");
    let match = true;
    for (let pathIndex = 0; pathIndex < parts.length; pathIndex += 1) {
      if (positional[pathIndex] !== parts[pathIndex]) {
        match = false;
        break;
      }
    }
    if (match && parts.length > bestPathEnd) {
      bestPathEnd = parts.length;
    }
  }

  if (bestPathEnd > 0) {
    return {
      module: positional[0] ?? "",
      submodules: positional.slice(1, bestPathEnd - 1),
      command: positional[bestPathEnd - 1] ?? "",
      argument: positional.slice(bestPathEnd).join(" ") || undefined,
      flags,
    };
  }

  const [root, ...rest] = positional;
  return {
    module: root ?? "",
    submodules: rest.slice(0, Math.max(0, rest.length - 1)),
    command: rest.at(-1) ?? "",
    argument: undefined,
    flags,
  };
}
