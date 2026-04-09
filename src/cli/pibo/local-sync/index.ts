import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { Command } from "commander";
import { getConfigPath, getTarget, readRegistry, removeTarget, type LocalSyncTarget, upsertTarget } from "./config.js";
import {
  bold,
  commandExists,
  fail,
  info,
  nodeBin,
  ok,
  readTargetMeta,
  removeTargetFiles,
  run,
  runFull,
  serviceFilePath,
  serviceNameFor,
  slugifyName,
  targetScriptsDir,
  targetStateDir,
  validateName,
  warn,
  watcherScriptPath,
  writeExecutable,
  writeTargetMeta,
  writeUtf8,
  pushScriptPath,
} from "./utils.js";

function expandPath(input: string): string {
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  if (input === "~") return homedir();
  return resolve(input);
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultIgnoreGlobs(): string[] {
  return [
    ".git",
    ".trash",
    ".clawhub",
    "node_modules",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.webp",
    "*.pdf",
  ];
}

function buildTarget(name: string, pathArg: string, repo: string, branch: string): LocalSyncTarget {
  const now = nowIso();
  return {
    name,
    path: expandPath(pathArg),
    repo,
    branch,
    enabled: true,
    ignoreGlobs: defaultIgnoreGlobs(),
    serviceName: serviceNameFor(name),
    createdAt: now,
    updatedAt: now,
  };
}

function ensureGitRepo(target: LocalSyncTarget): string | null {
  if (!existsSync(target.path)) return `Pfad existiert nicht: ${target.path}`;
  if (!existsSync(join(target.path, ".git"))) return `Kein Git-Repo: ${target.path}`;
  return null;
}

function ensureRemoteConfigured(target: LocalSyncTarget): string | null {
  const current = run(`git -C ${target.path} remote get-url origin 2>/dev/null`) || "";
  if (!current) {
    const add = runFull(`git -C ${target.path} remote add origin ${JSON.stringify(target.repo)}`);
    if (!add.ok) return add.stderr || "origin konnte nicht gesetzt werden";
    return null;
  }
  if (current.trim() !== target.repo.trim()) {
    const set = runFull(`git -C ${target.path} remote set-url origin ${JSON.stringify(target.repo)}`);
    if (!set.ok) return set.stderr || "origin konnte nicht aktualisiert werden";
  }
  return null;
}

function generateWatcherScript(target: LocalSyncTarget): string {
  const ignoreChecks = [
    `if (!filepath) return false;`,
    ...target.ignoreGlobs.map((g) => {
      if (g.startsWith("*.")) {
        const ext = g.slice(1);
        return `if (filepath.endsWith(${JSON.stringify(ext)})) return false;`;
      }
      if (g.includes("*")) return `if (filepath.includes(${JSON.stringify(g.replace(/\*/g, ""))})) return false;`;
      return `if (filepath === ${JSON.stringify(g)} || filepath.startsWith(${JSON.stringify(g + "/")}) || filepath.includes(${JSON.stringify("/" + g + "/")})) return false;`;
    }),
    `return true;`,
  ].join("\n  ");

  return `#!/usr/bin/env node
import { watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TARGET_DIR = ${JSON.stringify(target.path)};
const PUSH_SCRIPT = ${JSON.stringify(pushScriptPath(target.name))};
const DEBOUNCE_MS = 2000;

let debounceTimer = null;
let changeCount = 0;
const seenEvents = new Set();

function shouldProcessFile(filepath) {
  ${ignoreChecks}
}

function debouncePush(changedFile) {
  const dedupKey = \`${"${changedFile}"}-${"${Date.now() - (Date.now() % 500)}"}\`;
  if (seenEvents.has(dedupKey)) return;
  seenEvents.clear();
  seenEvents.add(dedupKey);

  changeCount++;
  if (debounceTimer) clearTimeout(debounceTimer);
  console.log(\`[${"${new Date().toISOString()}"}] Change: ${"${changedFile}"} (batch: ${"${changeCount}"})\`);

  debounceTimer = setTimeout(async () => {
    console.log(\`[${"${new Date().toISOString()}"}] Debounce done — syncing ${"${changeCount}"} change(s)\`);
    changeCount = 0;
    try {
      const { stdout } = await execFileAsync('bash', [PUSH_SCRIPT], { timeout: 30000 });
      if (stdout.trim()) console.log(\`[${"${new Date().toISOString()}"}] ${"${stdout.trim()}"}\`);
    } catch (err) {
      if (err.stdout) console.log(\`  ${"${err.stdout.trim()}"}\`);
      if (err.stderr) console.error(\`  Error: ${"${err.stderr?.trim()}"}\`);
    }
  }, DEBOUNCE_MS);
}

console.log(\`[${"${new Date().toISOString()}"}] Starting local sync watcher: ${"${TARGET_DIR}"}\`);
const watcher = watch(TARGET_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  if (!shouldProcessFile(filename)) return;
  debouncePush(\`${"${eventType}"} ${"${filename}"}\`);
});

watcher.on('error', (err) => {
  console.error(\`[${"${new Date().toISOString()}"}] Watcher error: ${"${err.message}"}\`);
});

console.log(\`[${"${new Date().toISOString()}"}] Watching for changes...\`);
process.on('SIGINT', () => { watcher.close(); process.exit(0); });
process.on('SIGTERM', () => { watcher.close(); process.exit(0); });
`;
}

function generatePushScript(target: LocalSyncTarget): string {
  return `#!/usr/bin/env bash
set -euo pipefail
cd ${JSON.stringify(target.path)}

git add -A

if ! git diff --cached --quiet 2>/dev/null || ! git diff --quiet 2>/dev/null; then
  git commit -m "auto: ${target.name} write $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1 || true
fi

do_push() {
  if git push origin ${target.branch} 2>/dev/null; then
    return 0
  fi

  git fetch origin ${target.branch} 2>/dev/null || { echo "Fetch failed — will retry later" >&2; return 1; }

  REMOTE=$(git rev-parse FETCH_HEAD)
  LOCAL=$(git rev-parse HEAD)
  if [ "$REMOTE" = "$LOCAL" ]; then
    return 0
  fi

  local rebase_ok=0
  git rebase FETCH_HEAD 2>/dev/null || rebase_ok=1
  if [ "$rebase_ok" -eq 0 ]; then
    git push origin ${target.branch} 2>/dev/null || { echo "Push after rebase failed" >&2; return 1; }
    return 0
  fi

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Rebase conflict — preserving local files, accepting remote" >&2
  git rebase --abort 2>/dev/null || true

  SAVE_DIR=$(mktemp -d)
  git ls-tree -r --name-only HEAD | while read -r f; do
    mkdir -p "$SAVE_DIR/$(dirname "$f")"
    git show HEAD:"$f" > "$SAVE_DIR/$f" 2>/dev/null || true
  done

  git reset --hard FETCH_HEAD 2>/dev/null || true

  find "$SAVE_DIR" -type f | while read -r saved; do
    rel="${"${saved#$SAVE_DIR/}"}"
    mkdir -p "$(dirname "$rel")"
    cp "$saved" "$rel"
    git add "$rel"
  done

  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "auto: ${target.name} write (preserved) $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1 || true
    git push origin ${target.branch} 2>/dev/null || echo "Push of preserved files failed" >&2
  fi

  rm -rf "$SAVE_DIR"
  return 0
}

do_push
`;
}

function generateServiceFile(target: LocalSyncTarget): string {
  const node = nodeBin();
  const nodeDir = dirname(node);
  return `[Unit]
Description=PIBo Local Sync Watcher (${target.name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${watcherScriptPath(target.name)}
Restart=always
RestartSec=5
WorkingDirectory=${target.path}
Environment=HOME=${homedir()}
Environment=PATH=${nodeDir}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}

[Install]
WantedBy=default.target
`;
}

function installTarget(target: LocalSyncTarget): string[] {
  const notes: string[] = [];
  mkdirSync(targetScriptsDir(), { recursive: true });
  mkdirSync(targetStateDir(), { recursive: true });
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });

  writeTargetMeta(target);
  writeExecutable(pushScriptPath(target.name), generatePushScript(target));
  writeUtf8(watcherScriptPath(target.name), generateWatcherScript(target));
  chmodSync(watcherScriptPath(target.name), 0o755);
  writeUtf8(serviceFilePath(target.serviceName), generateServiceFile(target));

  run(`systemctl --user daemon-reload`);
  run(`systemctl --user enable --now ${target.serviceName}.service`);
  notes.push(`Service ${target.serviceName}.service aktiviert`);
  return notes;
}

