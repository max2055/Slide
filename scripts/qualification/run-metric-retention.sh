#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
container="slide-metric-retention-$$-$RANDOM"
container_started=0
test_exit=not-run
cleanup() {
  local command_exit=$? cleanup_exit=0
  trap - EXIT
  if [[ "$container_started" == 1 ]]; then
    docker rm -f "$container" >/dev/null || cleanup_exit=$?
  fi
  echo "metric-retention: command_exit=$command_exit test_exit=$test_exit cleanup_exit=$cleanup_exit"
  if [[ "$command_exit" != 0 ]]; then exit "$command_exit"; fi
  exit "$cleanup_exit"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --detach --rm --name "$container" --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
container_started=1
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
stable=0
for _ in $(seq 1 60); do
  if METRICS_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec node -e '
    import("mysql2/promise").then(async ({default:mysql}) => {
      const c = await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.METRICS_TEST_MYSQL_PORT),user:"root",password:""});
      await c.query("SELECT 1"); await c.end();
    }).catch(() => process.exit(1));' >/dev/null 2>&1; then
    stable=$((stable + 1))
    if [[ "$stable" -ge 3 ]]; then break; fi
  else stable=0; fi
  sleep 1
done
if [[ "$stable" -lt 3 ]]; then echo 'isolated metric retention MySQL unavailable' >&2; exit 1; fi
# The schemas are independent, but MigrationRunner uses one instance-level
# GET_LOCK with a 30s budget. Serialize files instead of queuing full migration
# chains behind that lock (MAX-642); keep concurrency within each suite intact.
test_exit=0
METRICS_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec vitest run --no-file-parallelism \
  src/workflows/metric-retention-handler.test.ts src/metrics/storage.mysql.test.ts src/metrics/rollout/control.mysql.test.ts \
  src/consistency-checker.mysql.test.ts || test_exit=$?
exit "$test_exit"
