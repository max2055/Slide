#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
# Documentation and local tooling do not affect the runtime build. Every input
# used by the frontend build, runtime archive and manifest must match HEAD.
dirty="$(git status --porcelain --untracked-files=all -- apps frontend packages scripts deploy \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json compose.production.yaml \
  .nvmrc .env.example .dockerignore)"
if [[ -n "$dirty" ]]; then
  printf '%s\n' 'RELEASE_SOURCE_DIRTY: commit the build inputs or build from a clean checkout.' "$dirty" >&2
  exit 1
fi
