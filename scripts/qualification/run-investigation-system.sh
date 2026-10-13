#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-t09-browser-$$-$RANDOM"
cleanup() { docker stop --time 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
ready=0
for _ in $(seq 1 60); do
  if T06_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec node -e '
    import("mysql2/promise").then(async ({default:mysql}) => {
      const c=await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.T06_TEST_MYSQL_PORT),user:"root",password:""});
      await c.query("SELECT 1");await c.end();
    }).catch(()=>process.exit(1));' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then echo 'Isolated T09 MySQL unavailable' >&2; exit 1; fi
case "${1:-}" in
  --streaming)
    DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD='' pnpm --filter slide-frontend exec playwright test --config playwright.streaming-live.config.ts ;;
  --regression)
    AGENT_RUN_TEST_MYSQL_PORT="$port" AGENT_RUN_TEST_MYSQL_PASSWORD='' T04_BROWSER_TEST=1 pnpm --filter slide-api exec vitest run src/investigations/execution-recovery.mysql.test.ts
    T06_TEST_MYSQL_PORT="$port" pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts ;;
  --recovery-browser)
    AGENT_RUN_TEST_MYSQL_PORT="$port" AGENT_RUN_TEST_MYSQL_PASSWORD='' T04_BROWSER_TEST=1 pnpm --filter slide-api exec vitest run src/investigations/execution-recovery.mysql.test.ts -t 'real Chromium closes authenticated HTTP/WS' ;;
  '') T06_TEST_MYSQL_PORT="$port" pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts investigation-system.spec.ts ;;
  *) echo 'Unknown System qualification mode' >&2; exit 64 ;;
esac
