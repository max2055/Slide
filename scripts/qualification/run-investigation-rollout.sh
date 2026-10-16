#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
mode="${1:---full}"
case "$mode" in --full|--integration|--api|--rollout) ;; *) echo 'Use --full, --integration, --api or --rollout' >&2; exit 64 ;; esac
container="slide-t12-$$-$RANDOM"
cleanup() { docker stop --time 10 "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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
if [[ "$ready" != 1 ]]; then echo 'Isolated T12 MySQL unavailable' >&2; exit 1; fi
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
  run_gate api pnpm --filter slide-api test --maxWorkers=1 --reporter=default --reporter=json --outputFile="$T12_OUTPUT_DIR/api.json"
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
