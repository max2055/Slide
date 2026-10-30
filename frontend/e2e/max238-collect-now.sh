#!/usr/bin/env bash
# MAX238-NATIVE-COLLECT-NOW browser backend launcher.
# Starts a disposable MySQL on a random loopback port (never 3306), waits for it,
# then runs the real API fixture on MAX238_API_PORT. The run owns exactly one
# container, named and labelled with a per-run nonce; only that exact handle is
# ever removed. Cleanup reports success only when the daemon answers with its
# own not-found for the exact handle: an unreachable daemon, an inspect error
# that is not that answer, a wrong owner or a failed delete is non-zero and
# names the handle still to be dealt with.
set -euo pipefail
label_key="slide.max238.owner"
api_port="${MAX238_API_PORT:-51849}"
harness_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
handle_file="${MAX238_HANDLE_FILE:-$PWD/e2e/.max238-handle-$api_port.json}"
log() { echo "max238 fixture: $*" >&2; }

# Ask the daemon about one exact handle: 0 = present, 1 = the daemon answered
# that the handle does not exist (the only state that may be called removed),
# 2 = the daemon could not answer, so existence is unknown. A failed inspect is
# not proof of absence: only Docker's own not-found answer is. A daemon that
# answered `info` and then errors on `inspect` — disconnect, timeout, refused
# query — leaves the handle unknown, and the caller keeps its handle.
ref_state() {
  local ref="$1" err rc
  if ! docker info >/dev/null 2>&1; then
    log "docker daemon unavailable; cannot determine whether $ref exists"
    return 2
  fi
  if err="$(docker inspect --type container "$ref" 2>&1 >/dev/null)"; then
    printf 'present\n'; return 0
  else
    rc=$?
  fi
  case "$err" in
    *"No such object:"*|*"No such container:"*) printf 'absent\n'; return 1 ;;
  esac
  log "docker could not answer whether $ref exists (inspect exit $rc): ${err:-<no output>}; handle=$ref"
  return 2
}

