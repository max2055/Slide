#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

QUALIFICATION_DB_NAME=db_ops_ai_qualification \
QUALIFICATION_ADMIN_PASSWORD="${QUALIFICATION_ADMIN_PASSWORD:?QUALIFICATION_ADMIN_PASSWORD is required}" \
  pnpm --filter slide-api exec node ../../scripts/qualification/bootstrap-admin.mjs

api_pid=""
vite_pid=""
cleanup() {
  test -n "$vite_pid" && kill "$vite_pid" 2>/dev/null || true
  test -n "$api_pid" && kill "$api_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PORT=3003 AGENT_WS_PORT=28890 DB_NAME=db_ops_ai_qualification \
ENCRYPTION_KEY=qualification-encryption-key-2026-07-19-not-production \
  pnpm --filter slide-api exec tsx server.ts &
api_pid=$!

for _ in $(seq 1 45); do
  if curl --fail --silent --max-time 1 http://127.0.0.1:3003/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --max-time 3 http://127.0.0.1:3003/api/health >/dev/null

VITE_API_PROXY_TARGET=http://127.0.0.1:3003 \
VITE_AGENT_WS_PROXY_TARGET=http://127.0.0.1:28890 \
VITE_AGENT_WS_URL=ws://127.0.0.1:28890 \
  pnpm --filter slide-frontend exec vite --host 127.0.0.1 --port 5175 &
vite_pid=$!
wait "$vite_pid"
