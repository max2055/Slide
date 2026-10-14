#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-t08-$$-$RANDOM"
cleanup() { docker stop --time 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
stable=0
for _ in $(seq 1 60); do
  if T08_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec node -e '
    import("mysql2/promise").then(async ({default:mysql}) => {
      const c = await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.T08_TEST_MYSQL_PORT),user:"root",password:""});
      await c.query("SELECT 1"); await c.end();
    }).catch(() => process.exit(1));' >/dev/null 2>&1; then
    stable=$((stable+1)); if [[ "$stable" -ge 3 ]]; then break; fi
  else stable=0; fi
  sleep 1
done
if [[ "$stable" -lt 3 ]]; then echo 'Isolated T08 MySQL unavailable' >&2; exit 1; fi
T08_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec vitest run src/investigations/legacy-analysis-bridge.test.ts src/investigations/alert-bridge.test.ts src/investigations/alert-bridge-pool.test.ts src/network-devices/network-device-alert-evaluator.mysql.test.ts
if [[ "${1:-}" == '--browser' ]]; then
  T06_TEST_MYSQL_PORT="$port" pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts investigation-bridges.spec.ts
elif [[ "${1:-}" == '--browser-all' ]]; then
  T06_TEST_MYSQL_PORT="$port" pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts
fi
