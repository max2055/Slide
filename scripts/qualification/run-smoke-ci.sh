#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root/apps/db-ops-api"
tsx tests/smoke-test.ts 2>&1 | tee smoke-report.txt
