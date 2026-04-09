#!/usr/bin/env bash
# pibo-docs-pull.sh — Pull changes from server bare repo.
# Runs every 30s. Fetches + merges server changes into PIBo's working tree.

set -euo pipefail
REPO_DIR="/home/pibo/docs"
cd "$REPO_DIR"

git fetch origin master 2>/dev/null || exit 0

LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "")
REMOTE=$(git rev-parse FETCH_HEAD 2>/dev/null || echo "")

if [ -z "$LOCAL" ] || [ -z "$REMOTE" ] || [ "$LOCAL" = "$REMOTE" ]; then
  exit 0  # Nothing new
fi

# Try clean fast-forward first
if git merge --ff-only FETCH_HEAD 2>/dev/null; then
  exit 0
fi

# Diverged: reset to server version (it went through copy-pull-copy, so PIBo's own changes are already there,
# plus WebApp changes. Our only risk is losing uncommitted local edits — but the watcher commits everything.)
git reset --hard FETCH_HEAD 2>/dev/null || true
