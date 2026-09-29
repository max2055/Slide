#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
mode=deterministic
duration=1800
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) mode="${2:?mode required}"; shift 2 ;;
    --duration-seconds) duration="${2:?duration required}"; shift 2 ;;
    *) echo 'Unknown argument' >&2; exit 64 ;;
  esac
done
case "$mode" in deterministic|mysql|soak|provider) ;; *) exit 64 ;; esac
mkdir -p .qualification/runtime
log=".qualification/runtime/${mode}-$(date +%s)-$$.log"
export QUALIFICATION_RUNTIME_LOG="$log"
printf 'mode=%s pid=%s cwd=%s sha=%s command=run-agent-runtime port=none log=%s\n' "$mode" "$$" "$root" "$(git rev-parse HEAD)" "$log" | tee "$log"
pnpm --filter slide-api exec tsx ../../tests/qualification/agent-runtime.ts "$mode" "$duration" 2>&1 | tee -a "$log"

if [[ "$mode" == mysql ]]; then
  APPROVAL_TEST_MYSQL_HOST="${DB_HOST:-127.0.0.1}" APPROVAL_TEST_MYSQL_PORT="${DB_PORT:-3306}" \
  APPROVAL_TEST_MYSQL_USER="${DB_USER:-root}" APPROVAL_TEST_MYSQL_PASSWORD="${DB_PASSWORD:-}" \
    pnpm --filter slide-api exec vitest run src/security/agent-tool-approval-execution.mysql.test.ts 2>&1 | tee -a "$log"
fi
