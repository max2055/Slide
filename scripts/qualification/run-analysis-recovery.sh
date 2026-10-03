#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-analysis-recovery-$$-$RANDOM"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --env MYSQL_ROOT_PASSWORD=qualification-test-password --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
# Wait through the initialization server restart on the published connection.
stable=0
for _ in $(seq 1 60); do
  if ANALYSIS_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec node -e '
    import("mysql2/promise").then(async ({default:mysql}) => {
      const c = await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.ANALYSIS_TEST_MYSQL_PORT),user:"root",password:"qualification-test-password"});
      await c.query("SELECT 1"); await c.end();
    }).catch(() => process.exit(1));' >/dev/null 2>&1; then
    stable=$((stable + 1))
    if [[ "$stable" -ge 3 ]]; then break; fi
  else stable=0; fi
  sleep 1
done
if [[ "$stable" -lt 3 ]]; then echo "isolated analysis MySQL unavailable" >&2; exit 1; fi
ANALYSIS_TEST_MYSQL_PORT="$port" ANALYSIS_TEST_MYSQL_PASSWORD=qualification-test-password \
  pnpm --filter slide-api exec vitest run src/analysis/analysis-recovery.mysql.test.ts src/analysis/analysis-provider.test.ts
