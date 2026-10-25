#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
mode="${1:---full}"
case "$mode" in --full|--integration|--api|--rollout) ;; *) echo 'Use --full, --integration, --api or --rollout' >&2; exit 64 ;; esac
if [[ -n "${T12_API_SHARD:-}" && "$mode" != --api ]]; then
  echo 'T12_API_SHARD is only valid with --api' >&2
  exit 64
fi
if [[ -n "${T12_API_SHARD:-}" && ! "${T12_API_SHARD}" =~ ^([1-8]|exec)$ ]]; then
  echo 'T12_API_SHARD must be 1..8 or exec' >&2
  exit 64
fi
container="slide-t12-$$-$RANDOM"
operations_container="${container}-operations"
operations_port=''
cleanup() {
  docker stop --timeout 10 "$operations_container" >/dev/null 2>&1 || true
  docker stop --timeout 10 "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The existing representative package is qualified on MySQL8.4. Operations'
# reviewed formal mysql-basic source requires real 9.6. Keep both real gates;
# do not fake versions or widen an unreviewed package's applicability. The
# dedicated execution-recovery shard runs no Operations suite, so it skips the
# second server (and its image pull) entirely.
needs_operations=0
if [[ "$mode" == --full || "$mode" == --api ]]; then
  [[ "${T12_API_SHARD:-}" == exec ]] || needs_operations=1
fi
# Start both disposable servers before waiting so their image pulls and
# initialization overlap instead of adding two sequential startup costs.
docker run --detach --rm --name "$container" --memory=768m --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 --innodb-buffer-pool-size=67108864 --table-open-cache=128 --table-definition-cache=512 --mysqlx=0 >/dev/null &
primary_start=$!
if [[ "$needs_operations" == 1 ]]; then
  docker run --detach --rm --name "$operations_container" --memory=768m --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:9.6 --innodb-buffer-pool-size=67108864 --table-open-cache=128 --table-definition-cache=512 --mysqlx=0 >/dev/null &
  operations_start=$!
fi
wait "$primary_start"
if [[ "$needs_operations" == 1 ]]; then wait "$operations_start"; fi
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
if [[ "$ready" != 1 ]]; then echo 'Isolated T12 MySQL unavailable' >&2; exit 1; fi
if [[ "$needs_operations" == 1 ]]; then
  operations_port="$(docker port "$operations_container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
  operations_ready=0
  for _ in $(seq 1 60); do
    if OPERATIONS_TEST_MYSQL_PORT="$operations_port" pnpm --filter slide-api exec node -e '
      import("mysql2/promise").then(async ({default:mysql}) => {
        const c=await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.OPERATIONS_TEST_MYSQL_PORT),user:"root",password:""});
        await c.query("SELECT 1");await c.end();
      }).catch(()=>process.exit(1));' >/dev/null 2>&1; then operations_ready=1; break; fi
    sleep 1
  done
  if [[ "$operations_ready" != 1 ]]; then echo 'Isolated Operations MySQL9.6 unavailable' >&2; exit 1; fi
  export OPERATIONS_TEST_MYSQL_PORT="$operations_port" OPERATIONS_TEST_MYSQL_PASSWORD=''
  export OPERATIONS_TEST_MYSQL_CONTAINER="$operations_container"
fi
# Legacy suites also read DB_* directly. Bind them to this disposable server,
# never the host's default or configured platform database.
export DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD='' DB_NAME=slide_t12_isolated
export T06_TEST_MYSQL_PORT="$port" T06_TEST_MYSQL_PASSWORD=''
export INVESTIGATION_TEST_MYSQL_PORT="$port" INVESTIGATION_TEST_MYSQL_PASSWORD=''
export AGENT_RUN_TEST_MYSQL_PORT="$port" AGENT_RUN_TEST_MYSQL_PASSWORD='' T04_BROWSER_TEST=1
export AUTH_TEST_MYSQL_PORT="$port" AUTH_TEST_MYSQL_PASSWORD=''
export BUDGET_TEST_MYSQL_PORT="$port" BUDGET_TEST_MYSQL_PASSWORD=''
export TRIGGER_TEST_MYSQL_PORT="$port" TRIGGER_TEST_MYSQL_PASSWORD=''
export T08_TEST_MYSQL_PORT="$port" T08_TEST_MYSQL_PASSWORD=''
export T11_TEST_MYSQL_PORT="$port" T11_TEST_MYSQL_PASSWORD=''
if [[ "$mode" == --full || "$mode" == --api ]]; then
  # The full API candidate enables all existing MySQL gates on this exclusive
  # server. Suites requiring other resources still need their own fixtures.
  for prefix in REPORT CRON METRICS DELIVERY ALERT_EVENT APPROVAL SOURCE METRIC_QUALITY ANALYSIS INSTANCE_REMOVAL; do
    export "${prefix}_TEST_MYSQL_PORT=$port" "${prefix}_TEST_MYSQL_PASSWORD="
  done
fi
export JWT_SECRET_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export T12_OUTPUT_DIR="${T12_OUTPUT_DIR:-$root/.qualification/t12}"
mkdir -p "$T12_OUTPUT_DIR"
run_gate() {
  local name="$1"; shift
  "$@" >"$T12_OUTPUT_DIR/$name.log" 2>&1 || { tail -60 "$T12_OUTPUT_DIR/$name.log"; return 1; }
  tail -8 "$T12_OUTPUT_DIR/$name.log"
}
if [[ "$mode" == --api ]]; then
  # CI splits this suite into eight parallel shards, each against its own
  # isolated MySQL pair, plus one dedicated shard for the largest test file.
  # Unset keeps the single-process candidate for local/standalone use.
  api_args=(--maxWorkers=1 --reporter=default --reporter=json --outputFile="$T12_OUTPUT_DIR/api.json")
  if [[ "${T12_API_SHARD:-}" == exec ]]; then
    # Give the ~3.5-minute file its own shard so hash-ordered file blocks
    # cannot stack it behind another slow file.
    api_args+=(src/investigations/execution-recovery.mysql.test.ts)
  elif [[ -n "${T12_API_SHARD:-}" ]]; then
    api_args+=(--shard="$T12_API_SHARD/8" --exclude '**/execution-recovery.mysql.test.ts')
  fi
  run_gate api pnpm --filter slide-api test "${api_args[@]}"
  exit 0
fi
run_gate rollout pnpm --filter slide-api exec tsx ../../tests/qualification/investigation-rollout.ts
# CI owns SQL and browser coverage in separate jobs; standalone modes retain it.
if [[ "$mode" == --rollout ]]; then exit 0; fi
if [[ "$mode" == --full ]]; then
  run_gate agent-core pnpm --filter @slide/agent-core test
  run_gate api pnpm --filter slide-api test --maxWorkers=1
  run_gate frontend pnpm --filter slide-frontend test
  run_gate frontend-typecheck pnpm --filter slide-frontend typecheck
  run_gate frontend-build pnpm --filter slide-frontend build
  run_gate api-typecheck pnpm --filter slide-api typecheck
  run_gate contracts pnpm contracts:check
  run_gate matrix pnpm qualification:matrix
  run_gate security-agent pnpm security:agent
else
  run_gate investigation-sql pnpm --filter slide-api exec vitest run src/investigations src/adapter/__tests__/investigation-canonical.mysql.test.ts --maxWorkers=1
fi
run_gate browser pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts
if [[ "$mode" == --full ]]; then run_gate release-security pnpm release:security-gate; fi
echo 'T12 qualification complete; read raw reports and retained limitations before release.'
