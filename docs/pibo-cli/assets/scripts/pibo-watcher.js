#!/usr/bin/env node
/**
 * pibo-docs-watcher.js - Watches ~/docs for markdown changes and auto-pushes.
 *
 * Uses per-directory fs.watch registrations instead of one recursive watcher so
 * .git and other noisy directories are never watched. This keeps the watcher
 * below inotify limits and avoids the old ENOSPC failure mode.
 */

import { existsSync, statSync, watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const DOCS_DIR = process.env.HOME + '/docs';
const PUSH_SCRIPT = process.env.HOME + '/docs-sync/pibo-push.sh';
const DEBOUNCE_MS = 2000;

let debounceTimer = null;
let changeCount = 0;
const seenEvents = new Set();
const watchedDirs = new Map();

function normalizePath(filepath) {
  return String(filepath).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function isIgnoredPath(filepath) {
  const normalized = normalizePath(filepath);
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part) => part === '.git' || part === 'node_modules' || part === '.pibo-docs-watcher');
}

function shouldProcessFile(filepath) {
  const normalized = normalizePath(filepath);
  if (!normalized.endsWith('.md')) return false;
  if (isIgnoredPath(normalized)) return false;
  return true;
}

function isDirectory(fullPath) {
  try {
    return statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function debouncePush(changedFile) {
  const dedupKey = `${changedFile}-${Date.now() - (Date.now() % 500)}`;
  if (seenEvents.has(dedupKey)) return;
  seenEvents.clear();
  seenEvents.add(dedupKey);

  changeCount++;
  if (debounceTimer) clearTimeout(debounceTimer);

  console.log(`[${new Date().toISOString()}] Change: ${changedFile} (batch: ${changeCount})`);
  void watchTree(DOCS_DIR);

  debounceTimer = setTimeout(async () => {
    console.log(`[${new Date().toISOString()}] Debounce done - pushing ${changeCount} change(s)`);
    changeCount = 0;
    try {
      const { stdout } = await execFileAsync('bash', [PUSH_SCRIPT], {
        timeout: 30_000,
      });
      if (stdout.trim()) {
        console.log(`[${new Date().toISOString()}] ${stdout.trim()}`);
      }
    } catch (err) {
      if (err.stdout) console.log(`  ${err.stdout.trim()}`);
      if (err.stderr) console.error(`  Error: ${err.stderr?.trim()}`);
    }
  }, DEBOUNCE_MS);
}

async function watchTree(dir) {
  const relDir = normalizePath(path.relative(DOCS_DIR, dir));
  if (relDir && isIgnoredPath(relDir)) return;

  if (!watchedDirs.has(dir)) {
    let watcher;
    try {
      watcher = watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dir, String(filename));
        const relPath = normalizePath(path.relative(DOCS_DIR, fullPath));
        if (!relPath || isIgnoredPath(relPath)) return;

        if (eventType === 'rename' && isDirectory(fullPath)) {
          const existingWatcher = watchedDirs.get(fullPath);
          if (existingWatcher) {
            existingWatcher.close();
            watchedDirs.delete(fullPath);
          }
          void watchTree(fullPath);
          debouncePush(`${eventType} ${relPath}/`);
          return;
        }

        if (shouldProcessFile(relPath)) {
          debouncePush(`${eventType} ${relPath}`);
        } else if (eventType === 'rename') {
          debouncePush(`${eventType} ${relPath}`);
        }
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Watcher error for ${dir}: ${err.message}`);
      return;
    }

    watcher.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] Watcher error for ${dir}: ${err.message}`);
    });
    watchedDirs.set(dir, watcher);
  }

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

console.log(`[${new Date().toISOString()}] Starting docs watcher: ${DOCS_DIR}`);
void watchTree(DOCS_DIR).then(() => {
  console.log(`[${new Date().toISOString()}] Watching for changes (${watchedDirs.size} directories)...`);
});

process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Stopping watcher...`);
  closeWatchers();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${new Date().toISOString()}] Terminating...`);
  closeWatchers();
  process.exit(0);
});
