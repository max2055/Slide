#!/usr/bin/env bash
# MAX-237 / T2B cleanup. Removes ONLY the exact container and volume recorded by
# `env-start.sh`; it never prunes, never matches by name or port, and creates or
# deletes nothing else.
#
# Every object is verified FRESH before any mutation: container (exact ID,
# owner/phase labels, image ID, mount, loopback port) and volume (exact name,
# owner/phase labels). Any mismatch, a missing handle, a same-named object
# without the recorded ID, or ANY non-zero inspect refuses with zero
# stop/remove calls and keeps the creation record. A non-zero inspect is never
# read as "already absent".
#
#   bash docs/slide/development/MAX-237/t2b/env-clean.sh
set -euo pipefail

OWNER="15coder1-t2b"
PHASE="T2B-20261027"
DB_D1="max237_t2b_d1"
DB_MAIN="max237_t2b"
DB_RESTORE="max237_t2b_restore"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
STATE_DIR="${MAX237_T2B_STATE_DIR:-$ROOT/.max237-t2b}"
HANDLE="$STATE_DIR/handle.json"

die() { echo "REFUSED: $*" >&2; exit 1; }

handle_field() { python3 -I - "$HANDLE" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
value = data[sys.argv[2]]
if isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(',', ':')))
else:
    print(value)
PY
}

[ -f "$HANDLE" ] || die "creation record $HANDLE is missing; refusing to delete anything by name"

CID="$(handle_field container_id)"
IMG="$(handle_field image_id)"
VOL="$(handle_field volume)"
PORT="$(handle_field port)"
[ "$(handle_field owner)" = "$OWNER" ] || die "handle owner mismatch"
[ "$(handle_field phase)" = "$PHASE" ] || die "handle phase mismatch"
[ "$(handle_field schemas)" = "[\"$DB_D1\",\"$DB_MAIN\",\"$DB_RESTORE\"]" ] || die "handle schema allowlist mismatch"

probe() {
  local kind="$1" ref="$2"
  docker "$kind" inspect "$ref" >/dev/null 2>&1 \
    || die "$kind inspect failed for $ref; a non-zero inspect is not absence; kept handle, no action"
}

probe container "$CID"
[ "$(docker inspect --type container --format '{{.Id}}' "$CID")" = "$CID" ] || die "container ID changed"
[ "$(docker inspect --type container --format '{{.Image}}' "$CID")" = "$IMG" ] || die "container image mismatch"
[ "$(docker inspect --type container --format '{{index .Config.Labels "max237.owner"}}' "$CID")" = "$OWNER" ] || die "container owner label mismatch"
[ "$(docker inspect --type container --format '{{index .Config.Labels "max237.phase"}}' "$CID")" = "$PHASE" ] || die "container phase label mismatch"
[ "$(docker inspect --type container --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}};{{end}}' "$CID")" = "volume|$VOL|/var/lib/mysql;" ] || die "container mount mismatch"
[ "$(docker port "$CID" 3306/tcp)" = "127.0.0.1:$PORT" ] || die "published port mismatch"

probe volume "$VOL"
[ "$(docker volume inspect --format '{{.Name}}' "$VOL")" = "$VOL" ] || die "volume name mismatch"
[ "$(docker volume inspect --format '{{index .Labels "max237.owner"}}' "$VOL")" = "$OWNER" ] || die "volume owner label mismatch"
[ "$(docker volume inspect --format '{{index .Labels "max237.phase"}}' "$VOL")" = "$PHASE" ] || die "volume phase label mismatch"

echo "stopping recorded container $CID"
docker stop --time 30 "$CID" >/dev/null || die "graceful stop failed"
docker rm -v "$CID" >/dev/null || die "container removal failed"
docker volume rm "$VOL" >/dev/null || die "volume removal failed"

fail=0
containers="$(docker ps -a --filter "id=$CID" --format '{{.Names}}')"
[ -z "$containers" ] || { echo "container still present: $containers" >&2; fail=1; }
volumes="$(docker volume ls --filter "label=max237.owner=$OWNER" --format '{{.Name}}')"
[ -z "$volumes" ] || { echo "volume still present: $volumes" >&2; fail=1; }
[ "$fail" -eq 0 ] || die "post-cleanup check found owned objects"

rm -f "$HANDLE" "$STATE_DIR/credentials.env" "$STATE_DIR/facts.json"
rmdir "$STATE_DIR" 2>/dev/null || true
echo "clean: recorded container/volume removed; handle and throwaway credentials deleted"