function printTarget(target: LocalSyncTarget) {
  const active = run(`systemctl --user is-active ${target.serviceName}.service`) || "inactive";
  console.log(`${target.name}\n  path: ${target.path}\n  repo: ${target.repo}\n  branch: ${target.branch}\n  enabled: ${target.enabled ? "yes" : "no"}\n  service: ${target.serviceName}.service (${active})`);
}

function addTarget(nameArg: string, opts: { path?: string; repo?: string; branch?: string }) {
  const name = slugifyName(nameArg);
  const nameErr = validateName(name);
  if (nameErr) {
    console.log(fail(nameErr));
    process.exit(1);
  }
  if (!opts.path || !opts.repo) {
    console.log(fail("Benötigt: --path und --repo"));
    process.exit(1);
  }
  const existing = getTarget(name);
  const target = buildTarget(name, opts.path, opts.repo, opts.branch || "main");
  if (existing) {
    target.createdAt = existing.createdAt;
  }

  const gitErr = ensureGitRepo(target);
  if (gitErr) {
    console.log(fail(gitErr));
    process.exit(1);
  }
  const remoteErr = ensureRemoteConfigured(target);
  if (remoteErr) {
    console.log(fail(remoteErr));
    process.exit(1);
  }

  upsertTarget(target);
  const notes = installTarget(target);
  console.log(ok(`Local Sync Target gespeichert: ${name}`));
  notes.forEach((n) => console.log(info(n)));
  printTarget(target);
}

