#!/usr/bin/env bash
# MAX238-APPLY-IDEMPOTENCY-R4 controlled regression for max238-real-api.sh.
#
# Each case replaces `docker` (and, for the handle-file teardown, `curl`) with a
# script that only reads and writes files under a temp directory. No real Docker
# daemon, container or API is touched. The point is the cleanup contract:
# success only when the daemon proves the exact handle is gone; unknown,
# wrong-owner and failed deletes are non-zero and keep the handle.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
harness="$here/max238-real-api.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/max238-cleanup.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fakebin="$work/bin"; state="$work/state"
mkdir -p "$fakebin" "$state/containers"

cat > "$fakebin/docker" <<'FAKE'
#!/usr/bin/env bash
set -uo pipefail
state="${FAKE_DOCKER_STATE:?}"
die() { echo "$*" >&2; exit 1; }
find_container() {
  local ref="$1" f
  for f in "$state/containers"/*; do
    [ -e "$f" ] || continue
    if [ "$(basename "$f")" = "$ref" ] || [ "$(sed -n '1p' "$f")" = "$ref" ]; then printf '%s' "$f"; return 0; fi
  done
  return 1
}
case "${1:-}" in
  info)
    [ -f "$state/info_fail" ] && die "Cannot connect to the Docker daemon at unix:///fake.sock."
    [ "${FAIL_INFO_AFTER_RM:-0}" = 1 ] && [ -f "$state/rm_done" ] && die "Cannot connect to the Docker daemon at unix:///fake.sock."
    exit 0 ;;
  inspect)
    shift; fmt="" ref=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --type) shift 2 ;;
        --format) fmt="$2"; shift 2 ;;
        *) ref="$1"; shift ;;
      esac
    done
    [ -f "$state/inspect_fail" ] && die "Error response from daemon: query failed"
    f="$(find_container "$ref")" || die "Error: No such object: $ref"
    case "$fmt" in
      *'.Id'*) printf '%s %s\n' "$(sed -n '1p' "$f")" "$(sed -n '2p' "$f")" ;;
      *Labels*) printf '%s\n' "$(sed -n '2p' "$f")" ;;
      *) : ;;
    esac
    exit 0 ;;
  container)
    [ "${2:-}" = ls ] || die "fake docker: unsupported: docker $*"
    [ -f "$state/list_fail" ] && die "Error response from daemon: listing failed"
    for f in "$state/containers"/*; do
      [ -e "$f" ] || continue
      printf '%s owner=%s\n' "$(basename "$f")" "$(sed -n '2p' "$f")"
    done
    exit 0 ;;
  rm)
    shift; [ "${1:-}" = -f ] && shift
    ref="${1:?container}"
    [ -f "$state/rm_fail" ] && die "Error response from daemon: removal failed"
    f="$(find_container "$ref")" || die "Error: No such container: $ref"
    rm -f "$f"; touch "$state/rm_done"
    exit 0 ;;
  *) die "fake docker: unsupported: docker $*" ;;
esac
FAKE
cat > "$fakebin/curl" <<'FAKE'
#!/usr/bin/env bash
[ -n "${FAKE_CURL_EXIT:-}" ] && exit "$FAKE_CURL_EXIT"
printf '%s' "${FAKE_CURL_BODY:-}"
FAKE
chmod +x "$fakebin/docker" "$fakebin/curl"

pass=0; failed=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; printf '     exit=%s stderr=%s\n' "$last_code" "$last_err"; }
invoke() { # docker args -> last_code/last_err
  PATH="$fakebin:$PATH" FAKE_DOCKER_STATE="$state" bash "$harness" "$@" >"$work/out" 2>"$work/err"
  last_code=$?; last_err="$(cat "$work/err")"
}
invoke_handle() {
  PATH="$fakebin:$PATH" FAKE_DOCKER_STATE="$state" FAKE_CURL_EXIT="${FAKE_CURL_EXIT:-}" FAKE_CURL_BODY="${FAKE_CURL_BODY:-}" \
    bash "$harness" --cleanup-handle "$1" --api-url http://127.0.0.1:51839 >"$work/out" 2>"$work/err"
  last_code=$?; last_err="$(cat "$work/err")"
}
reset() { rm -rf "$state"; mkdir -p "$state/containers"; last_code=0; last_err=""; }
add() { printf '%s\n%s\n' "$2" "$3" > "$state/containers/$1"; }
exists() { [ -f "$state/containers/$1" ]; }
write_handle() {
  cat > "$work/handle.json" <<JSON
{"version":1,"container":"$1","nonce":"$2","api_port":51839}
JSON
}
want_code() { [ "$last_code" = "$1" ] && ok "$2" || bad "$2"; }
want_err() { case "$last_err" in *"$1"*) ok "message: $1" ;; *) bad "missing message: $1" ;; esac; }
want_exists() { exists "$1" && ok "neighbour $1 survives" || bad "neighbour $1 was removed"; }
want_gone() { exists "$1" && bad "handle $1 still exists" || ok "handle $1 is gone"; }

reset; add max238-e2e-a aaaa1111 n1
invoke --cleanup max238-e2e-a n1
want_code 0 "owned handle is removed"
want_err "removed max238-e2e-a"
want_gone max238-e2e-a

invoke --cleanup max238-e2e-a n1
want_code 0 "second cleanup of a removed handle is a verified no-op"
want_err "verified absent"

reset; add max238-e2e-b bbbb2222 someone-else
invoke --cleanup max238-e2e-b n1
want_code 1 "wrong owner is refused"
want_err "refusing to remove"
want_exists max238-e2e-b

reset; add max238-e2e-c cccc3333 n1; touch "$state/info_fail"
invoke --cleanup max238-e2e-c n1
want_code 1 "unreachable daemon is unknown, not removed"
want_err "docker daemon unavailable"
want_exists max238-e2e-c

reset; add max238-e2e-d dddd4444 n1; touch "$state/rm_fail"
invoke --cleanup max238-e2e-d n1
want_code 1 "failed delete is reported"
want_err "FAILED to remove"
want_exists max238-e2e-d

reset; add max238-e2e-e eeee5555 n1
export FAIL_INFO_AFTER_RM=1
invoke --cleanup max238-e2e-e n1
unset FAIL_INFO_AFTER_RM
want_code 1 "unverifiable delete is not reported as removed"
want_err "FAILED to verify removal"

reset; add max238-e2e-par1 1111aaaa n1; add max238-e2e-par2 2222bbbb n2
invoke --cleanup max238-e2e-par1 n1
want_code 0 "parallel run's own handle is removed"
want_exists max238-e2e-par2

reset; add max238-e2e-f ffff6666 n3; write_handle max238-e2e-f n3
export FAKE_CURL_EXIT=7
invoke_handle "$work/handle.json"
unset FAKE_CURL_EXIT
want_code 0 "handle-file teardown works with the API unreachable"
want_err "API http://127.0.0.1:51839 is unreachable; using the run-start handle"
want_gone max238-e2e-f
[ -f "$work/handle.json" ] && bad "handle file kept after verified removal" || ok "handle file removed after verified removal"

reset; add max238-e2e-g aaaa7777 n4; write_handle max238-e2e-g n4
export FAKE_CURL_BODY='{"container":"max238-e2e-g","nonce":"n4"}'
invoke_handle "$work/handle.json"
unset FAKE_CURL_BODY
want_code 0 "handle-file teardown cross-checks a matching live API"
want_gone max238-e2e-g

reset; add max238-e2e-h bbbb8888 n5; write_handle max238-e2e-h n5
export FAKE_CURL_BODY='{"container":"max238-e2e-someone-else","nonce":"n9"}'
invoke_handle "$work/handle.json"
unset FAKE_CURL_BODY
want_code 1 "a live API that reports another handle is an anomaly"
want_err "ANOMALY"
want_gone max238-e2e-h

reset
invoke_handle "$work/no-such-handle.json"
want_code 1 "a missing handle file proves nothing"
want_err "handle file $work/no-such-handle.json is missing"

reset; printf 'not json' > "$work/bad-handle.json"
invoke_handle "$work/bad-handle.json"
want_code 1 "an unreadable handle file proves nothing"
want_err "is unreadable"

printf '\n%d passed, %d failed\n' "$pass" "$failed"
[ "$failed" = 0 ]
