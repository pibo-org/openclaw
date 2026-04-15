#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

resolve_canonical_repo_root() {
  local common_git_dir

  if common_git_dir=$(git -C "$ROOT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    if [[ "$(basename "$common_git_dir")" == ".git" ]]; then
      dirname "$common_git_dir"
      return 0
    fi
  fi

  return 1
}

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

search_roots=("$ROOT_DIR")
if canonical_root="$(resolve_canonical_repo_root)"; then
  if [[ "$canonical_root" != "$ROOT_DIR" ]]; then
    search_roots+=("$canonical_root")
  fi
fi

for search_root in "${search_roots[@]}"; do
  tool_path="$search_root/node_modules/.bin/$tool"
  if [[ -x "$tool_path" ]]; then
    exec "$tool_path" "$@"
  fi
done

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  echo "Could not find installed tool '$tool'." >&2
  for search_root in "${search_roots[@]}"; do
    echo "Searched: $search_root/node_modules/.bin/$tool" >&2
  done
  echo "Install dependencies in this checkout or the canonical main checkout for this repo." >&2
  exit 1
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
  exec bunx --bun "$tool" "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
