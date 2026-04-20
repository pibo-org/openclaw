import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { Readable } from "stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PIBO_CONFIG_DIR = path.join(process.env.HOME || "", ".config", "pibo");
const REGISTRY_PATH = path.join(PIBO_CONFIG_DIR, "mcp-servers.json");
const CACHE_DIR = path.join(process.env.HOME || "", ".cache", "pibo", "mcp");
const DEFAULT_CACHE_TTL_SECONDS = 300;

type McpTransport = "stdio" | "http" | "streamable-http";

type McpServer = {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
  runtime?: {
    mode?: string;
  };
  cache?: {
    enabled?: boolean;
    ttlSeconds?: number;
  };
  meta?: {
    label?: string;
    tags?: string[];
  };
};

type Registry = {
  servers: Record<string, McpServer>;
};

type NormalizedTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type DiscoveryCacheEntry = {
  server: string;
  transport: string;
  generatedAt: string;
  tools: NormalizedTool[];
};

type McpTextContent = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type McpCallResult = {
  content?: McpTextContent[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

function ensurePiboConfigDir() {
  fs.mkdirSync(PIBO_CONFIG_DIR, { recursive: true });
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function readRegistry(): Registry {
  ensurePiboConfigDir();
  return readJsonFile(REGISTRY_PATH, { servers: {} });
}

function writeRegistry(registry: Registry) {
  ensurePiboConfigDir();
  writeJsonFile(REGISTRY_PATH, registry);
}

function readActiveServers(): Record<string, McpServer> {
  const raw = execFileSync("openclaw", ["mcp", "show", "--json"], { encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  return parsed ?? {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseTransport(value: unknown): McpTransport | undefined {
  if (value === "stdio" || value === "http" || value === "streamable-http") {
    return value;
  }
  return undefined;
}

function inferTransport(input: unknown): McpTransport {
  const record = asRecord(input);
  const transport = parseTransport(record?.transport);
  if (transport) {
    return transport;
  }
  if (typeof record?.url === "string" && record.url.trim() !== "") {
    return "streamable-http";
  }
  return "stdio";
}

function validateStringRecord(
  value: unknown,
  fieldName: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`'${fieldName}' muss ein Objekt sein.`);
  }

  const entries = Object.entries(value);
  for (const [key, val] of entries) {
    if (typeof val !== "string") {
      throw new Error(`'${fieldName}.${key}' muss ein String sein.`);
    }
  }

  return Object.fromEntries(entries);
}

function validateServerShape(input: unknown): McpServer {
  const record = asRecord(input);
  if (!record) {
    throw new Error("Server-Definition muss ein JSON-Objekt sein.");
  }

  const hasCommand = typeof record.command === "string" && record.command.trim() !== "";
  const hasUrl = typeof record.url === "string" && record.url.trim() !== "";
  const transport = inferTransport(record);

  if (transport === "stdio" && !hasCommand) {
    throw new Error("Stdio-Server braucht 'command'.");
  }

  if ((transport === "http" || transport === "streamable-http") && !hasUrl) {
    throw new Error("HTTP-Server braucht 'url'.");
  }

  if (record.args !== undefined && !Array.isArray(record.args)) {
    throw new Error("'args' muss ein Array sein.");
  }

  return {
    transport,
    command: typeof record.command === "string" ? record.command : undefined,
    args: Array.isArray(record.args) ? record.args.map(String) : undefined,
    url: typeof record.url === "string" ? record.url : undefined,
    env: validateStringRecord(record.env, "env"),
    headers: validateStringRecord(record.headers, "headers"),
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    runtime: asRecord(record.runtime) as McpServer["runtime"],
    cache: asRecord(record.cache) as McpServer["cache"],
    meta: asRecord(record.meta) as McpServer["meta"],
  };
}

function getCachePath(name: string) {
  return path.join(CACHE_DIR, `${name}.json`);
}

function readCache(name: string): DiscoveryCacheEntry | null {
  const filePath = getCachePath(name);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJsonFile<DiscoveryCacheEntry | null>(filePath, null);
}

function writeCache(name: string, entry: DiscoveryCacheEntry) {
  ensureCacheDir();
  writeJsonFile(getCachePath(name), entry);
}

function isCacheFresh(server: McpServer, cache: DiscoveryCacheEntry | null): boolean {
  if (!cache) {
    return false;
  }
  if (server.cache?.enabled === false) {
    return false;
  }
  const ttlSeconds = server.cache?.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  const generatedAt = Date.parse(cache.generatedAt);
  if (Number.isNaN(generatedAt)) {
    return false;
  }
  return Date.now() - generatedAt <= ttlSeconds * 1000;
}

function getServerTransportLabel(server: McpServer): string {
  if (server.transport === "stdio") {
    return `stdio (${server.command ?? "?"})`;
  }
  return server.transport ?? "unknown";
}

function getRegisteredServer(name: string): McpServer {
  const registry = readRegistry();
  const active = readActiveServers();
  const server = active[name] ?? registry.servers[name];

  if (!server) {
    throw new Error(`MCP-Server nicht gefunden: ${name}`);
  }

  return validateServerShape(server);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toDescription(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function toInputSchema(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeTool(tool: unknown): NormalizedTool {
  const record = asRecord(tool);
  return {
    name: typeof record?.name === "string" ? record.name : "unknown",
    description: toDescription(record?.description),
    inputSchema: toInputSchema(record?.inputSchema),
  };
}

function isIgnorableMcpStderrLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) {
    return true;
  }

  const prefixes = [
    "chrome-devtools-mcp exposes content of the browser instance",
    "debug, and modify any data in the browser or DevTools.",
    "Avoid sharing sensitive or personal information that you do not want to share with MCP clients.",
    "Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data.",
    "so returned values have to be JSON-serializable.",
  ];

  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function attachFilteredStderr(stream: Readable | null): () => void {
  if (!stream) {
    return () => {};
  }

  let buffer = "";
  const handleData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!isIgnorableMcpStderrLine(line)) {
        process.stderr.write(line + "\n");
      }
    }
  };

  const handleEnd = () => {
    const tail = buffer.trim();
    if (tail && !isIgnorableMcpStderrLine(tail)) {
      process.stderr.write(tail + "\n");
    }
  };

  stream.on("data", handleData);
  stream.on("end", handleEnd);
  return () => {
    stream.off("data", handleData);
    stream.off("end", handleEnd);
  };
}

function listDescendantPids(rootPid: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("ps", ["-Ao", "pid=,ppid="], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pidRaw, ppidRaw] = line
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));
    if (!Number.isInteger(pidRaw) || !Number.isInteger(ppidRaw)) {
      continue;
    }
    const children = childrenByParent.get(ppidRaw) ?? [];
    children.push(pidRaw);
    childrenByParent.set(ppidRaw, children);
  }

  const descendants: number[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || descendants.includes(pid)) {
      continue;
    }
    descendants.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function collectOwnedStdioTransportPids(transport: StdioClientTransport): number[] {
  const pid = transport.pid;
  if (pid === null) {
    return [];
  }
  return [...listDescendantPids(pid), pid];
}

function isProcessStillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalOwnedPids(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    if (!isProcessStillAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  }
}

async function connectToServer(
  server: McpServer,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: "pibo-cli", version: "0.1.0" });

  if (server.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: server.command!,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      stderr: "pipe",
    });
    const detachFilteredStderr = attachFilteredStderr(transport.stderr as Readable | null);
    const close = async () => {
      const ownedPids = collectOwnedStdioTransportPids(transport);
      detachFilteredStderr();
      signalOwnedPids(ownedPids, "SIGTERM");
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      signalOwnedPids(ownedPids, "SIGKILL");
    };
    try {
      await client.connect(transport);
    } catch (error) {
      await close();
      throw error;
    }
    return {
      client,
      close,
    };
  }

  const headers = server.headers ? new Headers(server.headers) : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(server.url!), {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      try {
        await transport.terminateSession();
      } catch {
        // ignore
      }
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

async function discoverTools(
  name: string,
  opts?: { refresh?: boolean },
): Promise<DiscoveryCacheEntry> {
  const server = getRegisteredServer(name);
  const cache = readCache(name);

  if (!opts?.refresh && isCacheFresh(server, cache)) {
    return cache!;
  }

  const { client, close } = await connectToServer(server);
  try {
    const result = await client.listTools();
    const entry: DiscoveryCacheEntry = {
      server: name,
      transport: getServerTransportLabel(server),
      generatedAt: new Date().toISOString(),
      tools: (result.tools ?? [])
        .map(normalizeTool)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    };
    writeCache(name, entry);
    return entry;
  } finally {
    await close();
  }
}

function getToolOrThrow(entry: DiscoveryCacheEntry, toolName: string): NormalizedTool {
  const tool = entry.tools.find((item) => item.name === toolName);
  if (!tool) {
    const known = entry.tools.map((item) => item.name).join(", ");
    throw new Error(`Tool nicht gefunden: ${toolName}${known ? `. Verfügbar: ${known}` : ""}`);
  }
  return tool;
}

function summarizeSchema(schema?: Record<string, unknown>): {
  required: string[];
  optional: string[];
} {
  const propertiesRaw = schema?.properties;
  const properties =
    propertiesRaw && typeof propertiesRaw === "object" && !Array.isArray(propertiesRaw)
      ? (propertiesRaw as Record<string, unknown>)
      : {};
  const requiredRaw = schema?.required;
  const required = Array.isArray(requiredRaw) ? requiredRaw.map(String) : [];
  const requiredSet = new Set(required);
  const optional = Object.keys(properties).filter((name) => !requiredSet.has(name));
  return { required, optional };
}

function renderServerHelp(name: string, entry: DiscoveryCacheEntry) {
  console.log(`MCP Server: ${name}`);
  console.log(`Transport: ${entry.transport}`);
  console.log(`Status: ready`);
  console.log("");
  console.log("Available tools:");
  console.log("");

  if (entry.tools.length === 0) {
    console.log("(none)");
  } else {
    for (const tool of entry.tools) {
      console.log(`- ${tool.name}`);
      if (tool.description) {
        console.log(`  ${tool.description}`);
      }
      console.log("");
    }
  }

  console.log("Tip:");
  console.log(`  pibo mcp call ${name} <tool> --help`);
}

function renderToolHelp(name: string, tool: NormalizedTool) {
  const summary = summarizeSchema(tool.inputSchema);

  console.log(`MCP Server: ${name}`);
  console.log(`Tool: ${tool.name}`);
  console.log("");
  console.log("Description:");
  console.log(`  ${tool.description ?? "(none)"}`);
  console.log("");
  console.log("Fields:");
  console.log(`  Required: ${summary.required.length ? summary.required.join(", ") : "(none)"}`);
  console.log(`  Optional: ${summary.optional.length ? summary.optional.join(", ") : "(none)"}`);
  console.log("");
  console.log("Input schema:");
  console.log(formatJson(tool.inputSchema ?? { type: "object", properties: {} }));
  console.log("");
  console.log("Invoke examples:");
  console.log(
    `  pibo mcp call ${name} ${tool.name} --json '${JSON.stringify(buildExamplePayload(tool))}'`,
  );
  console.log(`  pibo mcp call ${name} ${tool.name} --json @payload.json`);
  console.log(
    `  echo '${JSON.stringify(buildExamplePayload(tool))}' | pibo mcp call ${name} ${tool.name} --stdin`,
  );
}

function buildExamplePayload(tool: NormalizedTool): Record<string, unknown> {
  const schema = tool.inputSchema ?? {};
  const propertiesRaw = asRecord(schema.properties);
  const properties =
    propertiesRaw && typeof propertiesRaw === "object" && !Array.isArray(propertiesRaw)
      ? propertiesRaw
      : {};
  const requiredRaw = schema.required;
  const required = Array.isArray(requiredRaw) ? requiredRaw.map(String) : [];

  const payload: Record<string, unknown> = {};
  for (const name of required) {
    payload[name] = buildExampleValue(properties[name]);
  }
  return payload;
}

function buildExampleValue(schema: unknown): unknown {
  const record = asRecord(schema);
  if (!record) {
    return "value";
  }
  if (record.default !== undefined) {
    return record.default;
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return record.enum[0];
  }
  switch (record.type) {
    case "string":
      return "value";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "value";
  }
}

function readPayloadSource(opts: { json?: string; stdin?: boolean }): Record<string, unknown> {
  const sources = [opts.json ? "json" : null, opts.stdin ? "stdin" : null].filter(Boolean);
  if (sources.length !== 1) {
    throw new Error("Genau eine Payload-Quelle angeben: --json oder --stdin.");
  }

  let raw: string;
  if (opts.json) {
    raw = opts.json.startsWith("@")
      ? fs.readFileSync(path.resolve(opts.json.slice(1)), "utf-8")
      : opts.json;
  } else {
    raw = fs.readFileSync(0, "utf-8");
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Payload muss ein JSON-Objekt sein.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Ungültiges JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function formatAge(timestamp: string): string {
  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) {
    return "unknown";
  }

  const diffMs = Date.now() - value;
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function renderDoctorLine(label: string, status: "ok" | "warn" | "fail", detail: string) {
  const icon = status === "ok" ? "✅" : status === "warn" ? "⚠️" : "❌";
  console.log(`${icon} ${label}: ${detail}`);
}

async function runDiscoveryProbe(
  server: McpServer,
): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
  try {
    const { client, close } = await connectToServer(server);
    try {
      const result = await client.listTools();
      return { ok: true, toolCount: (result.tools ?? []).length };
    } finally {
      await close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function renderMcpCallResult(result: McpCallResult) {
  const prefix = result.isError ? "❌" : "✅";
  console.log(`${prefix} MCP call result`);

  const content = Array.isArray(result.content) ? result.content : [];
  const textItems = content.filter(
    (item) => item?.type === "text" && typeof item.text === "string",
  );
  const nonTextItems = content.filter(
    (item) => !(item?.type === "text" && typeof item.text === "string"),
  );

  if (textItems.length > 0) {
    console.log("");
    console.log(
      textItems
        .map((item) => item.text?.trimEnd())
        .filter(Boolean)
        .join("\n\n---\n\n"),
    );
  }

  if (result.structuredContent !== undefined) {
    console.log("");
    console.log("Structured content:");
    console.log(formatJson(result.structuredContent));
  }

  if (nonTextItems.length > 0) {
    console.log("");
    console.log("Other content:");
    console.log(formatJson(nonTextItems));
  }

  const extraEntries = Object.entries(result).filter(
    ([key]) => !["content", "structuredContent", "isError"].includes(key),
  );
  if (extraEntries.length > 0) {
    console.log("");
    console.log("Meta:");
    console.log(formatJson(Object.fromEntries(extraEntries)));
  }
}

export function mcpRegister(name: string, json: string) {
  const server = validateServerShape(JSON.parse(json));
  const registry = readRegistry();
  registry.servers[name] = server;
  writeRegistry(registry);
  console.log(`✅ MCP-Server registriert: ${name}`);
}

export function mcpList() {
  const registry = readRegistry();
  const active = readActiveServers();
  const names = Array.from(
    new Set([...Object.keys(registry.servers), ...Object.keys(active)]),
  ).toSorted();

  if (names.length === 0) {
    console.log("Keine MCP-Server registriert.");
    return;
  }

  for (const name of names) {
    const stored = registry.servers[name];
    const isActive = !!active[name];
    const source = validateServerShape(active[name] ?? stored);
    const mode = source.url ? `url=${source.url}` : `command=${source.command ?? "?"}`;
    console.log(
      `${isActive ? "🟢" : "⚪"} ${name} — ${isActive ? "aktiv" : "inaktiv"} — ${source.transport} — ${mode}`,
    );
  }
}

export function mcpShow(name: string) {
  const registry = readRegistry();
  const active = readActiveServers();
  const server = active[name] ?? registry.servers[name];

  if (!server) {
    throw new Error(`MCP-Server nicht gefunden: ${name}`);
  }

  console.log(
    JSON.stringify(
      {
        name,
        active: !!active[name],
        registered: !!registry.servers[name],
        server: validateServerShape(server),
      },
      null,
      2,
    ),
  );
}

export function mcpEnable(name: string) {
  const registry = readRegistry();
  const server = registry.servers[name];
  if (!server) {
    throw new Error(`MCP-Server ist nicht registriert: ${name}`);
  }

  execFileSync("openclaw", ["mcp", "set", name, JSON.stringify(server)], { stdio: "inherit" });
  console.log(`✅ MCP-Server aktiviert: ${name}`);
}

export function mcpDisable(name: string) {
  const active = readActiveServers();
  if (!active[name]) {
    console.log(`ℹ MCP-Server war nicht aktiv: ${name}`);
    return;
  }

  execFileSync("openclaw", ["mcp", "unset", name], { stdio: "inherit" });
  console.log(`✅ MCP-Server deaktiviert: ${name}`);
}

export function mcpUnregister(name: string, force = false) {
  const active = readActiveServers();
  if (active[name] && !force) {
    throw new Error(`MCP-Server ist noch aktiv: ${name}. Erst deaktivieren oder --force nutzen.`);
  }

  if (active[name] && force) {
    execFileSync("openclaw", ["mcp", "unset", name], { stdio: "inherit" });
  }

  const registry = readRegistry();
  if (!registry.servers[name]) {
    console.log(`ℹ MCP-Server war nicht registriert: ${name}`);
    return;
  }

  delete registry.servers[name];
  writeRegistry(registry);
  console.log(`✅ MCP-Server deregistriert: ${name}`);
}

export async function mcpRefresh(name: string) {
  const entry = await discoverTools(name, { refresh: true });
  console.log(`✅ Discovery aktualisiert: ${name} (${entry.tools.length} Tools)`);
}

export async function mcpTools(name: string, opts?: { refresh?: boolean }) {
  const entry = await discoverTools(name, { refresh: opts?.refresh });
  console.log(`MCP Server: ${name}`);
  console.log(`Transport: ${entry.transport}`);
  console.log("");

  for (const tool of entry.tools) {
    console.log(`- ${tool.name}`);
    console.log(`  ${tool.description ?? "(no description)"}`);
    console.log("");
  }
}

export async function mcpInspect(name: string, toolName?: string, opts?: { refresh?: boolean }) {
  const entry = await discoverTools(name, { refresh: opts?.refresh });
  if (!toolName) {
    console.log(formatJson(entry));
    return;
  }
  console.log(formatJson(getToolOrThrow(entry, toolName)));
}

export async function mcpCallHelp(name: string, toolName?: string, opts?: { refresh?: boolean }) {
  const entry = await discoverTools(name, { refresh: opts?.refresh });
  if (!toolName) {
    renderServerHelp(name, entry);
    return;
  }
  renderToolHelp(name, getToolOrThrow(entry, toolName));
}

export async function mcpCall(
  name: string,
  toolName: string,
  opts: { json?: string; stdin?: boolean },
) {
  const payload = readPayloadSource(opts);
  const server = getRegisteredServer(name);
  const { client, close } = await connectToServer(server);
  try {
    const result = await client.callTool({
      name: toolName,
      arguments: payload,
    });
    renderMcpCallResult(result as McpCallResult);
  } finally {
    await close();
  }
}

export async function mcpDoctor(name: string, opts?: { refresh?: boolean }) {
  const registry = readRegistry();
  const active = readActiveServers();
  const registeredRaw = registry.servers[name];
  const activeRaw = active[name];
  const effectiveRaw = activeRaw ?? registeredRaw;

  console.log(`MCP Doctor: ${name}`);
  console.log("");

  if (!effectiveRaw) {
    renderDoctorLine(
      "registry",
      "fail",
      "server not found in PIBo registry or active OpenClaw state",
    );
    return;
  }

  let server: McpServer;
  try {
    server = validateServerShape(effectiveRaw);
    renderDoctorLine("definition", "ok", `${server.transport} configuration looks valid`);
  } catch (error) {
    renderDoctorLine("definition", "fail", error instanceof Error ? error.message : String(error));
    return;
  }

  renderDoctorLine(
    "registry",
    registeredRaw ? "ok" : "warn",
    registeredRaw ? "registered in PIBo config" : "not registered in PIBo config",
  );
  renderDoctorLine(
    "active",
    activeRaw ? "ok" : "warn",
    activeRaw ? "active in OpenClaw" : "not active in OpenClaw",
  );

  if (server.transport === "stdio") {
    renderDoctorLine("transport", "ok", `stdio via command=${server.command ?? "?"}`);
  } else {
    renderDoctorLine("transport", "ok", `${server.transport} via url=${server.url ?? "?"}`);
  }

  const cache = readCache(name);
  if (!cache) {
    renderDoctorLine("cache", "warn", "no discovery cache present yet");
  } else {
    const fresh = isCacheFresh(server, cache);
    renderDoctorLine(
      "cache",
      fresh ? "ok" : "warn",
      `${cache.tools.length} tools, generated ${cache.generatedAt} (${formatAge(cache.generatedAt)}), ${fresh ? "fresh" : "stale"}`,
    );
  }

  const probe = await runDiscoveryProbe(server);
  if (!probe.ok) {
    renderDoctorLine("runtime", "fail", probe.error ?? "discovery probe failed");
    return;
  }

  renderDoctorLine(
    "runtime",
    "ok",
    `connected successfully, ${probe.toolCount ?? 0} tools visible`,
  );

  if (opts?.refresh) {
    const refreshed = await discoverTools(name, { refresh: true });
    renderDoctorLine("refresh", "ok", `cache refreshed with ${refreshed.tools.length} tools`);
  }
}
