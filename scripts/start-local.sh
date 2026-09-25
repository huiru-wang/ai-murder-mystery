#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
ENV_FILE="$PROJECT_ROOT/apps/murder-mystery-api/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
cleanup() {
  kill "$API_PID" 2>/dev/null || true
  kill "$WEB_PID" 2>/dev/null || true
}

(
  cd "$PROJECT_ROOT/apps/murder-mystery-api"
  exec ./node_modules/.bin/tsx watch src/index.ts
) &
API_PID=$!

(
  cd "$PROJECT_ROOT/apps/murder-mystery-web"
  exec ./node_modules/.bin/vite
) &
WEB_PID=$!

trap cleanup EXIT INT TERM
wait "$WEB_PID"
