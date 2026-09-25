#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_DIR="$PROJECT_ROOT/apps/murder-mystery-api"
WEB_DIST="$PROJECT_ROOT/apps/murder-mystery-web/dist"
ENV_FILE="${AI_MURDER_MYSTERY_ENV_FILE:-$API_DIR/.env.production}"
DATA_DIR="${AI_MURDER_MYSTERY_DATA_DIR:-/var/lib/ai-murder-mystery}"
WEB_DIR="${AI_MURDER_MYSTERY_WEB_DIR:-/var/www/ai-murder-mystery}"
RUN_DIR="$DATA_DIR/run"
LOG_DIR="$DATA_DIR/logs"
PID_FILE="$RUN_DIR/api.pid"
NGINX_SOURCE="$PROJECT_ROOT/deploy/manual/nginx/nginx.conf"
NGINX_TARGET="${AI_MURDER_MYSTERY_NGINX_CONFIG:-/etc/nginx/nginx.conf}"
LOCK_FILE="${AI_MURDER_MYSTERY_DEPLOY_LOCK:-/tmp/ai-murder-mystery-deploy.lock}"
API_PORT="${AI_MURDER_MYSTERY_API_PORT:-3200}"

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo 'root or sudo is required to publish Web files and install Nginx configuration' >&2
  exit 1
fi

run_root() {
  "${SUDO[@]}" "$@"
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

for command in node pnpm nginx curl flock; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

[[ -f "$ENV_FILE" ]] || fail "missing production environment file: $ENV_FILE"
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another deployment is already running'

stop_api() {
  [[ -f "$PID_FILE" ]] || return 0
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

publish_web() {
  [[ -f "$WEB_DIST/index.html" ]] || fail "missing Web build: $WEB_DIST/index.html"
  local release backup parent
  parent="$(dirname "$WEB_DIR")"
  release="$parent/.ai-murder-mystery-release-$$"
  backup="$parent/.ai-murder-mystery-backup-$$"
  run_root mkdir -p "$parent"
  run_root rm -rf "$release" "$backup"
  run_root mkdir -p "$release"
  run_root cp -a "$WEB_DIST/." "$release/"
  if run_root test -e "$WEB_DIR"; then
    run_root mv "$WEB_DIR" "$backup"
  fi
  if ! run_root mv "$release" "$WEB_DIR"; then
    run_root test -e "$backup" && run_root mv "$backup" "$WEB_DIR"
    fail 'unable to publish Web release'
  fi
  run_root rm -rf "$backup"
}

start_api() {
  run_root mkdir -p "$DATA_DIR" "$RUN_DIR" "$LOG_DIR"
  run_root chown -R "$(id -un):$(id -gn)" "$DATA_DIR"
  stop_api
  (
    cd "$API_DIR"
    AI_MURDER_MYSTERY_API_PORT="$API_PORT" \
    AI_MURDER_MYSTERY_SQLITE_PATH="$DATA_DIR/game.sqlite" \
    AI_MURDER_MYSTERY_AGENT_DB="$DATA_DIR/agent.sqlite" \
    nohup node --env-file="$ENV_FILE" dist/index.js >> "$LOG_DIR/api.log" 2>&1 &
    echo $! > "$PID_FILE"
  )
  for _ in {1..20}; do
    curl -fsS --max-time 2 "http://127.0.0.1:$API_PORT/health" >/dev/null && return
    sleep 0.5
  done
  fail "API did not become healthy; inspect $LOG_DIR/api.log"
}

install_nginx() {
  local backup
  backup="$(mktemp)"
  if run_root test -f "$NGINX_TARGET"; then
    run_root cp "$NGINX_TARGET" "$backup"
  fi
  run_root cp "$NGINX_SOURCE" "$NGINX_TARGET"
  if ! run_root nginx -t -c "$NGINX_TARGET"; then
    run_root test -s "$backup" && run_root cp "$backup" "$NGINX_TARGET"
    rm -f "$backup"
    fail 'Nginx configuration validation failed'
  fi
  rm -f "$backup"
  if [[ -f /run/nginx.pid ]]; then
    run_root nginx -s reload
  else
    run_root nginx -c "$NGINX_TARGET"
  fi
}

cd "$PROJECT_ROOT"
pnpm install --frozen-lockfile
pnpm build
publish_web
start_api
install_nginx
curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/api/scripts" >/dev/null
echo "[DONE] https://ai-murder-mystery.robinverse.me/"
