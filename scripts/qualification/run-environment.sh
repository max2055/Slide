#!/usr/bin/env bash
set -euo pipefail

scenario="${1:-}"
if [[ "$scenario" != "bootstrap-upgrade" && "$scenario" != "failover" && "$scenario" != "backup-restore" && "$scenario" != "stability" ]]; then
  echo "usage: $0 {bootstrap-upgrade|failover|backup-restore|stability}" >&2
  exit 64
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
run_id="$(date +%s)-$RANDOM"
container="slide-qualification-${run_id}"
database="slide_qualification_${run_id//-/}"
password="qualification-root-${run_id}"
port=""

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --rm --name "$container" \
  --env "MYSQL_ROOT_PASSWORD=$password" \
  --publish 127.0.0.1::3306 \
  mysql:8.4 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" mysqladmin ping -uroot "-p$password" --silent >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" mysqladmin ping -uroot "-p$password" --silent >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 { print $NF }')"
if [[ -z "$port" ]]; then
  echo "unable to resolve qualification MySQL port" >&2
  exit 1
fi

# The image briefly exposes an initialization server before restarting into
# the final server. Require consecutive queries through the published port so
# migration startup cannot land in that restart window.
stable_checks=0
for _ in $(seq 1 60); do
  if DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD="$password" \
    pnpm --filter slide-api exec node -e \
      'import("mysql2/promise").then(async ({default:mysql}) => { const c = await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD}); await c.query("SELECT 1"); await c.end(); })' \
      >/dev/null 2>&1; then
    stable_checks=$((stable_checks + 1))
    if [[ "$stable_checks" -ge 3 ]]; then
      break
    fi
  else
    stable_checks=0
  fi
  sleep 1
done
if [[ "$stable_checks" -lt 3 ]]; then
  echo "qualification MySQL did not become stable on the published port" >&2
  exit 1
fi

run_init() {
  DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD="$password" DB_NAME="$database" \
    pnpm --filter slide-api exec tsx init-db.ts
}

run_init
if [[ "$scenario" == "bootstrap-upgrade" ]]; then
  run_init
fi
DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD="$password" DB_NAME="$database" \
  pnpm --filter slide-api exec tsx ../../tests/qualification/assert-bootstrap.ts
if [[ "$scenario" == "failover" ]]; then
  DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD="$password" DB_NAME="$database" \
    pnpm --filter slide-api exec tsx ../../tests/qualification/assert-failover.ts
fi
if [[ "$scenario" == "backup-restore" ]]; then
  backup="$(mktemp "${TMPDIR:-/tmp}/slide-qualification-backup.XXXXXX.sql")"
  restore_database="${database}_restore"
  trap 'rm -f "$backup"; cleanup' EXIT INT TERM
  DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD="$password" DB_NAME="$database" \
    pnpm --filter slide-api exec tsx ../../tests/qualification/assert-backup-restore.ts seed
  docker exec -e "MYSQL_PWD=$password" "$container" mysqldump -uroot "$database" > "$backup"
  docker exec -e "MYSQL_PWD=$password" "$container" mysql -uroot -e "CREATE DATABASE \`$restore_database\` DEFAULT CHARACTER SET utf8mb4"
  docker exec -i -e "MYSQL_PWD=$password" "$container" mysql -uroot "$restore_database" < "$backup"
  DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD="$password" DB_NAME="$restore_database" \
    pnpm --filter slide-api exec tsx ../../tests/qualification/assert-backup-restore.ts verify
fi
if [[ "$scenario" == "stability" ]]; then
  DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER=root DB_PASSWORD="$password" DB_NAME="$database" \
    pnpm --filter slide-api exec tsx ../../tests/qualification/assert-stability.ts
fi

echo "qualification $scenario passed: database=$database"
