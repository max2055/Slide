#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "sandbox qualification requires a Linux host or the Linux sandbox-controller container" >&2
  exit 1
fi

if [[ -n "${SANDBOX_CONTROLLER_URL:-}" ]]; then
  pnpm --filter slide-api exec tsx ../../tests/qualification/sandbox-security.ts
  exit 0
fi

compose_args=(-f compose.production.yaml)
if [[ -n "${SLIDE_ENV_FILE:-}" ]]; then
  compose_args=(--env-file "$SLIDE_ENV_FILE" "${compose_args[@]}")
fi

docker compose "${compose_args[@]}" exec -T sandbox-controller \
  ./node_modules/.bin/tsx /workspace/tests/qualification/sandbox-security.ts
