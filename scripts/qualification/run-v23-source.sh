#!/usr/bin/env bash
set -euo pipefail
# The actual operator CLI writes its durable audit to the project's fixed
# artifact root. Provision that same root on disposable Linux GitHub runners;
# macOS uses the existing authorized output directory without changing it.
if [[ "${GITHUB_ACTIONS:-}" == "true" && "${RUNNER_OS:-}" == "Linux" ]]; then
  sudo install -d -o "$(id -u)" -g "$(id -g)" /Users/max/Coding/40-Slide/outputs
fi
container="slide-v23-source-ci-${RANDOM}-${RANDOM}"
cleanup() { docker stop "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --detach --rm --name "$container" --label com.slide.v23.source=ci \
  --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --publish 127.0.0.1::3306 mysql:8.4 >/dev/null
port="$(docker port "$container" 3306/tcp | awk -F: 'NR==1 {print $NF}')"
stable=0
for _ in $(seq 1 60); do
  if V23_SOURCE_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec node --input-type=module -e \
    'import mysql from "mysql2/promise"; const c=await mysql.createConnection({host:"127.0.0.1",port:Number(process.env.V23_SOURCE_TEST_MYSQL_PORT),user:"root",password:""}); await c.query("SELECT 1"); await c.end();' >/dev/null 2>&1; then
    stable=$((stable+1))
    if [[ "$stable" -ge 3 ]]; then break; fi
  else stable=0; fi
  sleep 1
done
if [[ "$stable" -lt 3 ]]; then exit 1; fi
V23_SOURCE_TEST_MYSQL_PORT="$port" pnpm --filter slide-api exec vitest run src/operations/source-package/control.mysql.test.ts src/operations/source-package/runtime.mysql.test.ts
