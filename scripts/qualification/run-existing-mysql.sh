#!/usr/bin/env bash
set -euo pipefail

scenario="${1:-}"
if [[ "$scenario" != "bootstrap-upgrade" && "$scenario" != "failover" && "$scenario" != "backup-restore" && "$scenario" != "stability" && "$scenario" != "startup-negative" && "$scenario" != "alert-rca" && "$scenario" != "agent-run-failure" && "$scenario" != "agent-run-cancel" && "$scenario" != "collection-schedule" && "$scenario" != "server-collector-failures" && "$scenario" != "health-truth" && "$scenario" != "workflow-catalog" ]]; then
  echo "usage: $0 {bootstrap-upgrade|failover|backup-restore|stability|startup-negative|alert-rca|agent-run-failure|agent-run-cancel|collection-schedule|server-collector-failures|health-truth|workflow-catalog}" >&2
  exit 64
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

container="${QUALIFICATION_MYSQL_CONTAINER:-mysql}"
host="${QUALIFICATION_MYSQL_HOST:-127.0.0.1}"
port="${QUALIFICATION_MYSQL_PORT:-3306}"
user="${QUALIFICATION_MYSQL_USER:-root}"
password="${QUALIFICATION_MYSQL_PASSWORD:-Tpam1234}"
run_id="$(date +%Y%m%d%H%M%S)-$RANDOM"
database="slide_qualification_existing_${run_id//-/}"
restore_database="${database}_restore"
backup=""
server_pid=""

mysql_exec() {
  docker exec -e "MYSQL_PWD=$password" "$container" mysql -u"$user" "$@"
}

drop_database() {
  local name="$1"
  if [[ "$name" != slide_qualification_existing_* ]]; then
    echo "refusing to drop non-qualification database: $name" >&2
    return 1
  fi
  mysql_exec -e "DROP DATABASE IF EXISTS \`$name\`"
}

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  [[ -n "$backup" ]] && rm -f "$backup"
  drop_database "$restore_database" >/dev/null 2>&1 || true
  drop_database "$database" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
  echo "existing MySQL container is not running: $container" >&2
  exit 1
fi
mysql_exec -e 'SELECT 1' >/dev/null
mysql_exec -e "CREATE DATABASE \`$database\` DEFAULT CHARACTER SET utf8mb4"

run_init() {
  DB_HOST="$host" DB_PORT="$port" DB_USER="$user" DB_PASSWORD="$password" DB_NAME="$database" \
    pnpm --filter slide-api exec tsx init-db.ts
}

run_assertion() {
  local assertion="$1"
  local target_database="$2"
  shift 2
  DB_HOST="$host" DB_PORT="$port" DB_USER="$user" DB_PASSWORD="$password" DB_NAME="$target_database" \
    pnpm --filter slide-api exec tsx "$assertion" "$@"
}

assert_process_rejects_startup() {
  local label="$1"
  shift
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/slide-qualification-${label}.XXXXXX.log")"
  set +e
  "$@" >"$log" 2>&1
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    cat "$log" >&2
    rm -f "$log"
    echo "qualification $label unexpectedly started successfully" >&2
    return 1
  fi
  if rg -q "Schema migration ledger is current|Agent Engine 已启动|Server listening" "$log"; then
    cat "$log" >&2
    rm -f "$log"
    echo "qualification $label reached listener or worker initialization" >&2
    return 1
  fi
  rm -f "$log"
}

run_init
if [[ "$scenario" == "bootstrap-upgrade" ]]; then
  run_init
fi
run_assertion ../../tests/qualification/assert-bootstrap.ts "$database"

if [[ "$scenario" == "failover" ]]; then
  run_assertion ../../tests/qualification/assert-failover.ts "$database"
fi

if [[ "$scenario" == "backup-restore" ]]; then
  backup="$(mktemp "${TMPDIR:-/tmp}/slide-qualification-backup.XXXXXX.sql")"
  run_assertion ../../tests/qualification/assert-backup-restore.ts "$database" seed
  docker exec -e "MYSQL_PWD=$password" "$container" mysqldump --single-transaction --set-gtid-purged=OFF -u"$user" "$database" > "$backup"
  mysql_exec -e "CREATE DATABASE \`$restore_database\` DEFAULT CHARACTER SET utf8mb4"
  docker exec -i -e "MYSQL_PWD=$password" "$container" mysql -u"$user" "$restore_database" < "$backup"
  run_assertion ../../tests/qualification/assert-backup-restore.ts "$restore_database" verify
fi

if [[ "$scenario" == "stability" ]]; then
  run_assertion ../../tests/qualification/assert-stability.ts "$database"
fi

if [[ "$scenario" == "alert-rca" ]]; then
  run_assertion ../../tests/qualification/assert-alert-rca.ts "$database"
