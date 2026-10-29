#!/usr/bin/env bash
# R3 only: disposable MySQL 8.4 + real API + real Vite + real Chromium.
# Exact ownership: container by nonce label + id, API/Vite by recorded PIDs that
# are re-verified (cwd/command) before being stopped. No port/name scanning.
set -u
label_key="slide.max238.owner"
nonce="br3$(openssl rand -hex 16)"
name="max238br3-$nonce"
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
handle="$repo/.r3-review/browser-$nonce.json"
logdir="$repo/.r3-review/browser-$nonce"
mkdir -p "$logdir"

api_port=13001
page_port=15173
key="$(openssl rand -hex 32)"
admin_pw="r3admin-$RANDOM$RANDOM"
target_pw="r3target-$RANDOM$RANDOM"
api_pid=""; vite_pid=""; cid=""

fail() { echo "FAIL: $*" >&2; exit 1; }
record() { printf '%s\n' "$@" >> "$handle"; }

cid="$(docker run --detach --rm --name "$name" --label "$label_key=$nonce" \
  -e MYSQL_ROOT_PASSWORD=r3pass -p 127.0.0.1::3306 mysql:8.4)" || fail "docker run failed"
port="$(docker port "$cid" 3306/tcp | awk -F: 'NR==1{print $NF}')"
[ -n "$port" ] && [ "$port" != "3306" ] || fail "refusing port '$port'"
record "container=$cid" "nonce=$nonce" "port=$port" "api_port=$api_port" "page_port=$page_port" "cwd=$repo"

for i in $(seq 1 120); do
  docker exec "$cid" mysqladmin ping -h127.0.0.1 -uroot -pr3pass --silent >/dev/null 2>&1 && break
  sleep 1; [ "$i" -eq 120 ] && fail "mysql not ready"
done

cd apps/db-ops-api
MAX238_DBPORT="$port" MAX238_DBPW=r3pass MAX238_ADMIN_PASSWORD="$admin_pw" \
MAX238_TARGET_PASSWORD="$target_pw" MAX238_RUN_NONCE="$nonce" ENCRYPTION_KEY="$key" \
  npx tsx ../../docs/slide/development/MAX-238/config-lifecycle-20261030/seed.ts > "$logdir/seed.json" 2> "$logdir/seed.err"
seed_rc=$?
[ "$seed_rc" -eq 0 ] || { tail -30 "$logdir/seed.err" >&2; fail "seed failed ($seed_rc)"; }
db="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["database"])' "$logdir/seed.json")" || fail "seed json unreadable"
unbound="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["unbound_instance"])' "$logdir/seed.json")"
unbound2="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["unbound_storage_instance"])' "$logdir/seed.json")"
echo "database=$db unbound=$unbound unbound_storage=$unbound2"

PORT="$api_port" DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD=r3pass DB_NAME="$db" \
ENCRYPTION_KEY="$key" JWT_SECRET_KEY="$key" METRICS_COLLECTION_ENABLED=true \
  npx tsx server.ts > "$logdir/api.log" 2>&1 &
api_pid=$!
record "api_pid=$api_pid"
cd "$repo/frontend"
VITE_API_PROXY_TARGET="http://127.0.0.1:$api_port" npx vite --port "$page_port" --strictPort > "$logdir/vite.log" 2>&1 &
vite_pid=$!
record "vite_pid=$vite_pid"

cleanup() {
  local rc=$?
  if [ -n "$vite_pid" ] && kill -0 "$vite_pid" 2>/dev/null; then kill "$vite_pid" 2>/dev/null || true; fi
  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then kill "$api_pid" 2>/dev/null || true; fi
  wait "$vite_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  if [ -n "$cid" ]; then
    local live
    live="$(docker inspect -f "{{.Id}} {{index .Config.Labels \"$label_key\"}}" "$cid" 2>/dev/null)" || {
      echo "could not inspect $cid; keeping $handle" >&2; exit "$rc"; }
    set -- $live
    if [ "$1" = "$cid" ] && [ "$2" = "$nonce" ]; then
      if docker rm -f "$cid" >/dev/null 2>&1; then echo "removed $cid (owner $nonce)"; \
        rm -f "$handle"; else echo "FAILED to remove $cid; keeping $handle" >&2; rc=1; fi
    else
      echo "owner/id mismatch; keeping $handle" >&2; rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

for i in $(seq 1 120); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$api_port/api/auth/login" \
    -H 'Content-Type: application/json' -d "{\"username\":\"life-admin\",\"password\":\"$admin_pw\"}" || true)"
  [ "$code" = "200" ] && break
  sleep 1; [ "$i" -eq 120 ] && { tail -40 "$logdir/api.log" >&2; fail "api not ready ($code)"; }
done
for i in $(seq 1 120); do
  curl -s -o /dev/null "http://127.0.0.1:$page_port/" && break
  sleep 1; [ "$i" -eq 120 ] && { tail -20 "$logdir/vite.log" >&2; fail "vite not ready"; }
done

MAX238_PAGE="http://127.0.0.1:$page_port" MAX238_API="http://127.0.0.1:$api_port" \
MAX238_DBPORT="$port" MAX238_DBPW=r3pass MAX238_DB="$db" MAX238_ADMIN_PASSWORD="$admin_pw" \
MAX238_UNBOUND_RESOURCE="$unbound" MAX238_UNBOUND2_RESOURCE="$unbound2" \
MAX238_EVIDENCE_DIR="$repo/docs/slide/development/MAX-238/r3-browser" \
  node "$repo/docs/slide/development/MAX-238/r3-browser/flow.mjs" 2>&1 | tee "$logdir/flow.log"
rc=${PIPESTATUS[0]}
echo "flow_exit=$rc"
exit "$rc"
