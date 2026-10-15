#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
container="slide-max180-ui-$$-$RANDOM"
cleanup() { docker stop --time 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
export DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD='' DB_NAME=db_ops_ai_qualification_MAX180 MAX180_ISOLATED_MYSQL=1
for _ in $(seq 1 60); do
  if pnpm --filter slide-api exec node --input-type=module -e '
    import mysql from "mysql2/promise";
    const c = await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:"root",password:""}); await c.query("SELECT 1");await c.end();
  ' >/dev/null 2>&1; then break; fi
  sleep 1
done
pnpm --filter slide-api exec tsx init-db.ts
pnpm --filter slide-frontend exec playwright test --config playwright.MAX-180.config.ts "$@"
