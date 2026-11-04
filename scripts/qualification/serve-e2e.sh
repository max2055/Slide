#!/usr/bin/env bash
# macOS /bin/bash is 3.2: no `wait -n`. Services stay in this process group.
# Playwright launches the script detached and tears it down with SIGKILL of
# that group. A child that leaves the group keeps the inherited stdio pipes
# open, so the launcher never observes process close. Explicit stops kill only
# processes recorded from this run's service tree. A later same-group orphan
# adopted by init is not part of that tree and is left alone.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

api_port="${QUALIFICATION_API_PORT:-3003}"
ws_port="${QUALIFICATION_WS_PORT:-28890}"
frontend_port="${QUALIFICATION_FRONTEND_PORT:-5175}"

qualification_encryption_key='qualification-e2e-key-32-bytes!!'
# REST and WebSocket auth must share an explicit key, including on clean CI hosts.
qualification_jwt_secret="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"))')"

service_pid=""
api_pid=""
vite_pid=""
llm_pid=""
group_pgid=""
baseline_pids=""
owned_pids=" "
cleaned_up=0

capture_baseline() {
  local pid pgid
  group_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]' || true)"
  baseline_pids=" $$ "
  while read -r pid pgid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    [[ "$pgid" == "$group_pgid" ]] || continue
    baseline_pids="${baseline_pids}${pid} "
  done <<EOF
$(ps -ax -o pid=,pgid= 2>/dev/null || true)
EOF
}

known_pid() {
  case "$baseline_pids" in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

remember_owned() {
  local id="$1"
  [[ "$id" =~ ^[1-9][0-9]*$ ]] || return 0
  [[ "$id" == "$$" || "$id" == "1" ]] && return 0
  if known_pid "$id"; then
    return 0
  fi
  case "$owned_pids" in
    *" $id "*) return 0 ;;
  esac
  owned_pids="${owned_pids}${id} "
}

# Record pids while they are still descendants of this shell or of a service
# already identified. Cleanup uses that record. Same-group membership and
# reparenting to init are not identity.
record_service_tree() {
  local snapshot pid ppid queue current rest seen=" "
  snapshot="$(ps -ax -o pid=,ppid= 2>/dev/null || true)"
  queue=" $$"
  if [[ "$api_pid" =~ ^[1-9][0-9]*$ ]]; then
    queue="$queue $api_pid"
  fi
  if [[ "$vite_pid" =~ ^[1-9][0-9]*$ ]]; then
    queue="$queue $vite_pid"
  fi
  if [[ "$llm_pid" =~ ^[1-9][0-9]*$ ]]; then
    queue="$queue $llm_pid"
  fi
  queue="$queue $owned_pids"
  while [[ "$queue" =~ [0-9] ]]; do
    queue="${queue#"${queue%%[![:space:]]*}"}"
    current="${queue%%[[:space:]]*}"
    rest="${queue#"$current"}"
    queue="${rest#"${rest%%[![:space:]]*}"}"
    [[ "$current" =~ ^[1-9][0-9]*$ ]] || continue
    case "$seen" in
      *" $current "*) continue ;;
    esac
    seen="${seen}${current} "
    remember_owned "$current"
    while read -r pid ppid; do
      [[ "$ppid" == "$current" ]] || continue
      queue="$queue $pid"
    done <<EOF
$snapshot
EOF
  done
  return 0
}

start_service() {
  service_pid=""
  "$@" &
  service_pid=$!
  remember_owned "$service_pid"
}

# Prints the exit code and returns 0 once the child has gone. Returns 1 while
# it is still running. `kill -0` stays true for a zombie, and bash 3.2 cannot
# poll with `wait -n`, so the state check decides when `wait` is safe.
child_finished() {
  local pid="$1"
  local state status=0
  if kill -0 "$pid" 2>/dev/null; then
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "$state" || "${state#Z}" == "$state" ]]; then
      return 1
    fi
  fi
  wait "$pid" 2>/dev/null || status=$?
  printf '%s' "$status"
  return 0
}

