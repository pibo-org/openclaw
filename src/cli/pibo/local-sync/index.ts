import { existsSync, mkdirSync, chmodSync, rmSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { Command } from "commander";
import {
  getConfigPath,
  getTarget,
  readRegistry,
  removeTarget,
  type LocalSyncTarget,
  upsertTarget,
} from "./config.js";
import {
  bold,
  commandExists,
  fail,
  info,
  nodeBin,
  ok,
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
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  if (input === "~") {
    return homedir();
  }
  return resolve(input);
}

function nowIso(): string {
  return new Date().toISOString();
}

const WORKSPACE_TARGET_NAME = "workspace";
const LEGACY_WORKSPACE_SERVICE_NAMES = ["pibo-workspace-watcher"];

function defaultWorkspacePath(): string {
  return join(homedir(), ".openclaw", "workspace");
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

function gitRemote(path: string): string | null {
  return run(`git -C ${JSON.stringify(path)} remote get-url origin 2>/dev/null`) || null;
}

function gitBranch(path: string): string | null {
  return run(`git -C ${JSON.stringify(path)} branch --show-current 2>/dev/null`) || null;
}

function ensureGitRepo(target: LocalSyncTarget): string | null {
  if (!existsSync(target.path)) {
    return `Pfad existiert nicht: ${target.path}`;
  }
  if (!existsSync(join(target.path, ".git"))) {
    return `Kein Git-Repo: ${target.path}`;
  }
  return null;
}

function ensureRemoteConfigured(target: LocalSyncTarget): string | null {
  const current = run(`git -C ${target.path} remote get-url origin 2>/dev/null`) || "";
  if (!current) {
    const add = runFull(`git -C ${target.path} remote add origin ${JSON.stringify(target.repo)}`);
    if (!add.ok) {
      return add.stderr || "origin konnte nicht gesetzt werden";
    }
    return null;
  }
  if (current.trim() !== target.repo.trim()) {
    const set = runFull(
      `git -C ${target.path} remote set-url origin ${JSON.stringify(target.repo)}`,
    );
    if (!set.ok) {
      return set.stderr || "origin konnte nicht aktualisiert werden";
    }
  }
  return null;
}

export function generateWatcherScript(target: LocalSyncTarget): string {
  const configuredIgnoreGlobs = target.ignoreGlobs.filter((glob) => glob !== ".git");
  return `#!/usr/bin/env node
import { existsSync, readFileSync, watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const TARGET_DIR = ${JSON.stringify(target.path)};
const GITIGNORE_FILE = \`\${TARGET_DIR}/.gitignore\`;
const PUSH_SCRIPT = ${JSON.stringify(pushScriptPath(target.name))};
const DEBOUNCE_MS = 2000;
const THIS_FILE = fileURLToPath(import.meta.url);
const CONFIGURED_IGNORE_GLOBS = ${JSON.stringify(configuredIgnoreGlobs)};
const ignoreRules = loadIgnoreRules(GITIGNORE_FILE, CONFIGURED_IGNORE_GLOBS);

let debounceTimer = null;
let changeCount = 0;
const seenEvents = new Set();

export function normalizePath(filepath) {
  return String(filepath).replaceAll("\\\\", "/").replace(/^\\.\\/+/, "").replace(/^\\/+/, "");
}

function isGitPath(filepath) {
  const normalized = normalizePath(filepath);
  return normalized === ".git" || normalized.startsWith(".git/") || normalized.includes("/.git/");
}

export function loadIgnoreRules(ignoreFile, configuredGlobs = []) {
  const lines = [...configuredGlobs];
  if (existsSync(ignoreFile)) {
    lines.push(...readFileSync(ignoreFile, "utf8").split(/\\r?\\n/));
  }

  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const rawPattern = negated ? line.slice(1) : line;
      const rootOnly = rawPattern.startsWith("/");
      const normalized = normalizePath(rawPattern);
      return {
        negated,
        directoryOnly: normalized.endsWith("/"),
        rootOnly,
        pattern: normalized.replace(/^\\/+/, "").replace(/\\/+$/, ""),
      };
    })
    .filter((rule) => rule.pattern && rule.pattern !== ".git");
}

function pathSegments(filepath) {
  return normalizePath(filepath).split("/").filter(Boolean);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&");
  const globbed = escaped.replace(/\\*\\*/g, ".*").replace(/\\*/g, "[^/]*");
  return new RegExp(\`^\${globbed}$\`);
}

function matchesRule(filepath, rule) {
  const normalized = normalizePath(filepath);
  const segments = pathSegments(normalized);

  if (rule.directoryOnly) {
    if (rule.rootOnly) {
      return normalized === rule.pattern || normalized.startsWith(\`\${rule.pattern}/\`);
    }
    return segments.some((segment, index) => {
      if (segment !== rule.pattern) return false;
      return index === segments.length - 1 || normalized.includes(\`\${rule.pattern}/\`);
    });
  }

  const matcher = globToRegExp(rule.pattern);
  if (rule.rootOnly) {
    return matcher.test(normalized);
  }
  if (rule.pattern.includes("/")) {
    return normalized
      .split("/")
      .some((_, index, parts) => matcher.test(parts.slice(index).join("/")));
  }

  return segments.some((segment) => matcher.test(segment));
}

function isIgnoredByRules(filepath, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (!matchesRule(filepath, rule)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

export function shouldProcessFile(filepath, rules = ignoreRules) {
  if (!filepath) return false;
  if (isGitPath(filepath)) return false;
  return !isIgnoredByRules(filepath, rules);
}

function debouncePush(changedFile) {
  const dedupKey = \`\${changedFile}-\${Date.now() - (Date.now() % 500)}\`;
  if (seenEvents.has(dedupKey)) return;
  seenEvents.clear();
  seenEvents.add(dedupKey);

  changeCount++;
  if (debounceTimer) clearTimeout(debounceTimer);
  console.log(\`[\${new Date().toISOString()}] Change: \${changedFile} (batch: \${changeCount})\`);

  debounceTimer = setTimeout(async () => {
    console.log(\`[\${new Date().toISOString()}] Debounce done - syncing \${changeCount} change(s)\`);
    changeCount = 0;
    try {
      const { stdout } = await execFileAsync('bash', [PUSH_SCRIPT], { timeout: 30000 });
      if (stdout.trim()) console.log(\`[\${new Date().toISOString()}] \${stdout.trim()}\`);
    } catch (err) {
      if (err.stdout) console.log(\`  \${err.stdout.trim()}\`);
      if (err.stderr) console.error(\`  Error: \${err.stderr?.trim()}\`);
    }
  }, DEBOUNCE_MS);
}

function startWatcher() {
  console.log(\`[\${new Date().toISOString()}] Starting local sync watcher: \${TARGET_DIR}\`);
  console.log(\`[\${new Date().toISOString()}] Loading ignore rules from: \${GITIGNORE_FILE}\`);
  const watcher = watch(TARGET_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (!shouldProcessFile(filename)) return;
    debouncePush(\`\${eventType} \${filename}\`);
  });

  watcher.on('error', (err) => {
    console.error(\`[\${new Date().toISOString()}] Watcher error: \${err.message}\`);
  });

  console.log(\`[\${new Date().toISOString()}] Watching for changes...\`);
  process.on('SIGINT', () => { watcher.close(); process.exit(0); });
  process.on('SIGTERM', () => { watcher.close(); process.exit(0); });
}

if (process.argv[1] === THIS_FILE) {
  startWatcher();
}
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
    rel="\${saved#$SAVE_DIR/}"
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

interface LegacyWorkspaceMigrationDeps {
  runCommand?: (command: string) => string | null;
  exists?: (path: string) => boolean;
  removeFile?: (path: string) => void;
  serviceFilePathFor?: (serviceName: string) => string;
}

export function migrateLegacyWorkspaceServices(deps: LegacyWorkspaceMigrationDeps = {}): string[] {
  const runCommand = deps.runCommand || run;
  const exists = deps.exists || existsSync;
  const removeFile =
    deps.removeFile ||
    ((path: string) => {
      rmSync(path, { force: true });
    });
  const servicePathFor = deps.serviceFilePathFor || serviceFilePath;
  const notes: string[] = [];

  for (const serviceName of LEGACY_WORKSPACE_SERVICE_NAMES) {
    const path = servicePathFor(serviceName);
    const serviceExisted = exists(path);
    if (!serviceExisted) {
      continue;
    }
    runCommand(`systemctl --user disable --now ${serviceName}.service`);
    removeFile(path);
    notes.push(`Legacy-Service ${serviceName}.service deaktiviert und entfernt`);
  }

  if (notes.length > 0) {
    runCommand(`systemctl --user daemon-reload`);
  }
  return notes;
}

function printTarget(target: LocalSyncTarget) {
  const active = run(`systemctl --user is-active ${target.serviceName}.service`) || "inactive";
  console.log(
    `${target.name}\n  path: ${target.path}\n  repo: ${target.repo}\n  branch: ${target.branch}\n  enabled: ${target.enabled ? "yes" : "no"}\n  service: ${target.serviceName}.service (${active})`,
  );
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

function resolveWorkspaceTarget(opts: { path?: string; repo?: string; branch?: string }) {
  const existing = getTarget(WORKSPACE_TARGET_NAME);
  const path = expandPath(opts.path || existing?.path || defaultWorkspacePath());
  const repo = opts.repo || existing?.repo || gitRemote(path);
  if (!repo) {
    console.log(
      fail(
        "Workspace-Repo unbekannt. Verwende --repo <url> oder setze zuerst ein origin im Workspace.",
      ),
    );
    process.exit(1);
  }
  const branch = opts.branch || existing?.branch || gitBranch(path) || "main";
  const target = buildTarget(WORKSPACE_TARGET_NAME, path, repo, branch);
  if (existing) {
    target.createdAt = existing.createdAt;
  }
  return target;
}

function ensureWorkspaceRepo(target: LocalSyncTarget): string | null {
  if (!existsSync(target.path)) {
    mkdirSync(dirname(target.path), { recursive: true });
    const clone = runFull(
      `git clone --branch ${JSON.stringify(target.branch)} ${JSON.stringify(target.repo)} ${JSON.stringify(target.path)}`,
    );
    if (!clone.ok) {
      return (
        clone.stderr || clone.stdout || `Workspace konnte nicht geklont werden: ${target.path}`
      );
    }
  }

  const gitErr = ensureGitRepo(target);
  if (gitErr) {
    return gitErr;
  }
  return ensureRemoteConfigured(target);
}

function installWorkspace(opts: { path?: string; repo?: string; branch?: string }) {
  const target = resolveWorkspaceTarget(opts);
  const repoErr = ensureWorkspaceRepo(target);
  if (repoErr) {
    console.log(fail(repoErr));
    process.exit(1);
  }

  upsertTarget(target);
  const installNotes = installTarget(target);
  const migrationNotes = migrateLegacyWorkspaceServices();
  console.log(ok("Workspace Watcher installiert/repariert"));
  [...installNotes, ...migrationNotes].forEach((n) => console.log(info(n)));
  printTarget(target);
}

function migrateWorkspaceCommand() {
  const notes = migrateLegacyWorkspaceServices();
  if (!notes.length) {
    console.log(ok("Keine Legacy-Workspace-Services gefunden"));
    return;
  }
  notes.forEach((n) => console.log(info(n)));
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
    console.log(target.name);
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
    console.log(
      existsSync(target.path)
        ? ok(`Pfad vorhanden: ${target.path}`)
        : fail(`Pfad fehlt: ${target.path}`),
    );
    console.log(
      existsSync(join(target.path, ".git")) ? ok("Git-Repo erkannt") : fail("Kein Git-Repo"),
    );
    console.log(
      existsSync(watcherScriptPath(target.name))
        ? ok("Watcher-Script vorhanden")
        : fail("Watcher-Script fehlt"),
    );
    console.log(
      existsSync(pushScriptPath(target.name))
        ? ok("Push-Script vorhanden")
        : fail("Push-Script fehlt"),
    );
    console.log(
      existsSync(serviceFilePath(target.serviceName))
        ? ok("Service-File vorhanden")
        : fail("Service-File fehlt"),
    );
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
  if (result.stdout) {
    console.log(result.stdout);
  }
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
  const cmd = new Command("local-sync").description(
    "Generischer lokaler Repo-Sync per Watcher + Auto-Push",
  );

  cmd
    .command("add <name>")
    .description("Neues lokales Sync-Target registrieren und installieren")
    .requiredOption("--path <dir>", "Lokaler Ordner")
    .requiredOption("--repo <url>", "Git-Remote URL")
    .option("--branch <name>", "Branch", "main")
    .action((name, opts) => addTarget(name, opts));

  const workspace = cmd
    .command("workspace")
    .description("OpenClaw Workspace Watcher installieren, reparieren und migrieren");
  const addWorkspaceInstallOptions = (command: Command) =>
    command
      .option("--path <dir>", "Workspace-Repo (default: ~/.openclaw/workspace)")
      .option("--repo <url>", "Git-Remote URL; erforderlich, wenn kein origin ermittelbar ist")
      .option("--branch <name>", "Branch; default aus Repo oder main");

  addWorkspaceInstallOptions(
    workspace
      .command("install")
      .description("Workspace Watcher als kanonischen local-sync Service installieren"),
  ).action((opts) => installWorkspace(opts));

  addWorkspaceInstallOptions(
    workspace
      .command("repair")
      .description("Workspace Watcher neu generieren und Legacy-Services entfernen"),
  ).action((opts) => installWorkspace(opts));

  workspace
    .command("migrate-legacy")
    .description("Alte doppelte Workspace-Watcher-Services deaktivieren und entfernen")
    .action(migrateWorkspaceCommand);

  cmd.command("list").description("Registrierte Targets anzeigen").action(listTargets);

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
