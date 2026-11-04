#!/usr/bin/env bash
# Isolated supervisor check for scripts/qualification/serve-e2e.sh (#460).
# Stubs replace pnpm, node and curl. No database, port bind, or model call.
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/qualification/serve-e2e.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/max288-XXXXXX")"
bin="$work/bin"
mkdir -p "$bin"
result=0
bystander=""
watchdog=""

finish() {
  local pid
  if [[ -n "${watchdog:-}" ]]; then
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi
  if [[ -n "${bystander:-}" ]]; then
    kill "$bystander" 2>/dev/null || true
    wait "$bystander" 2>/dev/null || true
  fi
  if [[ -f "$work/pids" ]]; then
    while read -r pid; do
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
      kill -TERM "$pid" 2>/dev/null || true
    done <"$work/pids"
  fi
  rm -rf "$work"
}
trap finish EXIT

cat >"$bin/pnpm" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$bin/curl" <<'EOF'
#!/bin/sh
ready="${SERVE_E2E_READY_FILE:-}"
if [ -n "$ready" ] && [ -f "$ready" ]; then
  exit 0
fi
exit 1
EOF
cat >"$bin/node" <<'EOF'
#!/bin/sh
args="$*"
case "$args" in
  *--input-type=module*)
    printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    exit 0
    ;;
esac
role=""
case "$args" in
  *server.ts*) role=api ;;
  *vite/bin/vite.js*) role=vite ;;
  *)
    echo "unexpected node invocation: $args" >&2
    exit 99
    ;;
esac
printf '%s\n' "$$" > "${SERVE_E2E_DIR}/${role}.pid"
sleep 600 &
printf '%s\n' "$!" > "${SERVE_E2E_DIR}/${role}.child"
mode="$(eval "printf '%s' \"\${SERVE_E2E_${role}_MODE:-stay}\"")"
if [ "$role" = api ]; then
  : > "${SERVE_E2E_READY_FILE}"
fi
if [ "$mode" = exit ]; then
  if [ "$role" = api ]; then
    i=0
    while [ ! -s "${SERVE_E2E_DIR}/vite.pid" ]; do
      i=$((i + 1))
      if [ "$i" -gt 50 ]; then
        exit 7
      fi
      sleep 0.1
    done
    sleep 0.3
    exit 7
  fi
  sleep 0.4
  exit 9
fi
exec sleep 600
EOF
chmod +x "$bin/pnpm" "$bin/curl" "$bin/node"

sleep 600 &
bystander=$!
shell_pgid="$(ps -o pgid= -p "$$" | tr -d '[:space:]')"
bystander_pgid="$(ps -o pgid= -p "$bystander" | tr -d '[:space:]')"

alive() {
  kill -0 "$1" 2>/dev/null
}

