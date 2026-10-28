#!/usr/bin/env bash
# MAX238-APPLY-IDEMPOTENCY-R2 browser backend launcher.
# Starts a disposable MySQL (never 3306), waits for it, then runs the real API
# fixture on MAX238_API_PORT. The container is removed when this script exits.
set -euo pipefail
name="max238-e2e-$$"
cleanup() { docker stop "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
# A runner that kills the script without SIGTERM leaves its own container behind;
# sweep only this fixture's prefix before starting a new one.
docker ps --filter "name=max238-e2e-" --format '{{.Names}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
docker rm -f "$name" >/dev/null 2>&1 || true
docker run --detach --rm --name "$name" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes \
  --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$name" 3306/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 120); do
  if docker exec "$name" mysqladmin ping -uroot --silent >/dev/null 2>&1; then break; fi
  sleep 1
done
MAX238_TEST_MYSQL_PORT="$port" MAX238_API_PORT="${MAX238_API_PORT:-51839}" \
  ../apps/db-ops-api/node_modules/.bin/tsx ../apps/db-ops-api/e2e/max238-real-api-server.ts
