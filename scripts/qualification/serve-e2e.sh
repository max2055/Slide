#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

api_port="${QUALIFICATION_API_PORT:-3003}"
ws_port="${QUALIFICATION_WS_PORT:-28890}"
frontend_port="${QUALIFICATION_FRONTEND_PORT:-5175}"

qualification_encryption_key='qualification-e2e-key-32-bytes!!'
# REST and WebSocket auth must share an explicit key, including on clean CI hosts.
qualification_jwt_secret="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"))')"

QUALIFICATION_DB_NAME=db_ops_ai_qualification \
  pnpm --filter slide-api exec node ../../scripts/qualification/reset-e2e-db.mjs

DB_NAME=db_ops_ai_qualification \
  pnpm --filter slide-api exec tsx init-db.ts

QUALIFICATION_DB_NAME=db_ops_ai_qualification \
QUALIFICATION_ADMIN_PASSWORD="${QUALIFICATION_ADMIN_PASSWORD:?QUALIFICATION_ADMIN_PASSWORD is required}" \
ENCRYPTION_KEY="$qualification_encryption_key" \
  pnpm --filter slide-api exec node ../../scripts/qualification/bootstrap-admin.mjs

if [[ -n "${QUALIFICATION_DEEPSEEK_API_KEY:-}" ]]; then
  DB_NAME=db_ops_ai_qualification ENCRYPTION_KEY="$qualification_encryption_key" \
    pnpm --filter slide-api exec tsx ../../scripts/qualification/configure-deepseek.ts
fi

llm_pid=""
if [[ "${QUALIFICATION_CANCELLATION_E2E:-0}" == "1" ]]; then
  node scripts/qualification/cancellable-openai-server.mjs &
  llm_pid=$!
  DB_NAME=db_ops_ai_qualification ENCRYPTION_KEY="$qualification_encryption_key" \
    pnpm --filter slide-api exec tsx ../../scripts/qualification/configure-cancellable-provider.ts
fi

api_pid=""
vite_pid=""
cleanup() {
  test -n "$vite_pid" && kill "$vite_pid" 2>/dev/null || true
  test -n "$api_pid" && kill "$api_pid" 2>/dev/null || true
  test -n "$llm_pid" && kill "$llm_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PORT="$api_port" AGENT_WS_PORT="$ws_port" DB_NAME=db_ops_ai_qualification \
JWT_SECRET_KEY="$qualification_jwt_secret" \
ENCRYPTION_KEY="$qualification_encryption_key" \
  bash -c 'cd apps/db-ops-api && exec node --import tsx server.ts' &
api_pid=$!

for _ in $(seq 1 45); do
  if curl --fail --silent --max-time 1 "http://127.0.0.1:$api_port/api/health/ready" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --max-time 3 "http://127.0.0.1:$api_port/api/health/ready" >/dev/null

VITE_API_PROXY_TARGET="http://127.0.0.1:$api_port" \
VITE_AGENT_WS_PROXY_TARGET="http://127.0.0.1:$ws_port" \
VITE_AGENT_WS_URL="ws://127.0.0.1:$ws_port" \
  node frontend/node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$frontend_port" --strictPort frontend &
vite_pid=$!
wait "$vite_pid"
