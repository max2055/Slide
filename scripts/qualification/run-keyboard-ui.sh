#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-max173-keyboard-$$-$RANDOM"
cleanup() { docker stop --time 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
ready=0
for _ in $(seq 1 60); do
  if DB_PORT="$port" pnpm --filter slide-api exec node --input-type=module -e '
    import mysql from "mysql2/promise";
    try { const db = await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.DB_PORT),user:"root",password:""}); await db.query("SELECT 1"); await db.end(); } catch { process.exit(1); }
  ' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then echo 'MAX173 disposable MySQL unavailable' >&2; exit 1; fi
unset QUALIFICATION_DEEPSEEK_API_KEY
export DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD=''
export QUALIFICATION_API_PORT=3104 QUALIFICATION_WS_PORT=29004 QUALIFICATION_FRONTEND_PORT=5204
# Local startup provider fixture; no test sends an inference request.
export QUALIFICATION_CANCELLATION_E2E=1 QUALIFICATION_CANCELLABLE_LLM_PORT=29005
export QUALIFICATION_ADMIN_PASSWORD="$(node --input-type=module -e 'import {randomBytes} from "node:crypto";process.stdout.write(randomBytes(24).toString("hex"))')"
pnpm --filter slide-frontend exec playwright test --config playwright.keyboard-real.config.ts
