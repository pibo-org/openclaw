import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { RootHelpRenderOptions } from "../src/cli/program/root-help.js";
import type { OpenClawConfig } from "../src/config/config.js";

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const rootDir = path.resolve(scriptDir, "..");
const distDir = path.join(rootDir, "dist");
const outputPath = path.join(distDir, "cli-startup-metadata.json");
const extensionsDir = path.join(rootDir, "extensions");
const PIBO_HELP_SOURCE_PATHS = [
  path.join("src", "cli", "pibo-cli.ts"),
  path.join("src", "cli", "pibo", "docs-sync", "index.ts"),
  path.join("src", "cli", "pibo", "local-sync", "index.ts"),
] as const;
const CRON_HELP_SOURCE_PATHS = [path.join("src", "cli", "cron-cli", "register.ts")] as const;
const PIBO_WORKFLOWS_HELP_SOURCE_PATHS = [
  path.join("src", "cli", "pibo-cli.ts"),
  path.join("src", "cli", "pibo", "workflows", "index.ts"),
] as const;
const CORE_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;

type ExtensionChannelEntry = {
  id: string;
  order: number;
  label: string;
};

type BundledChannelCatalog = {
  ids: string[];
  signature: string;
};

type RootHelpRenderContext = Pick<RootHelpRenderOptions, "config" | "env">;

function resolveRootHelpBundleIdentity(
  distDirOverride: string = distDir,
): { bundleName: string; signature: string } | null {
  const bundleName = readdirSync(distDirOverride).find(
    (entry) =>
      entry.startsWith("root-help-") &&
      !entry.startsWith("root-help-metadata-") &&
      entry.endsWith(".js"),
  );
  if (!bundleName) {
    return null;
  }
  const bundlePath = path.join(distDirOverride, bundleName);
  const raw = readFileSync(bundlePath, "utf8");
  return {
    bundleName,
    signature: createHash("sha1").update(raw).digest("hex"),
  };
}

export function readBundledChannelCatalog(
  extensionsDirOverride: string = extensionsDir,
): BundledChannelCatalog {
  const entries: ExtensionChannelEntry[] = [];
  const signature = createHash("sha1");
  for (const dirEntry of readdirSync(extensionsDirOverride, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) {
      continue;
    }
    const packageJsonPath = path.join(extensionsDirOverride, dirEntry.name, "package.json");
    try {
      const raw = readFileSync(packageJsonPath, "utf8");
      signature.update(`${dirEntry.name}\0${raw}\0`);
      const parsed = JSON.parse(raw) as {
        openclaw?: {
          channel?: {
            id?: unknown;
            order?: unknown;
            label?: unknown;
          };
        };
      };
      const id = parsed.openclaw?.channel?.id;
      if (typeof id !== "string" || !id.trim()) {
        continue;
      }
      const orderRaw = parsed.openclaw?.channel?.order;
      const labelRaw = parsed.openclaw?.channel?.label;
      entries.push({
        id: id.trim(),
        order: typeof orderRaw === "number" ? orderRaw : 999,
        label: typeof labelRaw === "string" ? labelRaw : id.trim(),
      });
    } catch {
      // Ignore malformed or missing extension package manifests.
    }
  }
  return {
    ids: entries
      .toSorted((a, b) =>
        a.order === b.order ? a.label.localeCompare(b.label) : a.order - b.order,
      )
      .map((entry) => entry.id),
    signature: signature.digest("hex"),
  };
}

export function readBundledChannelCatalogIds(
  extensionsDirOverride: string = extensionsDir,
): string[] {
  return readBundledChannelCatalog(extensionsDirOverride).ids;
}

function createIsolatedRootHelpRenderContext(
  bundledPluginsDir: string = extensionsDir,
): RootHelpRenderContext {
  const stateDir = path.join(rootDir, ".openclaw-build-root-help");
  const workspaceDir = path.join(stateDir, "workspace");
  const homeDir = path.join(stateDir, "home");
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "openclaw-build",
    USER: process.env.USER ?? process.env.LOGNAME ?? "openclaw-build",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
    NO_COLOR: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "",
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
    OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "0",
    OPENCLAW_STATE_DIR: stateDir,
  };
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    plugins: {
      loadPaths: [],
    },
  };
  return { config, env };
}

