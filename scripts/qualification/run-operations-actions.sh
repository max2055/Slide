#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="max204-actions-$$-$RANDOM"
cleanup() { docker stop --timeout 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# No retained volume or shared server. MySQL9.6 also satisfies the existing
# mysql-basic source package's reviewed applicability boundary.
docker run --detach --rm --name "$container" --label slide.qualification=P11 \
  --memory=768m --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:9.6 \
  --innodb-buffer-pool-size=67108864 --table-open-cache=128 --table-definition-cache=512 --mysqlx=0 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" mysqladmin ping --silent >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then echo 'P11 isolated MySQL unavailable' >&2; exit 1; fi
export OPERATIONS_TEST_MYSQL_PORT="$port" OPERATIONS_TEST_MYSQL_PASSWORD=''
export OPERATIONS_TEST_MYSQL_CONTAINER="$container"
export DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD='' DB_NAME=max204_isolated
pnpm --filter slide-api exec tsx ../../tests/qualification/operations-actions.ts
