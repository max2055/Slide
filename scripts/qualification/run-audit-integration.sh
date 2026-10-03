#!/usr/bin/env bash
# W14 foreground-only final candidate gate. Every service qualifier owns and
# removes its disposable containers. No release packages or paid models.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
directory=".qualification/w14-$(date +%s)-$$"
mkdir -p "$directory"
git rev-parse HEAD > "$directory/head.txt"
git diff --binary > "$directory/candidate.patch"
node --version > "$directory/environment.txt"
pnpm --version >> "$directory/environment.txt"
docker version --format '{{.Server.Version}}' >> "$directory/environment.txt"
failures=0
check() {
  local name="$1"
  shift
  local started=$SECONDS result=0
  "$@" > "$directory/$name.log" 2>&1 || result=$?
  printf '%s\t%s\t%s\n' "$name" "$result" "$((SECONDS - started))" >> "$directory/results.tsv"
  echo "$name exit=$result seconds=$((SECONDS - started)) log=$directory/$name.log"
  if [[ "$result" != 0 ]]; then failures=$((failures + 1)); tail -35 "$directory/$name.log"; fi
}
check lint pnpm lint
check typecheck pnpm -r typecheck
check contracts pnpm contracts:check
check unit pnpm -r test
check frontend-build pnpm --filter slide-frontend build
check matrix pnpm qualification:matrix
check security-audit pnpm security:audit
check security-scan pnpm security:scan
check browser pnpm --filter slide-frontend test:browser
check runtime-deterministic bash scripts/qualification/run-agent-runtime.sh --mode deterministic
check bootstrap-upgrade bash scripts/qualification/run-environment.sh bootstrap-upgrade
check failover bash scripts/qualification/run-environment.sh failover
check startup pnpm --filter slide-api exec tsx ../../tests/qualification/startup-readiness.test.ts
check reports bash scripts/qualification/run-report-recovery.sh
check analysis bash scripts/qualification/run-analysis-recovery.sh
check retention bash scripts/qualification/run-metric-retention.sh
check events bash scripts/qualification/run-alert-event-transitions.sh
check removal bash scripts/qualification/run-instance-removal.sh
check backup-restore bash scripts/qualification/run-environment.sh backup-restore
check stability bash scripts/qualification/run-environment.sh stability
check pg bash scripts/qualification/run-pg-collection.sh
check cron-runtime-browser bash scripts/qualification/run-audit-browser.sh
echo "W14 integration finished: failures=$failures evidence=$directory"
[[ "$failures" == 0 ]]