# remove_owned NAME NONCE
# Returns 0 only when NAME is verifiably gone. Removal is bound to the exact
# container id whose label proves this run's ownership, so a parallel run or a
# same-prefix neighbour is never touched.
remove_owned() {
  local name="$1" nonce="$2" state rc info id owner
  if state="$(ref_state "$name")"; then rc=0; else rc=$?; fi
  if [ "$rc" -eq 1 ]; then log "verified absent: $name (owner $nonce)"; return 0; fi
  if [ "$rc" -ne 0 ]; then
    log "UNKNOWN whether $name (owner $nonce) exists; not reporting it removed; handle=$name"
    return 1
  fi
  if ! info="$(docker inspect --format "{{.Id}} {{index .Config.Labels \"$label_key\"}}" "$name" 2>/dev/null)"; then
    log "UNKNOWN owner of $name; refusing to remove; expected owner=$nonce handle=$name"
    return 1
  fi
  id="${info%% *}"; owner="${info#* }"
  if [ -z "$id" ] || [ "$owner" != "$nonce" ]; then
    log "refusing to remove $name; label $label_key is '$owner', not '$nonce'"
    return 1
  fi
  if ! docker rm -f "$id" >/dev/null 2>&1; then
    if state="$(ref_state "$id")"; then rc=0; else rc=$?; fi
    if [ "$rc" -eq 1 ]; then log "removed $name (id $id owner $nonce; verified after a concurrent removal)"; return 0; fi
    log "FAILED to remove $name (id $id owner $nonce); it may still exist; handle=$name"
    return 1
  fi
  if state="$(ref_state "$id")"; then rc=0; else rc=$?; fi
  if [ "$rc" -eq 1 ]; then log "removed $name (id $id owner $nonce)"; return 0; fi
  log "FAILED to verify removal of $name (id $id owner $nonce); handle=$name"
  return 1
}

# --cleanup NAME NONCE: the documented exact-handle removal used by operators
# and earlier evidence.
if [ "${1:-}" = "--cleanup" ]; then
  if remove_owned "${2:?container name}" "${3:?owner nonce}"; then exit 0; else exit 1; fi
fi

# --cleanup-handle FILE [--api-url URL]: teardown for a run whose API may
# already be gone. FILE is the handle this launcher wrote before creating the
# container, so the resource is located from the run-start record and never
# guessed from whatever answers on the port. A reachable API is cross-checked
# only; a mismatch is reported, not trusted.
if [ "${1:-}" = "--cleanup-handle" ]; then
  file="${2:?handle file}"
  api_url="${4:-}"
  read_json() {
    node -e 'const fs=require("node:fs");const raw=process.argv[1]==="-" ? fs.readFileSync(0,"utf8") : fs.readFileSync(process.argv[1],"utf8");const h=JSON.parse(raw);process.stdout.write([h.container??"",h.nonce??"",h.api_port??""].join("\t"))' "$1" 2>/dev/null
  }
  if [ ! -f "$file" ]; then log "handle file $file is missing; cannot prove which resource this run owned"; exit 1; fi
  if ! parsed="$(read_json "$file")"; then log "handle file $file is unreadable; cannot prove which resource this run owned"; exit 1; fi
  IFS=$'\t' read -r handle_name handle_nonce handle_port <<< "$parsed"
  if [ -z "$handle_name" ] || [ -z "$handle_nonce" ]; then log "handle file $file lacks a container or owner"; exit 1; fi
  anomaly=0
  if [ -n "$api_url" ] && command -v curl >/dev/null 2>&1; then
    if observed="$(curl --silent --show-error --fail --max-time 3 "$api_url/__test/handle" 2>/dev/null)"; then
      if ! fields="$(printf '%s' "$observed" | read_json -)"; then
        log "API $api_url answered but its handle is unreadable; treating the cross-check as unknown"; anomaly=1
      else
        IFS=$'\t' read -r live_name live_nonce _ <<< "$fields"
        if [ "$live_name" != "$handle_name" ] || [ "$live_nonce" != "$handle_nonce" ]; then
          log "ANOMALY: API $api_url reports container '$live_name' owner '$live_nonce', not this run's '$handle_name' owner '$handle_nonce'; cleaning only the run-start handle"
          anomaly=1
        fi
      fi
    else
      log "API $api_url is unreachable; using the run-start handle $handle_name (owner $handle_nonce)"
    fi
  fi
  if remove_owned "$handle_name" "$handle_nonce"; then
    rm -f "$file"
    [ "$anomaly" = 0 ] && exit 0 || exit 1
  fi
  exit 1
fi

nonce="${MAX238_E2E_NONCE:-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM$RANDOM}"
name="max238-cn-e2e-$nonce"
if state="$(ref_state "$name")"; then
  log "exact handle $name already exists; refusing to touch another run's resource"; exit 1
else
  rc=$?
  if [ "$rc" -ne 1 ]; then log "cannot prove the exact handle $name is free; refusing to start"; exit 1; fi
fi
# Old residue is logged by exact handle only; it is not this run's to remove.
if ! residue="$(docker container ls --all --format '{{.Names}} owner={{.Label "slide.max238.owner"}}' 2>&1)"; then
  log "docker container listing failed; refusing to start without knowing the current containers"
  printf '%s\n' "$residue" >&2
  exit 1
fi
printf '%s\n' "$residue" | grep '^max238-cn-e2e-' >&2 || true

json_str() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; printf '%s' "$s"; }
repo_sha="$(git -C "$(dirname "$harness_path")/../.." rev-parse HEAD 2>/dev/null || true)"
# Written before `docker run`, so even a failed start leaves the exact handle,
# its owner, and the PID/port/cwd/command/SHA that led to it.
write_handle() {
  local tmp="$handle_file.tmp.$$" mysql_port="${1:-}"
  if [ -n "$mysql_port" ]; then mysql_port="\"$mysql_port\""; else mysql_port="null"; fi
  mkdir -p "$(dirname "$handle_file")"
  cat > "$tmp" <<JSON
{
  "version": 1,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "nonce": "$nonce",
  "container": "$name",
  "owner_label": "$label_key",
  "api_port": $api_port,
  "mysql_port": $mysql_port,
  "launcher_pid": $$,
  "cwd": "$(json_str "$PWD")",
  "command": "$(json_str "bash $0 $*")",
  "harness": "$(json_str "$harness_path")",
  "harness_sha": "$(json_str "${repo_sha:-unknown}")",
  "handle_file": "$(json_str "$handle_file")",
  "logs": "$(json_str "stderr of pid $$")"
}
JSON
  mv -f "$tmp" "$handle_file"
}
write_handle ""
log "handle=$handle_file nonce=$nonce container=$name pid=$$ cwd=$PWD command=bash_$0 sha=${repo_sha:-unknown} api=127.0.0.1:$api_port logs=stderr_of_pid_$$"
created=1
cleanup() {
  local status=$?
  if [ "$created" = 1 ]; then
    if [ "$status" -ne 0 ]; then
      local state rc
      if state="$(ref_state "$name")"; then rc=0; else rc=$?; fi
      if [ "$rc" -eq 1 ]; then rm -f "$handle_file"; exit "$status"; fi
      log "run failed; retaining container $name and handle $handle_file for inspection"
      exit "$status"
    fi
    if remove_owned "$name" "$nonce"; then
      rm -f "$handle_file"
    elif [ "$status" -eq 0 ]; then status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# From here the exact handle is this run's responsibility, including a failed start.
docker run --detach --rm --name "$name" --label "$label_key=$nonce" \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$name" 3306/tcp | head -1 | sed 's/.*://')"
if [ -z "$port" ] || [ "$port" = "3306" ]; then
  log "refusing port '$port'; this run needs its own non-3306 port"
  exit 1
fi
write_handle "$port"
log "nonce=$nonce container=$name mysql=127.0.0.1:$port handle=$handle_file"
ready=0
for _ in $(seq 1 120); do
  if ! docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then
    log "$name exited or could not be queried before it accepted connections"
    docker logs "$name" 2>&1 | tail -20 >&2 || true
    exit 1
  fi
  if docker exec "$name" mysql -uroot -N -e 'SELECT 1' >/dev/null 2>&1; then
    sleep 2
    if docker exec "$name" mysql -uroot -N -e 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  fi
  sleep 1
done
if [ "$ready" = 0 ]; then log "$name was not ready within 120s"; exit 1; fi
MAX238_TEST_MYSQL_PORT="$port" MAX238_API_PORT="$api_port" MAX238_E2E_CONTAINER="$name" MAX238_E2E_NONCE="$nonce" \
  MAX238_HANDLE_FILE="$handle_file" MAX238_HARNESS_PATH="$harness_path" \
  ../apps/db-ops-api/node_modules/.bin/tsx ../apps/db-ops-api/e2e/max238-collect-now-server.ts
