#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-max179-ui-$$-$RANDOM"
cleanup() { docker stop --time 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
ready=0
for _ in $(seq 1 60); do
  if DB_PORT="$port" pnpm --filter slide-api exec node --input-type=module -e '
    import mysql from "mysql2/promise";
    try { const connection = await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.DB_PORT),user:"root",password:""}); await connection.query("SELECT 1"); await connection.end(); } catch { process.exit(1); }
  ' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then echo 'MAX179 isolated MySQL unavailable' >&2; exit 1; fi
unset QUALIFICATION_DEEPSEEK_API_KEY
export DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD=''
export QUALIFICATION_API_PORT=51898 QUALIFICATION_WS_PORT=51899 QUALIFICATION_FRONTEND_PORT=51897
export QUALIFICATION_CANCELLATION_E2E=1 QUALIFICATION_CANCELLABLE_LLM_PORT=51900
export QUALIFICATION_ADMIN_PASSWORD='max179-isolated-fixture' MAX179_ISOLATED_MYSQL=1
pnpm --filter slide-frontend exec playwright test --config playwright.MAX-179.config.ts