stop_our_processes() {
  local member
  record_service_tree
  for member in $owned_pids; do
    kill -TERM "$member" 2>/dev/null || true
  done
  sleep 0.2 || true
  record_service_tree
  for member in $owned_pids; do
    kill -KILL "$member" 2>/dev/null || true
  done
  if [[ "$api_pid" =~ ^[1-9][0-9]*$ ]]; then
    wait "$api_pid" 2>/dev/null || true
  fi
  if [[ "$vite_pid" =~ ^[1-9][0-9]*$ ]]; then
    wait "$vite_pid" 2>/dev/null || true
  fi
  if [[ "$llm_pid" =~ ^[1-9][0-9]*$ ]]; then
    wait "$llm_pid" 2>/dev/null || true
  fi
  return 0
}

cleanup() {
  if [[ "$cleaned_up" == 1 ]]; then
    return 0
  fi
  cleaned_up=1
  trap '' INT TERM
  stop_our_processes
  return 0
}

on_stop() {
  printf 'E2E服务停止：收到信号，清理本次进程 pid=%s\n' "$$" >&2
  exit 0
}

trap on_stop INT TERM
trap cleanup EXIT

QUALIFICATION_DB_NAME=db_ops_ai_qualification \
  pnpm --filter slide-api exec node ../../scripts/qualification/reset-e2e-db.mjs

DB_NAME=db_ops_ai_qualification \
  pnpm --filter slide-api exec tsx init-db.ts

QUALIFICATION_DB_NAME=db_ops_ai_qualification \
QUALIFICATION_ADMIN_PASSWORD="${QUALIFICATION_ADMIN_PASSWORD:?QUALIFICATION_ADMIN_PASSWORD is required}" \
ENCRYPTION_KEY="$qualification_encryption_key" \
  pnpm --filter slide-api exec node ../../scripts/qualification/bootstrap-admin.mjs

if [[ -n "${QUALIFICATION_DEEPSEEK_API_KEY:-}" ]]; then
  DB_NAME=db_ops_ai_qualification ENCRYPTION_KEY="$qualification_encryption_key" \
    pnpm --filter slide-api exec tsx ../../scripts/qualification/configure-deepseek.ts
fi

capture_baseline

if [[ "${QUALIFICATION_CANCELLATION_E2E:-0}" == "1" ]]; then
  start_service node scripts/qualification/cancellable-openai-server.mjs
  llm_pid="$service_pid"
  record_service_tree
  DB_NAME=db_ops_ai_qualification ENCRYPTION_KEY="$qualification_encryption_key" \
    pnpm --filter slide-api exec tsx ../../scripts/qualification/configure-cancellable-provider.ts
fi

PORT="$api_port" AGENT_WS_PORT="$ws_port" DB_NAME=db_ops_ai_qualification \
JWT_SECRET_KEY="$qualification_jwt_secret" \
ENCRYPTION_KEY="$qualification_encryption_key" \
  start_service bash -c 'cd apps/db-ops-api && exec node --import tsx server.ts'
api_pid="$service_pid"
record_service_tree

ready=0
for _ in $(seq 1 45); do
  finished=""
  record_service_tree
  if finished="$(child_finished "$api_pid")"; then
    printf 'E2E服务异常：API退出 code=%s pid=%s\n' "$finished" "$api_pid" >&2
    exit 1
  fi
  if curl --fail --silent --max-time 1 "http://127.0.0.1:${api_port}/api/health/ready" >/dev/null; then
    ready=1
    break
  fi
  sleep 1 || true
done
if [[ "$ready" != 1 ]]; then
  printf 'E2E服务异常：API在时限内未就绪 pid=%s\n' "$api_pid" >&2
  exit 1
fi

VITE_API_PROXY_TARGET="http://127.0.0.1:${api_port}" \
VITE_AGENT_WS_PROXY_TARGET="http://127.0.0.1:${ws_port}" \
VITE_AGENT_WS_URL="ws://127.0.0.1:${ws_port}" \
  start_service node frontend/node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$frontend_port" --strictPort frontend
vite_pid="$service_pid"
record_service_tree

while true; do
  finished=""
  record_service_tree
  if finished="$(child_finished "$api_pid")"; then
    printf 'E2E服务异常：API退出 code=%s pid=%s\n' "$finished" "$api_pid" >&2
    exit 1
  fi
  if finished="$(child_finished "$vite_pid")"; then
    printf 'E2E服务异常：Vite退出 code=%s pid=%s\n' "$finished" "$vite_pid" >&2
    exit 1
  fi
  sleep 0.2 || true
done
