import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import {
  bold,
  commandExists,
  fail,
  info,
  ok,
  run,
  runFull,
  serviceRunning,
  warn,
  writeSafe,
  nodeBin,
} from "../docs-sync/utils.js";
import type { LocalSyncTarget } from "./config.js";

export {
  bold,
  commandExists,
  fail,
  info,
  ok,
  run,
  runFull,
  serviceRunning,
  warn,
  writeSafe,
  nodeBin,
};

export function targetScriptsDir(): string {
  return join(homedir(), "local-sync");
}

export function targetStateDir(): string {
  return join(homedir(), ".local", "state", "pibo-local-sync");
}

export function serviceFilePath(serviceName: string): string {
  return join(homedir(), ".config", "systemd", "user", `${serviceName}.service`);
}

export function timerFilePath(timerName: string): string {
  return join(homedir(), ".config", "systemd", "user", `${timerName}.timer`);
}

export function ensureParent(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

export function targetMetaPath(name: string): string {
  return join(targetStateDir(), `${name}.json`);
}

export function scriptBaseName(name: string): string {
  return `pibo-local-sync-${name}`;
}

export function watcherScriptPath(name: string): string {
  return join(targetScriptsDir(), `${scriptBaseName(name)}-watcher.js`);
}

export function pushScriptPath(name: string): string {
  return join(targetScriptsDir(), `${scriptBaseName(name)}-push.sh`);
}

export function serviceNameFor(name: string): string {
  return `pibo-local-sync-${name}`;
}

export function slugifyName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

export function validateName(name: string): string | null {
  if (!name) {
    return "Name darf nicht leer sein";
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return "Name muss mit Buchstaben starten und darf nur a-z, 0-9, _ und - enthalten";
  }
  return null;
}

export function writeTargetMeta(target: LocalSyncTarget) {
  const p = targetMetaPath(target.name);
  ensureParent(p);
  writeFileSync(p, JSON.stringify(target, null, 2));
}

export function removeTargetFiles(target: LocalSyncTarget) {
  for (const p of [
    watcherScriptPath(target.name),
    pushScriptPath(target.name),
    targetMetaPath(target.name),
    serviceFilePath(target.serviceName),
    serviceFilePath(`${target.serviceName}-reconcile`),
    timerFilePath(`${target.serviceName}-reconcile`),
  ]) {
    try {
      if (existsSync(p)) {
        rmSync(p, { force: true });
      }
    } catch {}
  }
}

export function writeExecutable(path: string, content: string) {
  ensureParent(path);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

export function writeUtf8(path: string, content: string) {
  ensureParent(path);
  writeFileSync(path, content, "utf8");
}

export function readTargetMeta(name: string): LocalSyncTarget | null {
  const p = targetMetaPath(name);
  if (!existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LocalSyncTarget;
  } catch {
    return null;
  }
}