function createFileSignature(pathsToHash: readonly string[], baseDir: string = rootDir): string {
  const signature = createHash("sha1");
  for (const relativePath of pathsToHash) {
    const absolutePath = path.join(baseDir, relativePath);
    signature.update(`${relativePath}\0`);
    signature.update(readFileSync(absolutePath, "utf8"));
    signature.update("\0");
  }
  return signature.digest("hex");
}

export async function renderBundledRootHelpText(
  _distDirOverride: string = distDir,
  renderContext: RootHelpRenderContext = createIsolatedRootHelpRenderContext(
    existsSync(path.join(_distDirOverride, "extensions"))
      ? path.join(_distDirOverride, "extensions")
      : extensionsDir,
  ),
): Promise<string> {
  const bundleIdentity = resolveRootHelpBundleIdentity(_distDirOverride);
  if (!bundleIdentity) {
    throw new Error("No root-help bundle found in dist; cannot write CLI startup metadata.");
  }
  const moduleUrl = pathToFileURL(path.join(_distDirOverride, bundleIdentity.bundleName)).href;
  const renderOptions = {
    config: renderContext.config,
    env: renderContext.env,
  } satisfies RootHelpRenderOptions;
  const mod = await import(moduleUrl);
  if (typeof mod.outputRootHelp !== "function") {
    throw new Error(`Bundle ${bundleIdentity.bundleName} does not export outputRootHelp.`);
  }
  return await captureStdoutAsync(async () => {
    await mod.outputRootHelp(renderOptions);
  });
}

async function renderSourceRootHelpText(
  renderContext: RootHelpRenderContext = createIsolatedRootHelpRenderContext(),
): Promise<string> {
  const moduleUrl = pathToFileURL(path.join(rootDir, "src/cli/program/root-help.ts")).href;
  const renderOptions = {
    pluginSdkResolution: "src",
    config: renderContext.config,
    env: renderContext.env,
  } satisfies RootHelpRenderOptions;
  const mod = await tsImport(moduleUrl, import.meta.url);
  if (typeof mod.renderRootHelpText !== "function") {
    throw new Error("Source root-help module does not export renderRootHelpText.");
  }
  return await mod.renderRootHelpText(renderOptions);
}

export async function renderSourcePiboHelpText(rootDirOverride: string = rootDir): Promise<string> {
  return renderSourceSubcommandHelpText({
    rootDirOverride,
    registerModulePath: path.join("src", "cli", "pibo-cli.ts"),
    registerExportName: "registerPiboCli",
    commandPath: ["pibo"],
  });
}

export async function renderSourceCronHelpText(rootDirOverride: string = rootDir): Promise<string> {
  return renderSourceSubcommandHelpText({
    rootDirOverride,
    registerModulePath: path.join("src", "cli", "cron-cli.ts"),
    registerExportName: "registerCronCli",
    commandPath: ["cron"],
  });
}

export async function renderSourcePiboWorkflowsHelpText(
  rootDirOverride: string = rootDir,
): Promise<string> {
  return renderSourceSubcommandHelpText({
    rootDirOverride,
    registerModulePath: path.join("src", "cli", "pibo-cli.ts"),
    registerExportName: "registerPiboCli",
    commandPath: ["pibo", "workflows"],
  });
}

