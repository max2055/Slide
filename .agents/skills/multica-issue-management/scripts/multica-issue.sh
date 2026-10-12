#!/usr/bin/env bash
set -euo pipefail

find_multica() {
  if [[ -n "${MULTICA_BIN:-}" ]]; then
    printf '%s\n' "$MULTICA_BIN"
    return
  fi
  if command -v multica >/dev/null 2>&1; then
    command -v multica
    return
  fi
  local bundled='/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica'
  [[ -x "$bundled" ]] || { printf '%s\n' 'MULTICA_CLI_NOT_FOUND' >&2; exit 127; }
  printf '%s\n' "$bundled"
}

usage() {
  printf '%s\n' 'Usage:' \
    '  multica-issue.sh locate' \
    '  multica-issue.sh preflight --workspace-id ID' \
    '  multica-issue.sh projects --workspace-id ID' \
    '  multica-issue.sh search --workspace-id ID --query TEXT [--include-closed]' \
    '  multica-issue.sh get --workspace-id ID --issue-id ID' \
    '  multica-issue.sh runs --workspace-id ID --issue-id ID [--active]' \
    '  multica-issue.sh create --workspace-id ID --project-id ID --title TEXT --description-file PATH'
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage >&2; exit 2; }
shift

workspace_id=''
project_id=''
title=''
description_file=''
query=''
issue_id=''
include_closed=0
active_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-id) workspace_id="${2:-}"; shift 2 ;;
    --project-id) project_id="${2:-}"; shift 2 ;;
    --title) title="${2:-}"; shift 2 ;;
    --description-file) description_file="${2:-}"; shift 2 ;;
    --query) query="${2:-}"; shift 2 ;;
    --issue-id) issue_id="${2:-}"; shift 2 ;;
    --include-closed) include_closed=1; shift ;;
    --active) active_only=1; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

multica_bin="$(find_multica)"
if [[ "$command_name" == 'locate' ]]; then
  "$multica_bin" version
  exit
fi

[[ -n "$workspace_id" ]] || { printf '%s\n' 'WORKSPACE_ID_REQUIRED' >&2; exit 2; }
profile="${MULTICA_PROFILE:-desktop-api.multica.ai}"
base=("$multica_bin" --profile "$profile" --workspace-id "$workspace_id")

case "$command_name" in
  preflight)
    "${base[@]}" auth status
    "${base[@]}" project list --output json >/dev/null
    printf '%s\n' 'MULTICA_PREFLIGHT_OK'
    ;;
  projects)
    "${base[@]}" project list --output json
    ;;
  search)
    [[ -n "$query" ]] || { printf '%s\n' 'QUERY_REQUIRED' >&2; exit 2; }
    args=(issue search "$query" --output json)
    [[ "$include_closed" == 0 ]] || args+=(--include-closed)
    "${base[@]}" "${args[@]}"
    ;;
  get)
    [[ -n "$issue_id" ]] || { printf '%s\n' 'ISSUE_ID_REQUIRED' >&2; exit 2; }
    "${base[@]}" issue get "$issue_id" --resolve-properties --output json
    ;;
  runs)
    [[ -n "$issue_id" ]] || { printf '%s\n' 'ISSUE_ID_REQUIRED' >&2; exit 2; }
    args=(issue runs "$issue_id" --output json)
    [[ "$active_only" == 0 ]] || args+=(--active)
    "${base[@]}" "${args[@]}"
    ;;
  create)
    [[ -n "$project_id" ]] || { printf '%s\n' 'PROJECT_ID_REQUIRED' >&2; exit 2; }
    [[ -n "$title" ]] || { printf '%s\n' 'TITLE_REQUIRED' >&2; exit 2; }
    [[ -f "$description_file" ]] || { printf '%s\n' 'DESCRIPTION_FILE_REQUIRED' >&2; exit 2; }
    resolved_description="$(cd "$(dirname "$description_file")" && pwd)/$(basename "$description_file")"
    case "$resolved_description" in
      "$(pwd)"/*) ;;
      *) printf '%s\n' 'DESCRIPTION_FILE_MUST_BE_INSIDE_CWD' >&2; exit 2 ;;
    esac
    "${base[@]}" issue create --title "$title" --description-file "$description_file" \
      --project "$project_id" --status todo --output json
    ;;
  *) usage >&2; exit 2 ;;
esac