fi

if [[ "$scenario" == "agent-run-failure" ]]; then
  run_assertion ../../tests/qualification/assert-agent-run-failure.ts "$database"
fi

if [[ "$scenario" == "agent-run-cancel" ]]; then
  run_assertion ../../tests/qualification/assert-agent-run-cancel.ts "$database"
fi

if [[ "$scenario" == "collection-schedule" ]]; then
  run_assertion ../../tests/qualification/assert-collection-schedule.ts "$database"
fi

if [[ "$scenario" == "server-collector-failures" ]]; then
  run_assertion ../../tests/qualification/assert-server-collector-failures.ts "$database"
fi

if [[ "$scenario" == "health-truth" ]]; then
  run_assertion ../../tests/qualification/assert-health-truth.ts "$database"
fi

if [[ "$scenario" == "workflow-catalog" ]]; then
  # Exercise the real process-level worker registration and dispatch path. The
  # isolated database has no resources/channels, so these controlled jobs
  # cannot make external calls. Ports are deliberately outside 3000/5173.
  for job_type in capacity.collect baseline.cleanup alert.evaluate; do
    job_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    mysql_exec "$database" -e "INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key, max_attempts, available_at) VALUES ('$job_id', '$job_type', 1, '{}', 'qualification-$job_type-$run_id', 1, NOW())"
  done
  log="$(mktemp "${TMPDIR:-/tmp}/slide-qualification-workflow.XXXXXX.log")"
  env NODE_ENV=development PORT=3004 AGENT_WS_PORT=28891 DB_HOST="$host" DB_PORT="$port" DB_USER="$user" DB_PASSWORD="$password" DB_NAME="$database" \
    JWT_SECRET_KEY=qualification-jwt-secret-2026-07-19-long ENCRYPTION_KEY=qualification-encryption-secret-2026-07-19 INITIAL_ADMIN_USERNAME=qualification INITIAL_ADMIN_PASSWORD=qualification \
    pnpm --filter slide-api exec tsx server.ts >"$log" 2>&1 &
  server_pid=$!
  completed=""
  for _ in {1..20}; do
    completed="$(mysql_exec "$database" -N -e "SELECT COUNT(*) FROM workflow_jobs WHERE job_type = 'alert.evaluate' AND state = 'completed'")"
    [[ "$completed" -eq 1 ]] && break
    sleep 1
  done
  if [[ "$completed" -lt 1 ]]; then
    cat "$log" >&2
    rm -f "$log"
    echo "workflow catalog qualification did not complete the controlled alert.evaluate job (completed=$completed)" >&2
    exit 1
  fi
  kill "$server_pid"
  wait "$server_pid" || true
  server_pid=""
  rm -f "$log"
fi

if [[ "$scenario" == "startup-negative" ]]; then
  # A production process must reject weak/missing secrets before it connects to
  # MySQL or can bind a listener. This runs against the same operator-provided
  # container but never starts a long-lived service.
  assert_process_rejects_startup weak-production-secret \
    env NODE_ENV=production PORT=3004 AGENT_WS_PORT=28891 DB_HOST="$host" DB_PORT="$port" DB_USER="$user" DB_PASSWORD="$password" DB_NAME="$database" \
    JWT_SECRET_KEY=secret ENCRYPTION_KEY=another-secret-that-is-long-enough-2026 INITIAL_ADMIN_USERNAME=qualification INITIAL_ADMIN_PASSWORD=qualification \
    pnpm --filter slide-api exec tsx server.ts

  # Simulate an interrupted migration after a successful initialization. The
  # server must fail closed before opening its listener or starting workers;
  # recovery requires an explicit repair, not an implicit retry.
  mysql_exec "$database" -e "UPDATE app_schema_migrations SET status = 'running', error = 'qualification interrupted migration' WHERE migration_id = '043_approval_execution_state_parity.sql'"
  assert_process_rejects_startup interrupted-migration \
    env NODE_ENV=production PORT=3004 AGENT_WS_PORT=28891 DB_HOST="$host" DB_PORT="$port" DB_USER="$user" DB_PASSWORD="$password" DB_NAME="$database" \
    JWT_SECRET_KEY=qualification-jwt-secret-2026-07-19-long ENCRYPTION_KEY=qualification-encryption-secret-2026-07-19 INITIAL_ADMIN_USERNAME=qualification INITIAL_ADMIN_PASSWORD=qualification \
    pnpm --filter slide-api exec tsx server.ts
  mysql_exec "$database" -e "SELECT status, error FROM app_schema_migrations WHERE migration_id = '043_approval_execution_state_parity.sql'" | rg -q '^running[[:space:]]+qualification interrupted migration$'
fi

echo "qualification $scenario passed against existing container: database=$database"
