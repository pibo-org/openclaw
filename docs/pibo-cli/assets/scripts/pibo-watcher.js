#!/usr/bin/env node
/**
 * pibo-docs-watcher.js — Watches ~/docs for changes and auto-commits + pushes.
 *
 * Uses Node.js native fs.watch — zero dependencies.
 * Debounces changes to batch multiple writes into a single commit.
 */

import { watch } from 'node:fs';
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

function debouncePush(changedFile) {
  const dedupKey = `${changedFile}-${Date.now() - (Date.now() % 500)}`;
  if (seenEvents.has(dedupKey)) return;
  seenEvents.clear();
  seenEvents.add(dedupKey);

  changeCount++;
  if (debounceTimer) clearTimeout(debounceTimer);

  console.log(`[${new Date().toISOString()}] Change: ${changedFile} (batch: ${changeCount})`);

  debounceTimer = setTimeout(async () => {
    console.log(`[${new Date().toISOString()}] Debounce done — pushing ${changeCount} change(s)`);
    changeCount = 0;
    try {
      const { stdout } = await execFileAsync('bash', [PUSH_SCRIPT], {
        timeout: 15_000,
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

function shouldProcessFile(filepath) {
  if (!filepath.endsWith('.md')) return false;
  if (filepath.startsWith('.git')) return false;
  if (filepath.startsWith('.pibo-docs-watcher')) return false;
  if (filepath.includes('/node_modules/')) return false;
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

console.log(`[${new Date().toISOString()}] Starting docs watcher: ${DOCS_DIR}`);

const watcher = watch(DOCS_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  if (!shouldProcessFile(filename)) return;
  debouncePush(`${eventType} ${filename}`);
});

watcher.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] Watcher error: ${err.message}`);
});

recursiveWatch(DOCS_DIR);
console.log(`[${new Date().toISOString()}] Watching for changes...`);

process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Stopping watcher...`);
  watcher.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${new Date().toISOString()}] Terminating...`);
  watcher.close();
  process.exit(0);
});
