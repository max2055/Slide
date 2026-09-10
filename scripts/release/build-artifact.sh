#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

commit="$(git rev-parse HEAD)"
version="${RELEASE_VERSION:-0.9.0-${commit:0:12}}"
output_dir="${RELEASE_OUTPUT_DIR:-$root/.artifacts}"
artifact="slide-${version}.tar.gz"
staging="$(mktemp -d "${TMPDIR:-/tmp}/slide-release.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

VITE_SLIDE_BUILD_ID="$commit" pnpm --filter slide-frontend build
mkdir -p "$staging/slide/frontend"
git archive HEAD | tar -xf - -C "$staging/slide"
cp -R frontend/dist "$staging/slide/frontend/dist"
pnpm --filter slide-api exec tsx ../../scripts/release/write-release-manifest.ts "$staging/slide/RELEASE.json" "$version" "$commit"

mkdir -p "$output_dir"
COPYFILE_DISABLE=1 tar -czf "$output_dir/$artifact" -C "$staging" slide
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$artifact" > "$artifact.sha256")
else
  (cd "$output_dir" && shasum -a 256 "$artifact" > "$artifact.sha256")
fi
printf '%s\n' "$output_dir/$artifact"