run_scenario() {
  local name="$1"
  local api_mode="$2"
  local vite_mode="$3"
  local signal="$4"
  local expect_exit="$5"
  local expect_text="$6"
  local dir="$work/$name"
  local err="$dir/stderr"
  local report="$dir/report"
  mkdir -p "$dir"
  : >"$work/pids"
  local script_pid="" api_pid="" vite_pid="" api_child="" vite_child="" code=0

  PATH="$bin:$PATH" \
  SERVE_E2E_DIR="$dir" \
  SERVE_E2E_READY_FILE="$dir/ready" \
  SERVE_E2E_api_MODE="$api_mode" \
  SERVE_E2E_vite_MODE="$vite_mode" \
  QUALIFICATION_ADMIN_PASSWORD="isolated-not-a-secret" \
  QUALIFICATION_API_PORT=39731 \
  QUALIFICATION_WS_PORT=39732 \
  QUALIFICATION_FRONTEND_PORT=39733 \
  QUALIFICATION_DEEPSEEK_API_KEY="" \
  QUALIFICATION_CANCELLATION_E2E=0 \
    bash "$script" >"$dir/stdout" 2>"$err" &
  script_pid=$!
  echo "$script_pid" >>"$work/pids"
  (
    sleep 12
    kill -TERM "$script_pid" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  local local_watchdog=$!
  echo "$local_watchdog" >>"$work/pids"

  local i snapshot=""
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if [[ -z "$snapshot" && -s "$dir/api.pid" && -s "$dir/vite.pid" && -s "$dir/api.child" && -s "$dir/vite.child" ]]; then
      api_pid="$(cat "$dir/api.pid")"
      vite_pid="$(cat "$dir/vite.pid")"
      api_child="$(cat "$dir/api.child")"
      vite_child="$(cat "$dir/vite.child")"
      snapshot="$(ps -o pid=,ppid=,pgid=,command= -p "$script_pid" -p "$api_pid" -p "$vite_pid" -p "$api_child" -p "$vite_child" -p "$bystander" 2>/dev/null || true)"
    fi
    if [[ "$signal" == none ]]; then
      if ! alive "$script_pid"; then
        break
      fi
    elif [[ -n "$snapshot" ]]; then
      sleep 0.3 || true
      kill "-$signal" "$script_pid" 2>/dev/null || true
      break
    fi
    if ! alive "$script_pid"; then
      break
    fi
    sleep 0.2 || true
  done

  wait "$script_pid" || code=$?
  kill "$local_watchdog" 2>/dev/null || true
  wait "$local_watchdog" 2>/dev/null || true

  api_pid="$(cat "$dir/api.pid" 2>/dev/null || true)"
  vite_pid="$(cat "$dir/vite.pid" 2>/dev/null || true)"
  api_child="$(cat "$dir/api.child" 2>/dev/null || true)"
  vite_child="$(cat "$dir/vite.child" 2>/dev/null || true)"
  local api_pgid="" vite_pgid="" script_pgid=""
  script_pgid="$(ps -o pgid= -p "$script_pid" 2>/dev/null | tr -d '[:space:]' || true)"
  api_pgid="$(ps -o pgid= -p "$api_pid" 2>/dev/null | tr -d '[:space:]' || true)"
  vite_pgid="$(ps -o pgid= -p "$vite_pid" 2>/dev/null | tr -d '[:space:]' || true)"

  {
    echo "scenario=$name"
    echo "script_pid=$script_pid script_pgid=${script_pgid:-gone} shell_pgid=$shell_pgid"
    echo "api_pid=${api_pid:-none} api_pgid=${api_pgid:-gone} api_child=${api_child:-none}"
    echo "vite_pid=${vite_pid:-none} vite_pgid=${vite_pgid:-gone} vite_child=${vite_child:-none}"
    echo "bystander_pid=$bystander bystander_pgid=$bystander_pgid"
    echo "script_exit=$code expected=$expect_exit signal=$signal"
    echo "ownership<<"
    printf '%s\n' "${snapshot:-missing}"
    echo ">>"
    echo "stderr<<EOF"
    cat "$err" 2>/dev/null || true
    echo "EOF"
  } | tee "$report"

  local ok=1
  if [[ "$code" != "$expect_exit" ]]; then
    echo "FAIL $name exit $code != $expect_exit" | tee -a "$report"
    ok=0
  fi
  if ! grep -F "$expect_text" "$err" >/dev/null; then
    echo "FAIL $name missing text: $expect_text" | tee -a "$report"
    ok=0
  fi
  if [[ -n "$api_pid" ]] && alive "$api_pid"; then
    echo "FAIL $name api still alive $api_pid" | tee -a "$report"
    ok=0
  fi
  if [[ -n "$api_child" ]] && alive "$api_child"; then
    echo "FAIL $name api child still alive $api_child" | tee -a "$report"
    ok=0
  fi
  if [[ "$signal" != none || "$vite_mode" == exit || -s "$dir/vite.pid" ]]; then
    if [[ -z "$vite_pid" ]]; then
      echo "FAIL $name vite pid missing" | tee -a "$report"
      ok=0
    elif alive "$vite_pid"; then
      echo "FAIL $name vite still alive $vite_pid" | tee -a "$report"
      ok=0
    fi
    if [[ -n "$vite_child" ]] && alive "$vite_child"; then
      echo "FAIL $name vite child still alive $vite_child" | tee -a "$report"
      ok=0
    fi
  fi
  if ! alive "$bystander"; then
    echo "FAIL $name bystander killed $bystander" | tee -a "$report"
    ok=0
  fi
  if [[ -z "$snapshot" ]]; then
    echo "FAIL $name missing live ownership snapshot" | tee -a "$report"
    ok=0
  else
    local api_live_pgid vite_live_pgid api_live_ppid child_pgid bystander_live_pgid
    api_live_pgid="$(awk -v id="$api_pid" '$1==id {print $3}' <<<"$snapshot")"
    api_live_ppid="$(awk -v id="$api_pid" '$1==id {print $2}' <<<"$snapshot")"
    vite_live_pgid="$(awk -v id="$vite_pid" '$1==id {print $3}' <<<"$snapshot")"
    child_pgid="$(awk -v id="$api_child" '$1==id {print $3}' <<<"$snapshot")"
    bystander_live_pgid="$(awk -v id="$bystander" '$1==id {print $3}' <<<"$snapshot")"
    if [[ "$api_live_ppid" != "$script_pid" || "$api_live_pgid" != "$api_pid" || "$api_live_pgid" == "$shell_pgid" ]]; then
      echo "FAIL $name api group ownership ppid=$api_live_ppid pgid=$api_live_pgid" | tee -a "$report"
      ok=0
    fi
    if [[ "$vite_live_pgid" != "$vite_pid" || "$vite_live_pgid" == "$shell_pgid" || "$vite_live_pgid" == "$api_live_pgid" ]]; then
      echo "FAIL $name vite group ownership pgid=$vite_live_pgid" | tee -a "$report"
      ok=0
    fi
    if [[ "$child_pgid" != "$api_live_pgid" ]]; then
      echo "FAIL $name api child left the api group pgid=$child_pgid" | tee -a "$report"
      ok=0
    fi
    if [[ "$bystander_live_pgid" != "$shell_pgid" ]]; then
      echo "FAIL $name bystander pgid drifted $bystander_live_pgid" | tee -a "$report"
      ok=0
    fi
  fi
  if [[ "$ok" == 1 ]]; then
    echo "PASS $name" | tee -a "$report"
  else
    result=1
  fi
  echo "$api_pid" "$api_child" "$vite_pid" "$vite_child" >>"$work/pids"
}

echo "bash=$(bash --version | head -1)"
echo "root=$root"
echo "bystander=$bystander pgid=$bystander_pgid shell_pgid=$shell_pgid"

run_scenario api-exit exit stay none 1 "E2E服务异常：API退出 code=7"
run_scenario vite-exit stay exit none 1 "E2E服务异常：Vite退出 code=9"
run_scenario signal-term stay stay TERM 0 "E2E服务停止：收到信号，清理本次进程"
run_scenario signal-int stay stay INT 0 "E2E服务停止：收到信号，清理本次进程"

if [[ "$result" == 0 ]]; then
  echo "PASS serve-e2e supervisor"
else
  echo "FAIL serve-e2e supervisor"
fi
exit "$result"
