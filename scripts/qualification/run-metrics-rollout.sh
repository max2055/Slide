#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root_dir"
mysql_container="max76-mysql-$$"
host_container="max76-host-$$"
mysql_started=0
host_started=0
cleanup() {
  if [[ "$host_started" == 1 ]]; then docker rm -f "$host_container" >/dev/null; fi
  if [[ "$mysql_started" == 1 ]]; then docker rm -f "$mysql_container" >/dev/null; fi
}
trap cleanup EXIT INT TERM
# Ports are allocated by Docker; no existing DB, .env, or application process is used.
docker run --name "$mysql_container" -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1::3306 -d mysql:8.0 >/dev/null
mysql_started=1
docker run --name "$host_container" -p 127.0.0.1::22 -d alpine:3.22 sh -c \
  'apk add --no-cache openssh procps util-linux coreutils && ssh-keygen -A && adduser -D fixture && echo fixture:isolated-fixture | chpasswd && exec /usr/sbin/sshd -D -e' >/dev/null
host_started=1
ready=0
for attempt in $(seq 1 60); do
  if docker exec "$mysql_container" mysqladmin ping --silent >/dev/null 2>&1 && docker exec "$host_container" pgrep sshd >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then echo 'isolated container readiness failed' >&2; exit 1; fi
export METRICS_V2_TEST_MYSQL_PORT="$(docker port "$mysql_container" 3306/tcp | cut -d: -f2)"
export METRICS_V2_TEST_SSH_PORT="$(docker port "$host_container" 22/tcp | cut -d: -f2)"
export METRICS_V2_TEST_SSH_PASSWORD=isolated-fixture
export METRICS_V2_BROWSER=1
export MAX76_DATABASE_REPORT=../../docs/slide/metrics-v2/rollout/database-evidence.json
export MAX76_HOST_REPORT=../../docs/slide/metrics-v2/rollout/host-evidence.json
export MAX76_SNMP_REPORT=../../docs/slide/metrics-v2/rollout/snmp-evidence.json
export MAX76_CAPACITY_REPORT=../../docs/slide/metrics-v2/rollout/capacity.json
pnpm --filter slide-api exec vitest run src/metrics-v2 src/contracts/metrics-v2 --maxWorkers=1
pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts
