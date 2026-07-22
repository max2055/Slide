#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-}"
if [[ -z "$artifact" || ! -f "$artifact" || ! -f "$artifact.sha256" ]]; then
  echo "usage: $0 /path/to/slide-version.tar.gz" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$artifact")" && sha256sum -c "$(basename "$artifact").sha256")
else
  (cd "$(dirname "$artifact")" && shasum -a 256 -c "$(basename "$artifact").sha256")
fi

drill="$(mktemp -d "${TMPDIR:-/tmp}/slide-rollback.XXXXXX")"
trap 'rm -rf "$drill"' EXIT
mkdir -p "$drill/releases/previous" "$drill/releases/current"
tar -xzf "$artifact" -C "$drill/releases/previous" --strip-components=1
tar -xzf "$artifact" -C "$drill/releases/current" --strip-components=1

ln -s "$drill/releases/previous" "$drill/live"
ln -sfn "$drill/releases/current" "$drill/live"
test -f "$drill/live/RELEASE.json"
test -f "$drill/live/frontend/dist/index.html"
ln -sfn "$drill/releases/previous" "$drill/live"
test "$(readlink "$drill/live")" = "$drill/releases/previous"
test -f "$drill/live/frontend/dist/index.html"
echo "rollback drill passed: current -> previous"
