#!/usr/bin/env bash
# Isolated supervisor check for scripts/qualification/serve-e2e.sh (#460).
# Stubs replace pnpm, node and curl. No database, port bind, or model call.
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
real_node="$(command -v node)"
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
  if [[ -f "$work/orphan.pid" ]]; then
    pid="$(tr -d '[:space:]' <"$work/orphan.pid" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
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

# Sibling of the supervisor, same process group, then reparented to init.
# It never belongs to the supervisor service tree. Same-group + new + orphan
# must not be treated as ownership.
create_unrelated_orphan() {
  local dest="$1"
  local script_pid="$2"
  local pid="" ppid="" pgid="" script_pgid=""
  pid="$(bash -c 'sleep 60 </dev/null >/dev/null 2>&1 & echo $!; exit 0')" || true
  pid="$(printf '%s' "$pid" | tr -d '[:space:]')"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "$pid" >"$work/orphan.pid"
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  script_pgid="$(ps -o pgid= -p "$script_pid" 2>/dev/null | tr -d '[:space:]' || true)"
  {
    echo "orphan_pid=${pid:-none}"
    echo "orphan_ppid=${ppid:-none}"
    echo "orphan_pgid=${pgid:-none}"
    echo "orphan_script_pgid=${script_pgid:-none}"
  } >"$dest"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$ppid" == "1" && -n "$script_pgid" && "$pgid" == "$script_pgid" ]] || return 1
  return 0
}

