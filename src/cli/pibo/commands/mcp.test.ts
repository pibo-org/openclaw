import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeExecutable } from "../../../agents/bundle-mcp-shared.test-harness.js";
import { withTempHome } from "../../../config/home-env.test-harness.js";

const execFileSyncMock = vi.hoisted(() => vi.fn(() => "{}"));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");

async function writeLingeringProbeServer(filePath: string, exitMarkerPath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};

process.once("SIGTERM", () => process.exit(0));
process.stdin.on("end", () => {
  setInterval(() => {}, 10_000);
});
process.once("exit", () => {
  try {
    fs.writeFileSync(${JSON.stringify(exitMarkerPath)}, "exited", "utf8");
  } catch {}
});

const server = new McpServer({ name: "linger-probe", version: "1.0.0" });
server.tool("bundle_probe", "Probe tool", async () => {
  return {
    content: [{ type: "text", text: process.env.BUNDLE_PROBE_TEXT ?? "missing-probe-text" }],
  };
});

await server.connect(new StdioServerTransport());
`,
  );
}

async function writeProbeWrapperServer(filePath: string, wrappedServerPath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [${JSON.stringify(wrappedServerPath)}], {
  env: {
    ...process.env,
    BUNDLE_PROBE_TEXT: process.env.BUNDLE_PROBE_TEXT ?? "missing-probe-text",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

process.once("SIGTERM", () => process.exit(0));
`,
  );
}

describe("pibo mcp command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileSyncMock.mockReturnValue("{}");
  });

  it("reads active MCP servers through the current OpenClaw checkout", async () => {
    vi.resetModules();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { mcpList } = await import("./mcp.js");
      mcpList();

      expect(execFileSyncMock).toHaveBeenCalledWith(
        process.execPath,
        [path.join(process.cwd(), "openclaw.mjs"), "mcp", "show", "--json"],
        { encoding: "utf-8" },
      );
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it("terminates owned stdio servers promptly after a successful tool call", async () => {
    await withTempHome("openclaw-pibo-mcp-home-", async (home) => {
      const wrappedServerPath = path.join(home, "linger-probe-child.mjs");
      const wrapperServerPath = path.join(home, "linger-probe-wrapper.mjs");
      const exitMarkerPath = path.join(home, "linger-probe.exit");
      await writeLingeringProbeServer(wrappedServerPath, exitMarkerPath);
      await writeProbeWrapperServer(wrapperServerPath, wrappedServerPath);

      vi.resetModules();
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { mcpCall, mcpRegister } = await import("./mcp.js");
        mcpRegister(
          "probe",
          JSON.stringify({
            command: "node",
            args: [wrapperServerPath],
            env: { BUNDLE_PROBE_TEXT: "HELLO" },
          }),
        );

        const startedAt = Date.now();
        await mcpCall("probe", "bundle_probe", { json: "{}" });
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(1500);
        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(await fs.readFile(exitMarkerPath, "utf8")).toBe("exited");
        expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain("HELLO");
      } finally {
        consoleLogSpy.mockRestore();
      }
    });
  });

  it("does not fall back to active OpenClaw MCP servers for PIBo CLI discovery", async () => {
    await withTempHome("openclaw-pibo-mcp-home-", async (home) => {
      const wrappedServerPath = path.join(home, "active-only-child.mjs");
      const wrapperServerPath = path.join(home, "active-only-wrapper.mjs");
      const exitMarkerPath = path.join(home, "active-only.exit");
      await writeLingeringProbeServer(wrappedServerPath, exitMarkerPath);
      await writeProbeWrapperServer(wrapperServerPath, wrappedServerPath);

      execFileSyncMock.mockReturnValue(
        JSON.stringify({
          activeOnly: {
            command: "node",
            args: [wrapperServerPath],
          },
        }),
      );

      vi.resetModules();
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { mcpTools } = await import("./mcp.js");
        await expect(mcpTools("activeOnly")).rejects.toThrow(
          "MCP-Server ist nur in OpenClaw aktiv: activeOnly",
        );
        expect(consoleLogSpy).not.toHaveBeenCalled();
      } finally {
        consoleLogSpy.mockRestore();
      }
    });
  });

  it("runs doctor successfully from the PIBo registry even when the server is absent from OpenClaw", async () => {
    await withTempHome("openclaw-pibo-mcp-home-", async (home) => {
      const wrappedServerPath = path.join(home, "doctor-probe-child.mjs");
      const wrapperServerPath = path.join(home, "doctor-probe-wrapper.mjs");
      const exitMarkerPath = path.join(home, "doctor-probe.exit");
      await writeLingeringProbeServer(wrappedServerPath, exitMarkerPath);
      await writeProbeWrapperServer(wrapperServerPath, wrappedServerPath);

      vi.resetModules();
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { mcpDoctor, mcpRegister } = await import("./mcp.js");
        mcpRegister(
          "probe",
          JSON.stringify({
            command: "node",
            args: [wrapperServerPath],
            env: { BUNDLE_PROBE_TEXT: "DOCTOR" },
          }),
        );

        await mcpDoctor("probe");

        const output = consoleLogSpy.mock.calls.flat().join("\n");
        expect(output).toContain("registered in PIBo config");
        expect(output).toContain("not active in OpenClaw");
        expect(output).toContain("connected successfully, 1 tools visible");
        expect(await fs.readFile(exitMarkerPath, "utf8")).toBe("exited");
      } finally {
        consoleLogSpy.mockRestore();
      }
    });
  });
});
