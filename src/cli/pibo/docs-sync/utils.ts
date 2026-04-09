import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
}

function readExecChannel(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8").trim();
  }
  return "";
}

/** Execute command, return trimmed stdout, or null on error */
export function run(cmd: string, cwd?: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** Execute command with full result (stdout, stderr, exit code) */
export function runFull(cmd: string, cwd?: string): RunResult {
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { stdout, stderr: "", exitCode: 0, ok: true };
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error ? readExecChannel(error.stdout) : "";
    const stderr =
      error && typeof error === "object" && "stderr" in error ? readExecChannel(error.stderr) : "";
    const exitCode =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : -1;
    return {
      stdout,
      stderr,
      exitCode,
      ok: false,
    };
  }
}

/** Execute command, return trimmed stdout, throw on error */
export function runOrThrow(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Check if a command exists */
export function commandExists(cmd: string): boolean {
  return run(`command -v ${cmd}`) !== null;
}

/** Check if a systemd service is running (user or system) */
export function serviceRunning(name: string, user = false): boolean {
  const flag = user ? "--user" : "";
  const result = run(`systemctl ${flag} is-active ${name} 2>/dev/null`);
  return result === "active";
}

/** Check SSH connection to host */
export function sshCheck(host: string, user = "root", keyPath?: string): boolean {
  const keyOpt = keyPath ? `-i ${keyPath} -o IdentitiesOnly=yes` : "";
  const result = run(
    `ssh ${keyOpt} -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no ${user}@${host} "echo ok" 2>/dev/null`,
  );
  return result === "ok";
}

/** Check git repo at path */
export function gitRepoCheck(path: string): boolean {
  return (
    existsSync(`${path}/.git`) || run(`git -C ${path} rev-parse --git-dir 2>/dev/null`) !== null
  );
}

/** Get Node.js binary path */
export function nodeBin(): string {
  return runOrThrow("which node");
}

/** Get Node.js version */
export function nodeVersion(): string {
  return runOrThrow("node --version");
}

/** Color helpers */
export const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
export const fail = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
export const warn = (s: string) => `\x1b[33m⚠\x1b[0m ${s}`;
export const info = (s: string) => `\x1b[36mℹ\x1b[0m ${s}`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Read file, return null if missing */
export function readSafe(p: string): string | null {
  if (!existsSync(p)) {
    return null;
  }
  return readFileSync(p, "utf8");
}

/** Write file, create parent dirs if needed */
export function writeSafe(p: string, content: string) {
  const { mkdirSync } = require("fs");
  const { dirname } = require("path");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Generate a random token */
export function generateToken(): string {
  const { randomBytes } = require("crypto");
  return randomBytes(32).toString("hex");
}
