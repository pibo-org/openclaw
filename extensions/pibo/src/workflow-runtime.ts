import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolvePiboExecutable(): { command: string; argsPrefix: string[] } {
  const repoBin = path.resolve("/home/pibo/code/pibo-cli/bin/pibo");
  if (fs.existsSync(repoBin)) {
    return { command: repoBin, argsPrefix: [] };
  }
  const repoDist = path.resolve("/home/pibo/code/pibo-cli/dist/index.js");
  if (fs.existsSync(repoDist)) {
    return { command: "node", argsPrefix: [repoDist] };
  }
  return { command: "pibo", argsPrefix: [] };
}

export async function runPiboWorkflows(args: string[]): Promise<string> {
  const runtime = resolvePiboExecutable();
  const { stdout, stderr } = await execFileAsync(
    runtime.command,
    [...runtime.argsPrefix, "workflows", ...args],
    {
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    },
  );
  const text = stdout.trim() || stderr.trim();
  return text.length > 0 ? text : "⚠️ Keine Ausgabe erhalten.";
}

export async function runPiboWorkflowsJson(args: string[]): Promise<unknown> {
  const text = await runPiboWorkflows(args);
  return JSON.parse(text);
}
