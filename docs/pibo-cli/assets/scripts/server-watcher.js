#!/usr/bin/env node
/**
 * pibo-docs-server-watcher.js — Watches /var/lib/pibo-webapp/storage/docs/ for
 * WebApp changes and auto-commits to the local git working tree.
 *
 * Design:
 * - Debounces changes (2s idle) to batch rapid WebApp writes
 * - Skips if a file was modified within 500ms, to avoid catching mid-writes
 * - Commits all pending changes at once
 * - Does NOT push to bare repo — that's handled by the existing sync cron
 *   (pibo-docs-sync.sh runs every minute, does pull + three-way merge + push)
 *
 * Usage: node ~/code/pibo-docs-server-watcher.js
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
const SETTLE_MS = 500;    // minimum idle time before considering a file stable

let debounceTimer = null;
let changeCount = 0;
let syncing = false;
let pending = false;

// Track which files changed (for logging)
let changedFiles = new Set();

async function gitCommit() {
  if (syncing) return false;

  // Don't commit if nothing staged or changed
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--quiet'], {
      cwd: DOCS_DIR,
    });
    // quiet returns empty on no diff, exit code 0
  } catch (err) {
    // exit code 1 = there ARE changes, fall through
    if (err.exitCode !== 1) return false;
  }

  // Actually, let's just check directly
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: DOCS_DIR });
    // No staged changes
    try {
      await execFileAsync('git', ['diff', '--quiet'], { cwd: DOCS_DIR });
      // No unstaged changes either — nothing to commit
      return false;
    } catch {
      // There are unstaged changes — stage and commit
    }
  } catch {
    // There are staged changes — fall through to commit
  }

  return true;
}

async function doCommit() {
  syncing = true;
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: DOCS_DIR });

    // Check if there are actually changes
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: DOCS_DIR });
      await execFileAsync('git', ['diff', '--quiet'], { cwd: DOCS_DIR });
      // Nothing changed
      return;
    } catch {
      // There are changes
    }

    const files = [...changedFiles].sort();
    const msg = files.length <= 5
      ? `auto: webapp write ${files.map(f => path.basename(f)).join(', ')}`
      : `auto: webapp write (${files.length} files)`;

    changedFiles.clear();

    await execFileAsync('git', ['commit', '-m', msg], { cwd: DOCS_DIR });
    console.log(`[${new Date().toISOString()}] ✓ committed: ${msg}`);

    // Fetch from bare repo to get PIBo changes before pushing
    try {
      await execFileAsync('git', ['fetch', 'origin', 'master'], { cwd: DOCS_DIR });
      try {
        await execFileAsync('git', ['rebase', 'FETCH_HEAD'], { cwd: DOCS_DIR });
      } catch {
        await execFileAsync('git', ['rebase', '--abort'], { cwd: DOCS_DIR }).catch(() => {});
        console.log(`[${new Date().toISOString()}] ⚠ rebase failed, defer to sync cron`);
      }
      console.log(`[${new Date().toISOString()}] ✓ synced with bare repo`);
    } catch (err) {
      // No PIBo changes or already up to date
    }

    // Push to bare repo immediately — this triggers post-receive hook
    // which notifies PIBo via SSH tunnel for immediate pull
    try {
      await execFileAsync('git', ['push', 'origin', 'master'], { cwd: DOCS_DIR });
      console.log(`[${new Date().toISOString()}] ✓ pushed to bare repo`);
    } catch (err) {
      // Push still fails (conflict) — defer to sync cron
      console.log(`[${new Date().toISOString()}] ⚠ push deferred (cron will handle)`);
    }
  } catch (err) {
    // Commit failed — might mean no changes or git conflict
    if (!err.message?.includes('nothing to commit')) {
      console.error(`[${new Date().toISOString()}] ✗ commit error: ${err.stderr || err.message}`);
    }
  } finally {
    syncing = false;

    // If more changes came in during the sync, commit again
    if (pending) {
      pending = false;
      scheduleCommit();
    }
  }
}

function scheduleCommit() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    doCommit();
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

  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    doCommit();
    changeCount = 0;
  }, DEBOUNCE_MS);
}

function shouldProcessFile(filename) {
  if (!filename.endsWith('.md')) return false;
  if (filename.startsWith('.git') || filename.includes('/.git/')) return false;
  if (filename.startsWith('.pibo-') || filename.includes('/.pibo-')) return false;
  if (filename.includes('/node_modules/')) return false;
  return true;
}

async function recursiveWatch(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        recursiveWatch(fullPath);
      }
    }
  } catch (err) {
    console.error(`Scan error for ${dir}: ${err.message}`);
  }
}

console.log(`[${new Date().toISOString()}] Starting server docs watcher: ${DOCS_DIR}`);

const watcher = watch(DOCS_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  if (!shouldProcessFile(filename)) return;

  // Check file is fully written (not mid-write)
  const fullPath = path.join(DOCS_DIR, filename);
  try {
    const stat = fs.statSync(fullPath);
    const age = Date.now() - stat.mtimeMs;
    if (age < SETTLE_MS) {
      // File was modified recently — wait for it to settle
      setTimeout(() => debounceChange(filename), SETTLE_MS - age);
      return;
    }
  } catch {
    // File might have been deleted — still want to detect this
  }

  debounceChange(filename);
});

// Initial scan
recursiveWatch(DOCS_DIR);
console.log(`[${new Date().toISOString()}] Watching for changes...`);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Stopping server watcher...`);
  watcher.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${new Date().toISOString()}] Terminating server watcher...`);
  watcher.close();
  // One final commit if there are pending changes
  if (changeCount > 0 || changedFiles.size > 0) {
    execFileAsync('git', ['add', '-A'], { cwd: DOCS_DIR })
      .then(() => execFileAsync('git', ['commit', '-m', 'auto: final commit before watcher stop'], { cwd: DOCS_DIR }))
      .catch(() => { /* OK if nothing to commit */ })
      .finally(() => process.exit(0));
  } else {
    process.exit(0);
  }
});
