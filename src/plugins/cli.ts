import fs from "node:fs";
import type { Command } from "commander";
import {
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigPath,
  type OpenClawConfig,
} from "../config/config.js";
import {
  createPluginCliLogger,
  loadPluginCliDescriptors,
  loadPluginCliMetadataRegistrationEntriesWithDefaults,
  loadPluginCliRegistrationEntriesWithDefaults,
  type PluginCliLoaderOptions,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
};

const logger = createPluginCliLogger();
const BUNDLED_PLUGIN_PRIMARY_IDS = new Map<string, string[]>([
  ["browser", ["browser"]],
  ["ltm", ["memory-lancedb"]],
  ["matrix", ["matrix"]],
  ["memory", ["memory-core"]],
  ["voice-call", ["voice-call"]],
  ["voicecall", ["voice-call"]],
  ["wiki", ["memory-wiki"]],
]);

function resolveLikelyPluginIdsForPrimary(primary: string): string[] {
  const normalized = primary.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const mapped = BUNDLED_PLUGIN_PRIMARY_IDS.get(normalized);
  if (mapped) {
    return mapped;
  }
  return [...new Set([normalized, normalized.replace(/_/g, "-")])].filter(Boolean);
}

export const loadValidatedConfigForPluginRegistration = async (
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig | null> => {
  if (options?.mode === "lazy" && options.primary) {
    const fastConfig = loadFastPluginRegistrationConfig();
    if (fastConfig) {
      return fastConfig;
    }
  }
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    return null;
  }
  return loadConfig();
};

function loadFastPluginRegistrationConfig(): OpenClawConfig | null {
  try {
    const configPath = resolveConfigPath(process.env);
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    if (raw.includes("$include") || raw.includes("${")) {
      return null;
    }
    const parsed = parseConfigJson5(raw);
    if (!parsed.ok) {
      return null;
    }
    return parsed.parsed && typeof parsed.parsed === "object" && !Array.isArray(parsed.parsed)
      ? (parsed.parsed as OpenClawConfig)
      : {};
  } catch {
    return null;
  }
}

export async function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<OpenClawPluginCliCommandDescriptor[]> {
  return loadPluginCliDescriptors({ cfg, env, loaderOptions });
}

export async function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
) {
  const mode = options?.mode ?? "eager";
  const primary = options?.primary ?? null;
  const existingCommands = new Set(program.commands.map((cmd) => cmd.name()));

  if (mode === "lazy" && primary) {
    const likelyPluginIds = resolveLikelyPluginIdsForPrimary(primary);
    await registerPluginCliCommandGroups(
      program,
      await loadPluginCliMetadataRegistrationEntriesWithDefaults({
        cfg,
        env,
        loaderOptions: {
          ...loaderOptions,
          ...(likelyPluginIds.length > 0 ? { onlyPluginIds: likelyPluginIds } : {}),
        },
      }),
      {
        mode,
        primary,
        existingCommands,
        logger,
      },
    );
    if (program.commands.some((command) => command.name() === primary)) {
      return;
    }
  }

  await registerPluginCliCommandGroups(
    program,
    await loadPluginCliRegistrationEntriesWithDefaults({ cfg, env, loaderOptions }),
    {
      mode,
      primary,
      existingCommands,
      logger,
    },
  );
}

export async function registerPluginCliCommandsFromValidatedConfig(
  program: Command,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig | null> {
  const config = await loadValidatedConfigForPluginRegistration(options);
  if (!config) {
    return null;
  }
  await registerPluginCliCommands(program, config, env, loaderOptions, options);
  return config;
}
