#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
run_id="$(date +%s)-$RANDOM"
pg_container="slide-w03-pg-$run_id"
mysql_container="slide-w03-mysql-$run_id"
cleanup() {
  docker rm -f "$pg_container" "$mysql_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Test-only credentials; no existing services, volumes or .env files are used.
docker run --detach --rm --name "$pg_container" \
  --env POSTGRES_USER=w03_admin --env POSTGRES_PASSWORD=w03-fake-admin-password \
  --env POSTGRES_DB=w03_primary --env POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  --publish 127.0.0.1::5432 postgres:16-alpine >/dev/null
docker run --detach --rm --name "$mysql_container" \
  --env MYSQL_ROOT_PASSWORD=w03-fake-mysql-password --env MYSQL_DATABASE=w03_metadata \
  --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
pg_port="$(docker port "$pg_container" 5432/tcp | awk -F: 'NR==1 {print $NF}')"
mysql_port="$(docker port "$mysql_container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
export DB_HOST=127.0.0.1 DB_PORT="$mysql_port" DB_USER=root DB_PASSWORD=w03-fake-mysql-password DB_NAME=w03_metadata
export W03_PG_PORT="$pg_port" W03_PG_INTEGRATION=1
export ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export NODE_ENV=test

ready=0
for _ in $(seq 1 60); do
  # Probe the published ports, after each image's initialization-server restart.
  if pnpm --filter slide-api exec node --input-type=module -e '
    import pg from "pg";
    import mysql from "mysql2/promise";
    const p = new pg.Client({host:"127.0.0.1",port:Number(process.env.W03_PG_PORT),user:"w03_admin",password:"w03-fake-admin-password",database:"w03_primary"});
    let m;
    try {
      await p.connect(); await p.query("SELECT 1");
      m = await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
      await m.query("SELECT 1");
    } finally { await p.end(); if (m) await m.end(); }
  ' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then echo "Isolated PG/MySQL did not become ready" >&2; exit 1; fi

docker exec "$pg_container" psql -U w03_admin -d w03_primary -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE w03_reader LOGIN PASSWORD 'w03-fake-pg-password';" >/dev/null
docker exec "$pg_container" psql -U w03_admin -d w03_primary -v ON_ERROR_STOP=1 -c \
  'ALTER DATABASE w03_primary OWNER TO w03_reader;' >/dev/null
docker exec "$pg_container" psql -U w03_admin -d w03_primary -v ON_ERROR_STOP=1 -c \
  'CREATE DATABASE w03_secondary OWNER w03_reader;' >/dev/null
for database in w03_primary w03_secondary; do
  docker exec --env PGPASSWORD=w03-fake-pg-password "$pg_container" \
    psql -h 127.0.0.1 -U w03_reader -d "$database" -v ON_ERROR_STOP=1 -c \
    'CREATE TABLE widgets (id integer PRIMARY KEY, name text NOT NULL); CREATE INDEX widgets_name_idx ON widgets(name);' >/dev/null
done

# Reuse the authoritative system metadata schema in the isolated MySQL only.
pnpm --filter slide-api exec tsx init-db.ts > /dev/null
docker exec "$pg_container" psql -U w03_admin -d w03_primary -Atc 'SELECT version();'
echo "W03 isolated fixture: PG/MySQL on dynamically allocated 127.0.0.1 ports; SCRAM password authentication"
pnpm --filter slide-api exec vitest run tests/pg-collection.integration.test.ts
