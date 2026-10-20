#!/usr/bin/env bash
# Local exclusive container only. Never addresses a host/port/shared database.
set -euo pipefail
umask 077
mode="${1:-}"
container="${2:-}"
schema="${3:-}"
snapshot="${4:-}"
if [[ "$mode" != backup && "$mode" != restore ]]; then exit 64; fi
if [[ ! "$container" =~ ^slide-v23-source-[a-z0-9-]+$ || ! "$schema" =~ ^slide_v23_source_[a-f0-9]{8,32}$ ]]; then exit 64; fi
label="$(docker inspect --format '{{index .Config.Labels "com.slide.v23.source"}}' "$container")"
if [[ -z "$label" || "$label" == '<no value>' ]]; then exit 65; fi
ports="$(docker port "$container" 3306/tcp)"
if [[ ! "$ports" =~ ^127\.0\.0\.1:[0-9]+$ || "$ports" =~ :(3306|3307|3308)$ ]]; then exit 65; fi
root=/Users/max/Coding/40-Slide/outputs
if [[ "$snapshot" != "$root"/* || "$snapshot" == *'/../'* || "$snapshot" == *'/./'* ]]; then exit 64; fi
# Existing protected parent only; reject symlink redirects and clobbering.
parent="$(cd "$(dirname "$snapshot")" && pwd -P)"
if [[ "$parent" != "$root"/* || -L "$snapshot" ]]; then exit 65; fi
export MYSQL_PWD="${V23_SOURCE_LOCAL_MYSQL_PASSWORD:-}"
sql() { docker exec --env MYSQL_PWD "$container" mysql --batch --skip-column-names -uroot "$@"; }
if [[ "$mode" == backup ]]; then
  if [[ -e "$snapshot" || -e "$snapshot.sha256" || -e "$snapshot.ledger" ]]; then exit 65; fi
  # Pause source operations before invoking: no data or migration writer may
  # run while snapshots/verification are being made.
  active="$(sql "$schema" -e "SELECT COUNT(*) FROM worker_leases WHERE expires_at>NOW()")"
  if [[ "$active" != 0 ]]; then exit 65; fi
  set -o noclobber
  docker exec --env MYSQL_PWD "$container" mysqldump -uroot --single-transaction --set-gtid-purged=OFF "$schema" > "$snapshot"
  sql "$schema" -e 'SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id' > "$snapshot.ledger"
  shasum -a 256 "$snapshot" > "$snapshot.sha256"
else
  # Restore only into a fresh second schema; do not DROP or overwrite anything.
  (cd "$parent" && shasum -a 256 -c "$snapshot.sha256")
  restore_schema="${schema}_restore"
  sql -e "CREATE DATABASE \`$restore_schema\` DEFAULT CHARACTER SET utf8mb4"
  docker exec -i --env MYSQL_PWD "$container" mysql -uroot "$restore_schema" < "$snapshot"
  restored_ledger="$(sql "$restore_schema" -e 'SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id')"
  expected_ledger="$(cat "$snapshot.ledger")"
  if [[ "$restored_ledger" != "$expected_ledger" ]]; then exit 65; fi
  # Restored work remains inert: no worker/API is started by this utility.
  sql "$restore_schema" -e "SELECT 'restored',COUNT(*) FROM app_schema_migrations WHERE status='completed'; SELECT 'pending_work',COUNT(*) FROM workflow_jobs WHERE state NOT IN ('completed','cancelled'); SELECT 'approval_used',COALESCE(SUM(used_count),0) FROM agent_tool_approvals"
fi
