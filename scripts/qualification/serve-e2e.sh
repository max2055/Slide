#!/usr/bin/env bash
# macOS /bin/bash is 3.2: no `wait -n`. Services stay in this process group.
# Playwright launches the script detached and tears it down with SIGKILL of
# that group. A child that leaves the group keeps the inherited stdio pipes
# open, so the launcher never observes process close. Explicit stops kill only
# processes recorded from this run's service tree. A later same-group orphan
# adopted by init is not part of that tree and is left alone.
# A service can fork and exit between tree samples. The tracker records that
# child at fork time (macOS interpose) or adopts it (Linux subreaper) so the
# next stop still sees it. Sampling faster is not the mechanism.
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
tracker_pid=""
tracker_dir=""
tracker_py=""
tracker_sock=""

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

tracker_script() {
  if [[ -n "${tracker_py:-}" && -f "$tracker_py" ]]; then
    printf '%s' "$tracker_py"
    return 0
  fi
  printf '%s' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/serve-e2e-tracker.py"
}

ensure_tracker() {
  local _ attempt
  if [[ -n "${tracker_pid:-}" ]] && kill -0 "$tracker_pid" 2>/dev/null; then
    return 0
  fi
  tracker_py="$(tracker_script)"
  [[ -f "$tracker_py" ]] || {
    printf 'E2E服务异常：缺少进程跟踪器 %s\n' "$tracker_py" >&2
    return 1
  }
  tracker_dir="$(mktemp -d "${TMPDIR:-/tmp}/serve-e2e-track.XXXXXX")"
  tracker_sock="$tracker_dir/sock"
  python3 "$tracker_py" --serve "$tracker_dir" &
  tracker_pid=$!
  remember_owned "$tracker_pid"
  attempt=0
  while [[ "$attempt" -lt 200 ]]; do
    if [[ -f "$tracker_dir/ready" && -S "$tracker_sock" ]]; then
      return 0
    fi
    if ! kill -0 "$tracker_pid" 2>/dev/null; then
      printf 'E2E服务异常：进程跟踪器退出\n' >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 0.05 || true
  done
  printf 'E2E服务异常：进程跟踪器未就绪\n' >&2
  return 1
}

tracker_rpc() {
  python3 "$(tracker_script)" --rpc "$tracker_sock" "$@"
}

# Merge fork records and adopted descendants into the owned set. Same-group
# membership is not enough: only pids this tracker spawned or observed are added.
collect_tracked_pids() {
  local reply id
  [[ -n "${tracker_sock:-}" && -S "$tracker_sock" ]] || return 0
  reply="$(tracker_rpc collect 2>/dev/null || true)"
  for id in $reply; do
    remember_owned "$id"
  done
}

# Record pids while they are still descendants of this shell or of a service
# already identified, plus fork records that survived the parent exiting.
# Same-group membership alone is not identity.
record_service_tree() {
  local snapshot pid ppid queue current rest seen=" "
  collect_tracked_pids
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
  local reply
  service_pid=""
  ensure_tracker
  reply="$(tracker_rpc spawn --cwd "$PWD" -- "$@")" || return 1
  service_pid="$(printf '%s' "$reply" | tr -d '[:space:]')"
  [[ "$service_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'E2E服务异常：进程跟踪器没有返回服务 pid\n' >&2
    return 1
  }
  remember_owned "$service_pid"
}

# Prints the exit code and returns 0 once the child has gone. Returns 1 while
# it is still running. `kill -0` stays true for a zombie, and bash 3.2 cannot
# poll with `wait -n`, so the state check decides when `wait` is safe.
child_finished() {
  local pid="$1"
  local state status=""
  if kill -0 "$pid" 2>/dev/null; then
    state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "$state" || "${state#Z}" == "$state" ]]; then
      return 1
    fi
  fi
  if [[ -n "${tracker_sock:-}" && -S "$tracker_sock" ]]; then
    status="$(tracker_rpc status "$pid" 2>/dev/null || true)"
    if [[ "$status" =~ ^[0-9]+$ ]]; then
      printf '%s' "$status"
      return 0
    fi
  fi
  wait "$pid" 2>/dev/null || status=$?
  printf '%s' "$status"
  return 0
}

signal_owned() {
  local signal="$1"
  local member
  for member in $owned_pids; do
    [[ -n "${tracker_pid:-}" && "$member" == "$tracker_pid" ]] && continue
    kill "-$signal" "$member" 2>/dev/null || true
  done
}

