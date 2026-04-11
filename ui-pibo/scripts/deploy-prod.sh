#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/var/www/pibo.schottech.de-app}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
PM2_APP_NAME="${PM2_APP_NAME:-pibo-app}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:3000/}"
HEALTHCHECK_SECONDARY_URL="${HEALTHCHECK_SECONDARY_URL:-http://127.0.0.1:3000/about}"
SSH_KEY_PATH="${SSH_KEY_PATH:-/root/.ssh/id_ed25519}"
HEALTHCHECK_TMP_FILE="${HEALTHCHECK_TMP_FILE:-/tmp/pibo-webapp-deploy-health.html}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-15}"
HEALTHCHECK_SLEEP_SECONDS="${HEALTHCHECK_SLEEP_SECONDS:-2}"

export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i ${SSH_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"

for cmd in curl git npm pm2; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

[[ -d "$APP_DIR" ]] || {
  echo "Missing app directory: $APP_DIR" >&2
  exit 1
}

git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "App directory is not a git checkout: $APP_DIR" >&2
  exit 1
}

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Fetching ${REMOTE}/${BRANCH}"
git -C "$APP_DIR" fetch "$REMOTE" "$BRANCH"

current_commit="$(git -C "$APP_DIR" rev-parse HEAD)"
target_commit="$(git -C "$APP_DIR" rev-parse FETCH_HEAD)"

echo "Current commit: $current_commit"
echo "Target commit:  $target_commit"

git -C "$APP_DIR" checkout "$BRANCH"
git -C "$APP_DIR" pull --ff-only "$REMOTE" "$BRANCH"

# Copy ecosystem.config.cjs (gitignored, so needs explicit copy from parent dir)
ECOSYSTEM_SRC="$(dirname "$APP_DIR")/ecosystem.config.cjs"
if [[ -f "$ECOSYSTEM_SRC" ]]; then
  cp "$ECOSYSTEM_SRC" "$APP_DIR/ecosystem.config.cjs"
fi

if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Stopping PM2 app ${PM2_APP_NAME}"
  pm2 stop "$PM2_APP_NAME"
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Installing dependencies"
npm --prefix "$APP_DIR" ci

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Restarting PM2 app ${PM2_APP_NAME}"
pm2 restart "$PM2_APP_NAME" --update-env

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
echo "Deployed commit: $(git -C "$APP_DIR" rev-parse HEAD)"
