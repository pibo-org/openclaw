#!/usr/bin/env bash
# pibo-docs-sync.sh — Server side: three-way merge sync.
#
# Pushes to two remotes:
#   origin    → bare repo (PIBo, immediate live sync via post-receive hook)
#   github-backup → GitHub Repo (append-only backup, fire-and-forget)

set -euo pipefail

REPO_DIR="/var/lib/pibo-webapp/storage/docs"
GITHUB_KEY="/root/.ssh/id_ed25519_pibo_ci"

cd "$REPO_DIR"
git config user.email "pibo-docs-sync@local" 2>/dev/null
git config user.name "pibo-docs-sync" 2>/dev/null

SERVER_BK="/tmp/sync-server-$$"
PIBO_DIR="/tmp/sync-pibo-$$"
BASE_DIR="/tmp/sync-base-$$"
mkdir -p "$SERVER_BK" "$PIBO_DIR"

# 1. Backup server .md files
find . -name "*.md" -not -path "./.git/*" | while read -r f; do
  rel="${f#./}"
  mkdir -p "$SERVER_BK/$(dirname "$rel")"
  cp "$f" "$SERVER_BK/$rel" 2>/dev/null || true
done

# 2. Fetch + extract PIBo's .md files
git fetch origin master 2>/dev/null || true
PIBO_HEAD=$(git rev-parse FETCH_HEAD 2>/dev/null || echo "")
if [ -n "$PIBO_HEAD" ]; then
  git ls-tree -r --name-only "$PIBO_HEAD" 2>/dev/null | grep '\.md$' | while read -r f; do
    mkdir -p "$PIBO_DIR/$(dirname "$f")"
    git show "$PIBO_HEAD:$f" > "$PIBO_DIR/$f" 2>/dev/null || true
  done
fi

# 3. Get BASE (merge-base) for three-way comparison
BASE=""
if [ -n "$PIBO_HEAD" ]; then
  BASE=$(git merge-base HEAD "$PIBO_HEAD" 2>/dev/null || echo "")
fi
if [ -n "$BASE" ]; then
  mkdir -p "$BASE_DIR"
  git ls-tree -r --name-only "$BASE" 2>/dev/null | while read -r f; do
    [ "$f" != "${f%.md}" ] || continue
    mkdir -p "$BASE_DIR/$(dirname "$f")"
    git show "$BASE:$f" > "$BASE_DIR/$f" 2>/dev/null || true
  done
fi

# 4. Build complete file list from all 3 sources
for dir in "$SERVER_BK" "$PIBO_DIR" "$BASE_DIR"; do
  if [ -d "$dir" ]; then
    (cd "$dir" && find . -name "*.md" 2>/dev/null || true)
  fi
done | sed 's|^\./||' | sort -u > /tmp/sync-files-$$

ALL_FILES="/tmp/sync-files-$$"