stop_our_processes() {
  record_service_tree
  signal_owned TERM
  sleep 0.2 || true
  record_service_tree
  signal_owned KILL
  # A child forked while its parent was exiting is already in the tracker log.
  # Read that log again after the parent is gone, then stop those pids too.
  record_service_tree
  signal_owned KILL
  if [[ "${tracker_pid:-}" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$tracker_pid" 2>/dev/null || true
    wait "$tracker_pid" 2>/dev/null || true
  fi
  if [[ -n "${tracker_dir:-}" && -d "$tracker_dir" ]]; then
    rm -rf "$tracker_dir"
    tracker_sock=""
  fi
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

# Service creates a child and exits before the next sample. Stop must remove
# that child without scanning the process group. macOS reparents it to launchd;
# Linux reparents it to this tracker because the tracker is a subreaper.
gap_probe() {
  local label="$1"
  local expect="$2"
  shift 2
  local probe_dir child_pid finished=0 child_ppid="" child_pgid="" shell_pgid="" owned=0
  probe_dir="${SERVE_E2E_DIR:?}"
  capture_baseline
  start_service "$@"
  api_pid="$service_pid"
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
    if [[ -s "$probe_dir/child" ]] && ! kill -0 "$api_pid" 2>/dev/null; then
      break
    fi
    sleep 0.05 || true
  done
  # Same gap as the review probe: one sample interval after the parent is gone.
  sleep 0.1 || true
  child_pid="$(tr -d '[:space:]' <"$probe_dir/child" 2>/dev/null || true)"
  if [[ ! "$child_pid" =~ ^[1-9][0-9]*$ ]]; then
    printf 'FAIL %s child pid missing\n' "$label" >&2
    exit 1
  fi
  child_ppid="$(ps -o ppid= -p "$child_pid" 2>/dev/null | tr -d '[:space:]' || true)"
  child_pgid="$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d '[:space:]' || true)"
  shell_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]' || true)"
  printf 'orphan_before_ppid=%s orphan_before_pgid=%s shell_pgid=%s\n' "${child_ppid:-none}" "${child_pgid:-none}" "${shell_pgid:-none}"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    [[ "$child_ppid" == "1" ]] && owned=1
  elif [[ -n "${tracker_pid:-}" && "$child_ppid" == "$tracker_pid" ]]; then
    owned=1
  fi
  if [[ "$owned" != 1 || -z "$shell_pgid" || "$child_pgid" != "$shell_pgid" ]]; then
    printf 'FAIL %s child was not an in-group tracked orphan\n' "$label" >&2
    exit 1
  fi
  printf 'orphan_before_owner=tracked\n'
  if ! finished="$(child_finished "$api_pid")"; then
    printf 'FAIL %s service still running\n' "$label" >&2
    exit 1
  fi
  printf 'service_exit=%s\n' "$finished"
  if [[ "$finished" != "$expect" ]]; then
    printf 'FAIL %s exit %s != %s\n' "$label" "$finished" "$expect" >&2
    exit 1
  fi
  record_service_tree
  stop_our_processes
  if kill -0 "$child_pid" 2>/dev/null; then
    printf 'FAIL orphan service child survives: %s\n' "$child_pid" >&2
    ps -o pid=,ppid=,pgid=,command= -p "$child_pid" >&2 || true
    kill -TERM "$child_pid" 2>/dev/null || true
    exit 1
  fi
  printf 'PASS %s\n' "$label"
  exit 0
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

if [[ "${SERVE_E2E_FUNCTION_PROBE:-}" == "fork-gap" ]]; then
  gap_probe fork-gap 7 /bin/bash -c 'sleep 60 & echo $! > "$1"; exit 7' bash "${SERVE_E2E_DIR:?}/child"
fi
if [[ "${SERVE_E2E_FUNCTION_PROBE:-}" == "node-gap" ]]; then
  if [[ ! -x "${SERVE_E2E_NODE:-}" ]]; then
    printf 'FAIL node-gap missing node\n' >&2
    exit 1
  fi
  gap_probe node-gap 3 "$SERVE_E2E_NODE" --input-type=module -e 'import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" }); writeFileSync(process.env.SERVE_E2E_DIR + "/child", String(child.pid)); child.unref(); process.exit(3);'
fi

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
