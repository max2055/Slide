#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${MAX180_ISOLATED_MYSQL:?Use run-MAX-180.sh}"
api_pid='' vite_pid=''
cleanup() {
  test -z "$vite_pid" || kill "$vite_pid" 2>/dev/null || true
  test -z "$api_pid" || kill "$api_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
pnpm --filter slide-api exec tsx ../../scripts/qualification/MAX-180-service.ts &
api_pid=$!
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 1 http://127.0.0.1:51948/api/health/ready >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --max-time 1 http://127.0.0.1:51948/api/health/ready >/dev/null
VITE_API_PROXY_TARGET=http://127.0.0.1:51948 node frontend/node_modules/vite/bin/vite.js --host 127.0.0.1 --port 51947 --strictPort frontend &
vite_pid=$!
wait "$vite_pid"
