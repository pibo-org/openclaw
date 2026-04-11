#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
REPO_DIR="${REPO_DIR:-$(cd "$APP_DIR/.." && pwd)}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
PM2_APP_NAME="${PM2_APP_NAME:-pibo-app}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:3000/}"
HEALTHCHECK_SECONDARY_URL="${HEALTHCHECK_SECONDARY_URL:-http://127.0.0.1:3000/about}"
SSH_KEY_PATH=/root/.ssh/id_ed25519_pibo_ci
HEALTHCHECK_TMP_FILE="${HEALTHCHECK_TMP_FILE:-/tmp/pibo-webapp-deploy-health.html}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-15}"
HEALTHCHECK_SLEEP_SECONDS="${HEALTHCHECK_SLEEP_SECONDS:-2}"

export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i ${SSH_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"

for cmd in corepack curl git pm2; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

[[ -d "$REPO_DIR" ]] || {
  echo "Missing repo directory: $REPO_DIR" >&2
  exit 1
}

[[ -d "$APP_DIR" ]] || {
  echo "Missing app directory: $APP_DIR" >&2
  exit 1
}

git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "Repo directory is not a git checkout: $REPO_DIR" >&2
  exit 1
}

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Fetching ${REMOTE}/${BRANCH}"
git -C "$REPO_DIR" fetch "$REMOTE" "$BRANCH"

current_commit="$(git -C "$REPO_DIR" rev-parse HEAD)"
target_commit="$(git -C "$REPO_DIR" rev-parse FETCH_HEAD)"

echo "Current commit: $current_commit"
echo "Target commit:  $target_commit"

if [[ "$current_commit" != "$target_commit" ]]; then
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" pull --ff-only "$REMOTE" "$BRANCH"
else
  echo "repo already up to date in git"
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Installing workspace dependencies"
corepack pnpm --dir "$REPO_DIR" install --filter ./ui-pibo --filter ./packages/pibo-shared-auth --frozen-lockfile

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Building app"
corepack pnpm --dir "$REPO_DIR" ui:pibo:build

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Recreating PM2 app ${PM2_APP_NAME}"
"$APP_DIR/deploy/ensure-fresh-pm2-start.sh" "$PM2_APP_NAME" "$APP_DIR/ecosystem.config.cjs"

check_url() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 "$HEALTHCHECK_ATTEMPTS"); do
    status_code="$(curl -sS --compressed -o "$HEALTHCHECK_TMP_FILE" -w '%{http_code}' "$url" || true)"
    if [[ "$status_code" == '200' ]]; then
      echo "Healthcheck passed: $url"
      return 0
    fi
    sleep "$HEALTHCHECK_SLEEP_SECONDS"
  done
  echo "Healthcheck failed: $url" >&2
  return 1
}

check_url "$HEALTHCHECK_URL"
check_url "$HEALTHCHECK_SECONDARY_URL"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Deploy successful"
echo "Deployed repo commit: $(git -C "$REPO_DIR" rev-parse HEAD)"
