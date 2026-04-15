import fs from "node:fs";
import { parseConfigJson5, resolveConfigPath } from "../config/config.js";
import type { TaglineMode } from "./tagline.js";

export function parseTaglineMode(value: unknown): TaglineMode | undefined {
  if (value === "random" || value === "default" || value === "off") {
    return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function readCliBannerTaglineMode(
  env: NodeJS.ProcessEnv = process.env,
): TaglineMode | undefined {
  try {
    // Keep banner/help startup cheap by reading only the raw config file.
    const raw = fs.readFileSync(resolveConfigPath(env), "utf8");
    const parsed = parseConfigJson5(raw);
    if (!parsed.ok) {
      return undefined;
    }

    const cli = asRecord(asRecord(parsed.parsed)?.cli);
    const banner = asRecord(cli?.banner);
    return parseTaglineMode(banner?.taglineMode);
  } catch {
    return undefined;
  }
}