run_scenario() {
  local name="$1"
  local api_mode="$2"
  local vite_mode="$3"
  local signal="$4"
  local expect_exit="$5"
  local expect_text="$6"
  local inject="${7:-}"
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
      if [[ "$inject" == orphan ]]; then
        create_unrelated_orphan "$dir/orphan.txt" "$script_pid" || true
      fi
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
    echo "script_exit=$code expected=$expect_exit signal=$signal inject=${inject:-none}"
    if [[ "$inject" == orphan ]]; then
      echo "unrelated_orphan<<"
      cat "$dir/orphan.txt" 2>/dev/null || echo missing
      echo ">>"
    fi
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
  if [[ "$inject" == orphan ]]; then
    local orphan_pid="" orphan_ppid="" orphan_pgid="" orphan_script_pgid=""
    orphan_pid="$(sed -n 's/^orphan_pid=//p' "$dir/orphan.txt" 2>/dev/null || true)"
    orphan_ppid="$(sed -n 's/^orphan_ppid=//p' "$dir/orphan.txt" 2>/dev/null || true)"
    orphan_pgid="$(sed -n 's/^orphan_pgid=//p' "$dir/orphan.txt" 2>/dev/null || true)"
    orphan_script_pgid="$(sed -n 's/^orphan_script_pgid=//p' "$dir/orphan.txt" 2>/dev/null || true)"
    if [[ "$orphan_ppid" != "1" || -z "$orphan_script_pgid" || "$orphan_pgid" != "$orphan_script_pgid" ]]; then
      echo "FAIL $name orphan is not a same-group init child ppid=${orphan_ppid:-none} pgid=${orphan_pgid:-none} script_pgid=${orphan_script_pgid:-none}" | tee -a "$report"
      ok=0
    elif [[ -z "$orphan_pid" ]] || ! alive "$orphan_pid"; then
      echo "FAIL $name unrelated orphan killed ${orphan_pid:-none}" | tee -a "$report"
      ok=0
    else
      echo "unrelated_orphan_before=[$orphan_pid] unrelated_orphan_after=alive" | tee -a "$report"
    fi
  fi
  if [[ -z "$snapshot" ]]; then
    echo "FAIL $name missing live ownership snapshot" | tee -a "$report"
    ok=0
  else
    local api_live_pgid vite_live_pgid api_live_ppid child_pgid bystander_live_pgid script_live_pgid
    script_live_pgid="$(awk -v id="$script_pid" '$1==id {print $3}' <<<"$snapshot")"
    api_live_pgid="$(awk -v id="$api_pid" '$1==id {print $3}' <<<"$snapshot")"
    api_live_ppid="$(awk -v id="$api_pid" '$1==id {print $2}' <<<"$snapshot")"
    vite_live_pgid="$(awk -v id="$vite_pid" '$1==id {print $3}' <<<"$snapshot")"
    child_pgid="$(awk -v id="$api_child" '$1==id {print $3}' <<<"$snapshot")"
    bystander_live_pgid="$(awk -v id="$bystander" '$1==id {print $3}' <<<"$snapshot")"
    if [[ "$api_live_ppid" != "$script_pid" || -z "$script_live_pgid" || "$api_live_pgid" != "$script_live_pgid" || "$api_live_pgid" == "$api_pid" ]]; then
      echo "FAIL $name api left the supervisor group ppid=$api_live_ppid pgid=$api_live_pgid script_pgid=$script_live_pgid" | tee -a "$report"
      ok=0
    fi
    if [[ -z "$vite_live_pgid" || "$vite_live_pgid" != "$script_live_pgid" || "$vite_live_pgid" == "$vite_pid" ]]; then
      echo "FAIL $name vite left the supervisor group pgid=$vite_live_pgid script_pgid=$script_live_pgid" | tee -a "$report"
      ok=0
    fi
    if [[ "$child_pgid" != "$script_live_pgid" ]]; then
      echo "FAIL $name api child left the supervisor group pgid=$child_pgid script_pgid=$script_live_pgid" | tee -a "$report"
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
run_scenario unrelated-orphan stay stay TERM 0 "E2E服务停止：收到信号，清理本次进程" orphan

# Playwright webServer: shell + detached, stdio pipes, SIGKILL of the launcher
# process group, then wait for the child 'close' event. A service that left
# the group keeps those pipes open and this check fails closed=0.
playwright_sigkill() {
  local name="playwright-sigkill"
  local dir="$work/$name"
  local report="$dir/report"
  mkdir -p "$dir"
  : >"$work/pids"
  cat >"$dir/launch.mjs" <<'EOF'
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const script = process.argv[2];
const dir = process.argv[3];
const bin = process.argv[4];

function readPid(name) {
  const file = `${dir}/${name}`;
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trim();
}

function alive(pid) {
  if (!/^[1-9][0-9]*$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

const child = spawn(`bash ${JSON.stringify(script)}`, {
  detached: true,
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    SERVE_E2E_DIR: dir,
    SERVE_E2E_READY_FILE: `${dir}/ready`,
    SERVE_E2E_api_MODE: 'stay',
    SERVE_E2E_vite_MODE: 'stay',
    QUALIFICATION_ADMIN_PASSWORD: 'isolated-not-a-secret',
    QUALIFICATION_API_PORT: '39751',
    QUALIFICATION_WS_PORT: '39752',
    QUALIFICATION_FRONTEND_PORT: '39753',
    QUALIFICATION_DEEPSEEK_API_KEY: '',
    QUALIFICATION_CANCELLATION_E2E: '0',
  },
});
let closed = false;
child.on('close', () => {
  closed = true;
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

const readyDeadline = Date.now() + 8000;
while (Date.now() < readyDeadline) {
  if (readPid('api.pid') && readPid('vite.pid') && readPid('api.child') && readPid('vite.child')) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const api = readPid('api.pid');
const vite = readPid('vite.pid');
const apiChild = readPid('api.child');
const viteChild = readPid('vite.child');
let killError = '';
try {
  process.kill(-child.pid, 'SIGKILL');
} catch (error) {
  killError = error instanceof Error ? error.message : String(error);
}
const closeDeadline = Date.now() + 2000;
while (!closed && Date.now() < closeDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const survivors = [api, vite, apiChild, viteChild].filter((pid) => alive(pid));
console.log(`closed=${closed ? 1 : 0}`);
console.log(`kill_error=${killError}`);
console.log(`survivors=${survivors.join(',') || 'none'}`);
console.log(`api=${api} vite=${vite} api_child=${apiChild} vite_child=${viteChild} launcher=${child.pid}`);
if (!closed || survivors.length > 0 || killError || !api || !vite || !apiChild || !viteChild) {
  for (const pid of [api, vite, apiChild, viteChild]) {
    if (!alive(pid)) continue;
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  process.exit(1);
}
EOF
  local code=0
  "$real_node" "$dir/launch.mjs" "$script" "$dir" "$bin" >"$dir/stdout" 2>"$dir/stderr" || code=$?
  {
    echo "scenario=$name"
    echo "script_exit=$code"
    echo "stdout<<EOF"
    cat "$dir/stdout" 2>/dev/null || true
    echo "EOF"
    echo "stderr<<EOF"
    cat "$dir/stderr" 2>/dev/null || true
    echo "EOF"
  } | tee "$report"
  local ok=1
  if [[ "$code" != 0 ]]; then
    echo "FAIL $name launcher close exit=$code" | tee -a "$report"
    ok=0
  fi
  if ! grep -F "closed=1" "$dir/stdout" >/dev/null; then
    echo "FAIL $name parent close did not fire" | tee -a "$report"
    ok=0
  fi
  if ! alive "$bystander"; then
    echo "FAIL $name bystander killed $bystander" | tee -a "$report"
    ok=0
  fi
  if [[ "$ok" == 1 ]]; then
    echo "PASS $name" | tee -a "$report"
  else
    result=1
  fi
  if [[ -f "$dir/api.pid" ]]; then
    cat "$dir/api.pid" "$dir/api.child" "$dir/vite.pid" "$dir/vite.child" 2>/dev/null >>"$work/pids" || true
  fi
}

playwright_sigkill

if [[ "$result" == 0 ]]; then
  echo "PASS serve-e2e supervisor"
else
  echo "FAIL serve-e2e supervisor"
fi
exit "$result"
