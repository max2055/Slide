#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-investigation-tls-$$-$RANDOM"
cleanup() { docker stop --time 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --detach --rm --name "$container" --label slide.task=MAX-207 \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
stable=0
for _ in $(seq 1 60); do
  if T06_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec node --input-type=module -e \
    'import mysql from "mysql2/promise"; const c=await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.T06_TEST_MYSQL_PORT),user:"root",password:""}); await c.query("SELECT 1"); await c.end();' >/dev/null 2>&1; then
    stable=$((stable+1)); if [[ "$stable" -ge 3 ]]; then break; fi
  else stable=0; fi
  sleep 1
done
if [[ "$stable" -lt 3 ]]; then echo 'Isolated TLS test MySQL unavailable' >&2; exit 1; fi
T06_TEST_MYSQL_PORT="$port" T06_TEST_MYSQL_PASSWORD='' \
  pnpm --filter slide-frontend exec playwright test --config playwright.investigation-tls.config.ts "$@"
