#!/usr/bin/env bash
# macOS /bin/bash is 3.2: no `wait -n`. Each service is its own process group
# so a stop signal reaches only that group, including children reparented
# after the leader exits. Do not signal the supervisor group.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

api_port="${QUALIFICATION_API_PORT:-3003}"
ws_port="${QUALIFICATION_WS_PORT:-28890}"
frontend_port="${QUALIFICATION_FRONTEND_PORT:-5175}"

qualification_encryption_key='qualification-e2e-key-32-bytes!!'
# REST and WebSocket auth must share an explicit key, including on clean CI hosts.
qualification_jwt_secret="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"))')"

grouped_pid=""
grouped_pgid=""
api_pid=""
api_pgid=""
vite_pid=""
vite_pgid=""
llm_pid=""
llm_pgid=""
cleaned_up=0

start_grouped() {
  grouped_pid=""
  grouped_pgid=""
  perl -e 'use POSIX; POSIX::setpgid(0, 0); exec @ARGV or die $!' -- "$@" &
  grouped_pid=$!
  local attempt actual shell_pgid
  shell_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]' || true)"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    actual="$(ps -o pgid= -p "$grouped_pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -n "$actual" && "$actual" == "$grouped_pid" && "$actual" != "$shell_pgid" ]]; then
      grouped_pgid="$grouped_pid"
      return 0
    fi
    if [[ -z "$actual" ]] && ! kill -0 "$grouped_pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.05 || true
  done
}

sweep_group() {
  local pgid="$1"
  local signal="$2"
  local member member_pgid
  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] || return 0
  while read -r member member_pgid; do
    [[ "$member" =~ ^[1-9][0-9]*$ ]] || continue
    [[ "$member_pgid" == "$pgid" ]] || continue
    [[ "$member" == "$$" ]] && continue
    kill "-$signal" "$member" 2>/dev/null || true
  done <<EOF
$(ps -ax -o pid=,pgid= 2>/dev/null || true)
EOF
}

stop_group() {
  local pid="${1:-}"
  local pgid="${2:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  [[ "$pid" != "$$" ]] || return 0

  local ppid="" state="" attempt
  ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$pgid" && "$pgid" == "$pid" && "$ppid" == "$$" ]]; then
    kill -TERM "-$pid" 2>/dev/null || true
  elif [[ "$ppid" == "$$" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
  fi

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "$state" || "${state#Z}" != "$state" ]]; then
      break
    fi
    sleep 0.1 || true
  done
  ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$state" && "${state#Z}" == "$state" && "$ppid" == "$$" ]]; then
    if [[ -n "$pgid" && "$pgid" == "$pid" ]]; then
      kill -KILL "-$pid" 2>/dev/null || true
    else
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi

  if [[ -n "$pgid" ]]; then
    sweep_group "$pgid" TERM
    sleep 0.2 || true
    sweep_group "$pgid" KILL
  fi
  wait "$pid" 2>/dev/null || true
  return 0
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

cleanup() {
  if [[ "$cleaned_up" == 1 ]]; then
    return 0
  fi
  cleaned_up=1
  trap '' INT TERM
  stop_group "$vite_pid" "$vite_pgid"
  stop_group "$api_pid" "$api_pgid"
  stop_group "$llm_pid" "$llm_pgid"
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

if [[ "${QUALIFICATION_CANCELLATION_E2E:-0}" == "1" ]]; then
  start_grouped node scripts/qualification/cancellable-openai-server.mjs
  llm_pid="$grouped_pid"
  llm_pgid="$grouped_pgid"
  DB_NAME=db_ops_ai_qualification ENCRYPTION_KEY="$qualification_encryption_key" \
    pnpm --filter slide-api exec tsx ../../scripts/qualification/configure-cancellable-provider.ts
fi

PORT="$api_port" AGENT_WS_PORT="$ws_port" DB_NAME=db_ops_ai_qualification \
JWT_SECRET_KEY="$qualification_jwt_secret" \
ENCRYPTION_KEY="$qualification_encryption_key" \
  start_grouped bash -c 'cd apps/db-ops-api && exec node --import tsx server.ts'
api_pid="$grouped_pid"
api_pgid="$grouped_pgid"

ready=0
for _ in $(seq 1 45); do
  finished=""
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
  start_grouped node frontend/node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$frontend_port" --strictPort frontend
vite_pid="$grouped_pid"
vite_pgid="$grouped_pgid"

while true; do
  finished=""
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
