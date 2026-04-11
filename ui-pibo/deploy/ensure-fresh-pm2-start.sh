#!/usr/bin/env bash
set -Eeuo pipefail
APP_NAME="${1:-pibo-app}"
ECOSYSTEM_FILE="${2:-ecosystem.config.cjs}"

pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start "$ECOSYSTEM_FILE" --only "$APP_NAME" --update-env