# Process each file with true three-way logic
while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  S="$SERVER_BK/$rel"
  P="$PIBO_DIR/$rel"
  B="$BASE_DIR/$rel"
  
  S_EXISTS=false; [ -f "$S" ] && S_EXISTS=true
  P_EXISTS=false; [ -f "$P" ] && P_EXISTS=true
  B_EXISTS=false; [ -f "$B" ] && B_EXISTS=true
  
  DEST=""
  DELETE=false
  
  if [ "$S_EXISTS" = true ] && [ "$P_EXISTS" = true ]; then
    S_DIFFERS=false; P_DIFFERS=false
    if [ "$B_EXISTS" = true ]; then
      cmp -s "$S" "$B" || S_DIFFERS=true
      cmp -s "$P" "$B" || P_DIFFERS=true
    else
      # No base = both added; if same content, use server (either works)
      # if different, server wins
      DEST="$S"
    fi
    
    if [ "$S_DIFFERS" = true ] || [ "$P_DIFFERS" = true ]; then
      if [ "$S_DIFFERS" = true ]; then
        DEST="$S"
      else
        DEST="$P"
      fi
    else
      DEST="$S"
    fi
  elif [ "$S_EXISTS" = true ] && [ "$P_EXISTS" = false ] && [ "$B_EXISTS" = true ]; then
    # A tracked file deleted on PIBo is a tombstone. Do not resurrect it from
    # the server copy, even if the server copy drifted from base.
    DELETE=true
  elif [ "$S_EXISTS" = false ] && [ "$P_EXISTS" = true ] && [ "$B_EXISTS" = true ]; then
    # Same rule in the opposite direction: WebApp/server deletion wins over
    # the PIBo copy to avoid deleted pages reappearing as stale copies.
    DELETE=true
  elif [ "$S_EXISTS" = true ] && [ "$B_EXISTS" = false ] && [ "$P_EXISTS" = false ]; then
    DEST="$S"
  elif [ "$S_EXISTS" = false ] && [ "$P_EXISTS" = true ] && [ "$B_EXISTS" = false ]; then
    DEST="$P"
  fi
  
  if [ -n "$DEST" ]; then
    mkdir -p "$REPO_DIR/$(dirname "$rel")"
    cp "$DEST" "$REPO_DIR/$rel"
  elif [ "$DELETE" = true ]; then
    rm -f "$REPO_DIR/$rel" 2>/dev/null || true
  fi
done < "$ALL_FILES"

# 5. Clean up orphaned tracked files
git ls-tree -r --name-only "$PIBO_HEAD" 2>/dev/null | while read -r rel; do
  [ "$rel" != "${rel%.md}" ] || continue
  if [ ! -f "$REPO_DIR/$rel" ]; then
    B_FILE="$BASE_DIR/$rel"
    S_FILE="$SERVER_BK/$rel"
    if [ -f "$B_FILE" ] && [ ! -f "$S_FILE" ]; then
      rm -f "$REPO_DIR/$rel" 2>/dev/null || true
    fi
  fi
done

# 6. Commit + push
git add -A
if git diff --cached --quiet 2>/dev/null && git diff --quiet 2>/dev/null; then
  rm -rf "$SERVER_BK" "$PIBO_DIR" "$BASE_DIR"
  rm -f "$ALL_FILES"
  exit 0
fi

if git commit -m "auto: webapp save $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null; then
  # Push to PIBo bare repo (with retry)
  for attempt in 1 2 3; do
    if git push origin master 2>/dev/null; then
      break
    fi
    git fetch origin master 2>/dev/null || break
    NH=$(git rev-parse FETCH_HEAD 2>/dev/null || echo "")
    CH=$(git rev-parse HEAD 2>/dev/null || echo "")
    [ "$NH" = "$CH" ] && break
    if git rebase FETCH_HEAD 2>/dev/null; then
      continue
    else
      git rebase --abort 2>/dev/null || true
      if git push --force-with-lease origin master 2>/dev/null; then
        echo "$(date) force push succeeded (origin)" >> /var/log/pibo-docs-sync.log
        break
      else
        git reset --hard FETCH_HEAD 2>/dev/null || true
        echo "$(date) force push failed, accepted remote (origin)" >> /var/log/pibo-docs-sync.log
        break
      fi
    fi
  done

  # Push to GitHub backup (fire-and-forget, never block on failure)
  export GIT_SSH_COMMAND="ssh -i $GITHUB_KEY -o IdentitiesOnly=yes"
  if git push github-backup HEAD:refs/heads/main 2>>/var/log/pibo-docs-sync.log; then
    echo "$(date) pushed to GitHub backup" >> /var/log/pibo-docs-sync.log
  else
    echo "$(date) GitHub push failed (backup unreachable)" >> /var/log/pibo-docs-sync.log
  fi
fi

git reset --hard HEAD 2>/dev/null || true
rm -rf "$SERVER_BK" "$PIBO_DIR" "$BASE_DIR"
rm -f "$ALL_FILES"
