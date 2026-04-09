#!/usr/bin/env bash
# pibo-docs-push.sh — Auto-commit and push local doc changes to bare repo.
# Triggered by chokidar file watcher. Debounces to batch multiple changes.

set -euo pipefail
cd ~/docs

git add -A

# Commit if there are changes
if ! git diff --cached --quiet 2>/dev/null || ! git diff --quiet 2>/dev/null; then
  git commit -m "auto: pibo write $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

trigger_server_sync() {
  local origin_url userhost
  origin_url=$(git remote get-url origin 2>/dev/null || echo "")
  userhost=$(printf '%s' "$origin_url" | sed -n 's#^\([^:]*\):.*#\1#p')
  [ -n "$userhost" ] || return 0
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$userhost" 'nohup bash /root/bin/pibo-docs-sync.sh >/dev/null 2>&1 </dev/null &' >/dev/null 2>&1 || true
}

do_push() {
  if git push origin master 2>/dev/null; then
    trigger_server_sync
    return 0
  fi

  # Push rejected — fetch
  git fetch origin master 2>/dev/null || { echo "Fetch failed — will retry later" >&2; return 1; }

  REMOTE=$(git rev-parse FETCH_HEAD)
  LOCAL=$(git rev-parse HEAD)

  if [ "$REMOTE" = "$LOCAL" ]; then
    return 0
  fi

  # Try rebase
  local rebase_ok=0
  git rebase FETCH_HEAD 2>/dev/null || rebase_ok=1

  if [ "$rebase_ok" -eq 0 ]; then
    git push origin master 2>/dev/null || { echo "Push after rebase failed" >&2; return 1; }
    trigger_server_sync
    return 0
  fi

  # Rebase failed = conflict. Save PIBo files BEFORE aborting.
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Rebase conflict — preserving PIBo files, accepting remote" >&2
  git rebase --abort 2>/dev/null || true

  # Identify new files PIBo created (not in remote)
  LOCAL_FILES=$(git ls-tree -r --name-only HEAD | grep '\.md$' || true)
  REMOTE_FILES=$(git ls-tree -r --name-only FETCH_HEAD | grep '\.md$' || true)

  # Save new files and modified files before reset
  SAVE_DIR=$(mktemp -d)
  for f in $LOCAL_FILES; do
    if ! echo "$REMOTE_FILES" | grep -qxF "$f"; then
      # New file PIBo created
      mkdir -p "$SAVE_DIR/new/$(dirname "$f")"
      git show HEAD:"$f" > "$SAVE_DIR/new/$f"
    else
      # Existing file — check if modified
      local_hash=$(git rev-parse HEAD:"$f" 2>/dev/null || echo "")
      remote_hash=$(git rev-parse FETCH_HEAD:"$f" 2>/dev/null || echo "")
      if [ "$local_hash" != "$remote_hash" ]; then
        mkdir -p "$SAVE_DIR/modified/$(dirname "$f")"
        git show HEAD:"$f" > "$SAVE_DIR/modified/$f"
      fi
    fi
  done

  # Accept remote
  git reset --hard FETCH_HEAD 2>/dev/null || true

  # Re-apply new files
  if [ -d "$SAVE_DIR/new" ]; then
    find "$SAVE_DIR/new" -name "*.md" -type f | while read -r saved; do
      rel="${saved#$SAVE_DIR/new/}"
      mkdir -p "$(dirname "$rel")"
      cp "$saved" "$rel"
      git add "$rel"
    done

    if ! git diff --cached --quiet 2>/dev/null; then
      git commit -m "auto: pibo write (new files preserved) $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      if git push origin master 2>/dev/null; then
        trigger_server_sync
      else
        echo "Push of preserved files failed" >&2
      fi
    fi
  fi

  rm -rf "$SAVE_DIR"
  return 0
}

do_push
