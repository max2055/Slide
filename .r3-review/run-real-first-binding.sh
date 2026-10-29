#!/usr/bin/env bash
# R3 only: one disposable MySQL 8.4 container owned by this exact run nonce.
# Never scans by name/port, never kills by executable name; cleanup uses the
# exact container id after re-reading the ownership label.
set -u
label_key="slide.max238.owner"
nonce="r3$(openssl rand -hex 16)"
name="max238r3-$nonce"
handle=".r3-review/container-$nonce.json"
log=".r3-review/container-$nonce.log"
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

fail() { echo "FAIL: $*" >&2; exit 1; }

id="$(docker run --detach --rm --name "$name" --label "$label_key=$nonce" \
  -e MYSQL_ROOT_PASSWORD=r3pass -p 127.0.0.1::3306 mysql:8.4 2>>"$log")" || fail "docker run failed (see $log)"
printf '{"container":"%s","nonce":"%s","owner_label":"%s","pid":%s,"cwd":"%s"}\n' \
  "$id" "$nonce" "$label_key" "$$" "$PWD" > "$handle"
echo "container=$id nonce=$nonce handle=$handle"

cleanup() {
  local live
  live="$(docker inspect -f "{{.Id}} {{index .Config.Labels \"$label_key\"}}" "$id" 2>/dev/null)" || {
    echo "could not inspect $id; leaving handle $handle" >&2; return 1; }
  set -- $live
  [ "$1" = "$id" ] || { echo "container id mismatch; leaving $handle" >&2; return 1; }
  [ "$2" = "$nonce" ] || { echo "owner mismatch ($2 != $nonce); leaving $handle" >&2; return 1; }
  if docker rm -f "$id" >/dev/null 2>&1; then
    rm -f "$handle"
    echo "removed $id (owner $nonce)"
  else
    echo "FAILED to remove $id; handle kept at $handle" >&2; return 1
  fi
}
trap 'rc=$?; cleanup || true; exit $rc' EXIT

for i in $(seq 1 90); do
  if docker exec "$id" mysqladmin ping -h 127.0.0.1 -uroot -pr3pass --silent >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" -eq 90 ] && fail "mysql did not become ready"
done
port="$(docker port "$id" 3306/tcp | awk -F: 'NR==1{print $NF}')"
[ -n "$port" ] || fail "could not read the published port"
echo "port=$port"

cd apps/db-ops-api
MAX238_FIRST_BINDING=1 MAX238_TEST_MYSQL_PORT="$port" MAX238_TEST_MYSQL_PASSWORD=r3pass \
MAX238_TARGET_PASSWORD=r3target MAX238_HANDLE_DIR="$repo/.r3-review/handles" \
  npx vitest run src/metrics/templates/first-binding.real.test.ts 2>&1 | tail -80
rc=${PIPESTATUS[0]}
echo "vitest_exit=$rc"
exit "$rc"