function listTargets() {
  const registry = readRegistry();
  console.log(bold("\n🔁 Local Sync Targets"));
  console.log("═".repeat(50));
  if (!registry.targets.length) {
    console.log(warn(`Keine Targets registriert. Config: ${getConfigPath()}`));
    return;
  }
  registry.targets.forEach((t) => {
    printTarget(t);
    console.log("");
  });
}

function statusTarget(name?: string) {
  const registry = readRegistry();
  const targets = name ? registry.targets.filter((t) => t.name === name) : registry.targets;
  if (!targets.length) {
    console.log(warn(name ? `Target nicht gefunden: ${name}` : "Keine Targets registriert"));
    return;
  }
  console.log(bold("\n📊 Local Sync Status"));
  console.log("═".repeat(50));
  for (const target of targets) {
    const service = run(`systemctl --user is-active ${target.serviceName}.service`) || "inactive";
    const origin = run(`git -C ${target.path} remote get-url origin 2>/dev/null`) || "-";
    const branch = run(`git -C ${target.path} branch --show-current 2>/dev/null`) || "-";
    const last = run(`git -C ${target.path} log -1 --format="%s (%cr)" 2>/dev/null`) || "-";
    console.log(`${target.name}`);
    console.log(`  service: ${service}`);
    console.log(`  branch: ${branch}`);
    console.log(`  origin: ${origin}`);
    console.log(`  last: ${last}`);
  }
}

function doctorTarget(name?: string) {
  const registry = readRegistry();
  const targets = name ? registry.targets.filter((t) => t.name === name) : registry.targets;
  if (!targets.length) {
    console.log(warn(name ? `Target nicht gefunden: ${name}` : "Keine Targets registriert"));
    return;
  }
  console.log(bold("\n🩺 Local Sync Doctor"));
  console.log("═".repeat(50));
  console.log(commandExists("git") ? ok("git vorhanden") : fail("git fehlt"));
  console.log(commandExists("systemctl") ? ok("systemctl vorhanden") : fail("systemctl fehlt"));
  for (const target of targets) {
    console.log(`\n${target.name}:`);
    console.log(existsSync(target.path) ? ok(`Pfad vorhanden: ${target.path}`) : fail(`Pfad fehlt: ${target.path}`));
    console.log(existsSync(join(target.path, ".git")) ? ok("Git-Repo erkannt") : fail("Kein Git-Repo"));
    console.log(existsSync(watcherScriptPath(target.name)) ? ok("Watcher-Script vorhanden") : fail("Watcher-Script fehlt"));
    console.log(existsSync(pushScriptPath(target.name)) ? ok("Push-Script vorhanden") : fail("Push-Script fehlt"));
    console.log(existsSync(serviceFilePath(target.serviceName)) ? ok("Service-File vorhanden") : fail("Service-File fehlt"));
    const remote = run(`git -C ${target.path} remote get-url origin 2>/dev/null`) || "";
    console.log(remote ? ok(`origin gesetzt: ${remote}`) : fail("origin fehlt"));
  }
}

