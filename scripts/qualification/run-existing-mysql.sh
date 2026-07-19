#!/usr/bin/env bash
set -euo pipefail

scenario="${1:-}"
if [[ "$scenario" != "bootstrap-upgrade" && "$scenario" != "failover" && "$scenario" != "backup-restore" && "$scenario" != "stability" ]]; then
  echo "usage: $0 {bootstrap-upgrade|failover|backup-restore|stability}" >&2
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

echo "qualification $scenario passed against existing container: database=$database"
