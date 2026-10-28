#!/usr/bin/env bash
# MAX238-APPLY-IDEMPOTENCY-R3 browser backend launcher.
# Starts a disposable MySQL on a random loopback port (never 3306), waits for it,
# then runs the real API fixture on MAX238_API_PORT. The run owns exactly one
# container, identified by a per-run nonce carried on its label; only that exact
# handle is removed. Residue from other runs is recorded, never swept by prefix.
set -euo pipefail
label_key="slide.max238.owner"
owned_by() { [ "$(docker inspect --format "{{index .Config.Labels \"$label_key\"}}" "$1" 2>/dev/null)" = "$2" ]; }
remove_owned() {
  local name="$1" nonce="$2"
  if ! docker inspect "$name" >/dev/null 2>&1; then echo "max238 fixture: $name already removed" >&2; return 0; fi
  if ! owned_by "$name" "$nonce"; then
    echo "max238 fixture: refusing to remove $name; label $label_key is not $nonce" >&2; return 1
  fi
  docker rm -f "$name" >/dev/null
  if docker inspect "$name" >/dev/null 2>&1; then
    echo "max238 fixture: FAILED to remove $name; it still exists" >&2; return 1
  fi
  echo "max238 fixture: removed $name (owner $nonce)" >&2
}
# The spec's afterAll calls this mode with the handle the API reported. It is the
# same verified removal the launcher uses, so a parallel run sharing the prefix
# (or any other run's container) is never touched.
if [ "${1:-}" = "--cleanup" ]; then
  remove_owned "${2:?container name}" "${3:?owner nonce}"
  exit $?
fi
nonce="${MAX238_E2E_NONCE:-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM$RANDOM}"
name="max238-e2e-$nonce"
created=0
cleanup() {
  local status=$?
  if [ "$created" = 1 ] && ! remove_owned "$name" "$nonce" && [ "$status" = 0 ]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if docker inspect "$name" >/dev/null 2>&1; then
  echo "max238 fixture: exact handle $name already exists; refusing to touch another run's resource" >&2
  exit 1
fi
# Old residue is logged by exact handle only; it is not this run's to remove.
docker ps -a --filter "name=max238-e2e-" --format '{{.Names}} owner={{.Label "slide.max238.owner"}}' >&2 || true
# From here the exact handle is this run's responsibility, including a failed start.
created=1
docker run --detach --rm --name "$name" --label "$label_key=$nonce" \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$name" 3306/tcp | head -1 | sed 's/.*://')"
if [ -z "$port" ] || [ "$port" = "3306" ]; then
  echo "max238 fixture: refusing port '$port'; this run needs its own non-3306 port" >&2
  exit 1
fi
echo "max238 fixture: nonce=$nonce container=$name pid=$$ cwd=$PWD mysql=127.0.0.1:$port api=${MAX238_API_PORT:-51839}" >&2
ready=0
for _ in $(seq 1 120); do
  if ! docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then
    echo "max238 fixture: $name exited before it accepted connections" >&2
    docker logs "$name" 2>&1 | tail -20 >&2 || true
    exit 1
  fi
  if docker exec "$name" mysqladmin ping -uroot --silent >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" = 0 ]; then echo "max238 fixture: $name was not ready within 120s" >&2; exit 1; fi
MAX238_TEST_MYSQL_PORT="$port" MAX238_API_PORT="${MAX238_API_PORT:-51839}" MAX238_E2E_CONTAINER="$name" MAX238_E2E_NONCE="$nonce" \
  ../apps/db-ops-api/node_modules/.bin/tsx ../apps/db-ops-api/e2e/max238-real-api-server.ts
