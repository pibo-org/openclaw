#!/usr/bin/env node
/**
 * pibo-docs-server-watcher.js - Watches /var/lib/pibo-webapp/storage/docs/ for
 * WebApp changes and auto-commits them to the server git working tree.
 *
 * Uses per-directory fs.watch registrations instead of one recursive watcher so
 * .git and other noisy directories are never watched. This keeps the watcher
 * below inotify limits and avoids recursive .git watch churn.
 *
 * Design:
 * - Debounces changes (2s idle) to batch rapid WebApp writes
 * - Skips if a file was modified within 500ms, to avoid catching mid-writes
 * - Commits all pending changes at once
 * - Pushes to the bare repo immediately; conflicts still defer to sync cron
 */

import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

const DOCS_DIR = '/var/lib/pibo-webapp/storage/docs';
const DEBOUNCE_MS = 2000;
const SETTLE_MS = 500;

let debounceTimer = null;
let changeCount = 0;
let syncing = false;
let pending = false;
let changedFiles = new Set();
const watchedDirs = new Map();

function normalizePath(filepath) {
  return String(filepath).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function isIgnoredPath(filepath) {
  const normalized = normalizePath(filepath);
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part) => part === '.git' || part === 'node_modules' || part.startsWith('.pibo-'));
}

function shouldProcessFile(filename) {
  const normalized = normalizePath(filename);
  if (!normalized.endsWith('.md')) return false;
  if (isIgnoredPath(normalized)) return false;
  return true;
}

function isDirectory(fullPath) {
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

async function doCommit() {
  syncing = true;
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: DOCS_DIR });

    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: DOCS_DIR });
      await execFileAsync('git', ['diff', '--quiet'], { cwd: DOCS_DIR });
      return;
    } catch {
      // There are changes.
    }

    const files = [...changedFiles].sort();
    const msg = files.length <= 5
      ? `auto: webapp write ${files.map((f) => path.basename(f)).join(', ')}`
      : `auto: webapp write (${files.length} files)`;

    changedFiles.clear();

    await execFileAsync('git', ['commit', '-m', msg], { cwd: DOCS_DIR });
    console.log(`[${new Date().toISOString()}] ✓ committed: ${msg}`);

    try {
      await execFileAsync('git', ['fetch', 'origin', 'master'], { cwd: DOCS_DIR });
      try {
        await execFileAsync('git', ['rebase', 'FETCH_HEAD'], { cwd: DOCS_DIR });
      } catch {
        await execFileAsync('git', ['rebase', '--abort'], { cwd: DOCS_DIR }).catch(() => {});
        console.log(`[${new Date().toISOString()}] ⚠ rebase failed, defer to sync cron`);
      }
      console.log(`[${new Date().toISOString()}] ✓ synced with bare repo`);
    } catch {
      // No PIBo changes or already up to date.
    }

    try {
      await execFileAsync('git', ['push', 'origin', 'master'], { cwd: DOCS_DIR });
      console.log(`[${new Date().toISOString()}] ✓ pushed to bare repo`);
    } catch {
      console.log(`[${new Date().toISOString()}] ⚠ push deferred (cron will handle)`);
    }
  } catch (err) {
    if (!err.message?.includes('nothing to commit')) {
      console.error(`[${new Date().toISOString()}] ✗ commit error: ${err.stderr || err.message}`);
    }
  } finally {
    syncing = false;
    if (pending) {
      pending = false;
      scheduleCommit();
    }
  }
}

function scheduleCommit() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void doCommit();
  }, DEBOUNCE_MS);
}

function debounceChange(changedFile) {
  if (syncing) {
    pending = true;
    changedFiles.add(changedFile);
    return;
  }

  changeCount++;
  changedFiles.add(changedFile);
  scheduleCommit();
}

async function watchTree(dir) {
  const relDir = normalizePath(path.relative(DOCS_DIR, dir));
  if (relDir && isIgnoredPath(relDir)) return;
  if (watchedDirs.has(dir)) return;

  let watcher;
  try {
    watcher = watch(dir, { recursive: false }, (eventType, filename) => {
      if (!filename) return;
      const fullPath = path.join(dir, String(filename));
      const relPath = normalizePath(path.relative(DOCS_DIR, fullPath));
      if (!relPath || isIgnoredPath(relPath)) return;

      if (eventType === 'rename' && isDirectory(fullPath)) {
        void watchTree(fullPath);
      }

      if (!shouldProcessFile(relPath)) return;

      try {
        const stat = fs.statSync(fullPath);
        const age = Date.now() - stat.mtimeMs;
        if (age < SETTLE_MS) {
          setTimeout(() => debounceChange(relPath), SETTLE_MS - age);
          return;
        }
      } catch {
        // File might have been deleted; still commit the deletion.
      }

      debounceChange(relPath);
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Watcher error for ${dir}: ${err.message}`);
    return;
  }

  watcher.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Watcher error for ${dir}: ${err.message}`);
  });
  watchedDirs.set(dir, watcher);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const childRel = normalizePath(path.relative(DOCS_DIR, child));
      if (isIgnoredPath(childRel)) continue;
      void watchTree(child);
    }
  } catch (err) {
    console.error(`Scan error for ${dir}: ${err.message}`);
  }
}

function closeWatchers() {
  for (const watcher of watchedDirs.values()) {
    watcher.close();
  }
  watchedDirs.clear();
}

console.log(`[${new Date().toISOString()}] Starting server docs watcher: ${DOCS_DIR}`);
void watchTree(DOCS_DIR).then(() => {
  console.log(`[${new Date().toISOString()}] Watching for changes (${watchedDirs.size} directories)...`);
});

process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Stopping server watcher...`);
  closeWatchers();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${new Date().toISOString()}] Terminating server watcher...`);
  closeWatchers();
  if (changeCount > 0 || changedFiles.size > 0) {
    execFileAsync('git', ['add', '-A'], { cwd: DOCS_DIR })
      .then(() => execFileAsync('git', ['commit', '-m', 'auto: final commit before watcher stop'], { cwd: DOCS_DIR }))
      .catch(() => {})
      .finally(() => process.exit(0));
  } else {
    process.exit(0);
  }
});