async function renderSourceSubcommandHelpText(params: {
  rootDirOverride?: string;
  registerModulePath: string;
  registerExportName: string;
  commandPath: string[];
}): Promise<string> {
  const rootDirOverride = params.rootDirOverride ?? rootDir;
  const moduleUrl = pathToFileURL(path.join(rootDirOverride, params.registerModulePath)).href;
  const { Command } = await import("commander");
  const [{ configureProgramHelp }, { VERSION }, mod] = await Promise.all([
    tsImport(
      pathToFileURL(path.join(rootDirOverride, "src/cli/program/help.ts")).href,
      import.meta.url,
    ),
    tsImport(pathToFileURL(path.join(rootDirOverride, "src/version.ts")).href, import.meta.url),
    tsImport(moduleUrl, import.meta.url),
  ]);
  const register = mod[params.registerExportName];
  if (typeof register !== "function") {
    throw new Error(
      `Source module ${params.registerModulePath} does not export ${params.registerExportName}.`,
    );
  }
  const program = new Command();
  configureProgramHelp(program, {
    programVersion: VERSION,
    channelOptions: [],
    messageChannelOptions: "",
    agentChannelOptions: "",
  });
  register(program);

  let current = program;
  for (const name of params.commandPath) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) {
      throw new Error(
        `Failed to register command path ${params.commandPath.join(" ")} while rendering help text.`,
      );
    }
    current = next;
  }
  return await captureStdoutAsync(async () => {
    current.outputHelp();
  });
}

async function captureStdoutAsync(work: () => Promise<void> | void): Promise<string> {
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captureWrite: typeof process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = captureWrite;
  try {
    await work();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

export async function writeCliStartupMetadata(options?: {
  distDir?: string;
  outputPath?: string;
  extensionsDir?: string;
}): Promise<void> {
  const resolvedDistDir = options?.distDir ?? distDir;
  const resolvedOutputPath = options?.outputPath ?? outputPath;
  const resolvedExtensionsDir = options?.extensionsDir ?? extensionsDir;
  const channelCatalog = readBundledChannelCatalog(resolvedExtensionsDir);
  const bundleIdentity = resolveRootHelpBundleIdentity(resolvedDistDir);
  const piboHelpSignature = createFileSignature(PIBO_HELP_SOURCE_PATHS);
  const subcommandHelpSignature = createFileSignature([
    ...CRON_HELP_SOURCE_PATHS,
    ...PIBO_WORKFLOWS_HELP_SOURCE_PATHS,
  ]);
  const bundledPluginsDir = path.join(resolvedDistDir, "extensions");
  const renderContext = createIsolatedRootHelpRenderContext(
    existsSync(bundledPluginsDir) ? bundledPluginsDir : resolvedExtensionsDir,
  );
  const channelOptions = dedupe([...CORE_CHANNEL_ORDER, ...channelCatalog.ids]);

  try {
    const existing = JSON.parse(readFileSync(resolvedOutputPath, "utf8")) as {
      rootHelpBundleSignature?: unknown;
      channelCatalogSignature?: unknown;
      piboHelpSignature?: unknown;
      subcommandHelpSignature?: unknown;
    };
    if (
      bundleIdentity &&
      existing.rootHelpBundleSignature === bundleIdentity.signature &&
      existing.channelCatalogSignature === channelCatalog.signature &&
      existing.piboHelpSignature === piboHelpSignature &&
      existing.subcommandHelpSignature === subcommandHelpSignature
    ) {
      return;
    }
  } catch {
    // Missing or malformed existing metadata means we should regenerate it.
  }

  let rootHelpText: string;
  try {
    rootHelpText = await renderBundledRootHelpText(resolvedDistDir, renderContext);
  } catch {
    rootHelpText = await renderSourceRootHelpText(renderContext);
  }
  const piboHelpText = await renderSourcePiboHelpText();
  const cronHelpText = await renderSourceCronHelpText();
  const piboWorkflowsHelpText = await renderSourcePiboWorkflowsHelpText();

  mkdirSync(resolvedDistDir, { recursive: true });
  writeFileSync(
    resolvedOutputPath,
    `${JSON.stringify(
      {
        generatedBy: "scripts/write-cli-startup-metadata.ts",
        channelOptions,
        channelCatalogSignature: channelCatalog.signature,
        rootHelpBundleSignature: bundleIdentity?.signature ?? null,
        piboHelpSignature,
        subcommandHelpSignature,
        rootHelpText,
        piboHelpText,
        cronHelpText,
        piboWorkflowsHelpText,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await writeCliStartupMetadata();
  process.exit(0);
}