function logsTarget(name: string, lines = 40) {
  const target = getTarget(name);
  if (!target) {
    console.log(fail(`Target nicht gefunden: ${name}`));
    process.exit(1);
  }
  const output = run(`journalctl --user -u ${target.serviceName}.service --no-pager -n ${lines}`);
  console.log(output || warn("Keine Logs gefunden"));
}

function enableTarget(name: string) {
  const target = getTarget(name);
  if (!target) {
    console.log(fail(`Target nicht gefunden: ${name}`));
    process.exit(1);
  }
  run(`systemctl --user enable --now ${target.serviceName}.service`);
  target.enabled = true;
  target.updatedAt = nowIso();
  upsertTarget(target);
  console.log(ok(`Aktiviert: ${name}`));
}

function disableTarget(name: string) {
  const target = getTarget(name);
  if (!target) {
    console.log(fail(`Target nicht gefunden: ${name}`));
    process.exit(1);
  }
  run(`systemctl --user disable --now ${target.serviceName}.service`);
  target.enabled = false;
  target.updatedAt = nowIso();
  upsertTarget(target);
  console.log(ok(`Deaktiviert: ${name}`));
}

function runTarget(name: string) {
  const target = getTarget(name);
  if (!target) {
    console.log(fail(`Target nicht gefunden: ${name}`));
    process.exit(1);
  }
  const result = runFull(`bash ${pushScriptPath(target.name)}`);
  if (!result.ok) {
    console.log(fail(result.stderr || "Sync-Lauf fehlgeschlagen"));
    process.exit(1);
  }
  console.log(ok(`Sync-Lauf fertig: ${name}`));
  if (result.stdout) console.log(result.stdout);
}

function removeTargetCommand(name: string) {
  const target = getTarget(name);
  if (!target) {
    console.log(fail(`Target nicht gefunden: ${name}`));
    process.exit(1);
  }
  run(`systemctl --user disable --now ${target.serviceName}.service`);
  removeTargetFiles(target);
  removeTarget(name);
  run(`systemctl --user daemon-reload`);
  console.log(ok(`Entfernt: ${name}`));
}

export function localSync() {
  const cmd = new Command("local-sync").description("Generischer lokaler Repo-Sync per Watcher + Auto-Push");

  cmd
    .command("add <name>")
    .description("Neues lokales Sync-Target registrieren und installieren")
    .requiredOption("--path <dir>", "Lokaler Ordner")
    .requiredOption("--repo <url>", "Git-Remote URL")
    .option("--branch <name>", "Branch", "main")
    .action((name, opts) => addTarget(name, opts));

  cmd
    .command("list")
    .description("Registrierte Targets anzeigen")
    .action(listTargets);

  cmd
    .command("status [name]")
    .description("Status für alle oder ein Target anzeigen")
    .action((name) => statusTarget(name));

  cmd
    .command("doctor [name]")
    .description("Konfiguration und Dateien prüfen")
    .action((name) => doctorTarget(name));

  cmd
    .command("logs <name>")
    .description("Journal-Logs des Watchers zeigen")
    .option("--lines <n>", "Anzahl Zeilen", "40")
    .action((name, opts) => logsTarget(name, parseInt(opts.lines, 10) || 40));

  cmd
    .command("enable <name>")
    .description("Watcher-Service aktivieren")
    .action((name) => enableTarget(name));

  cmd
    .command("disable <name>")
    .description("Watcher-Service deaktivieren")
    .action((name) => disableTarget(name));

  cmd
    .command("run <name>")
    .description("Manuellen Sync-Lauf auslösen")
    .action((name) => runTarget(name));

  cmd
    .command("remove <name>")
    .description("Target entfernen und Service/Skripte aufräumen")
    .action((name) => removeTargetCommand(name));

  return cmd;
}
