#!/usr/bin/env bash
# MAX-236 / P0-REAL-A cleanup. Removes ONLY the exact container, network and
# volume recorded by `env-start.sh`.
#
# Every object is verified FRESH before ANY mutation: the container (exact ID,
# owner/phase labels, image, mount, network, published port), the network (exact
# ID, owner/phase labels) and the volume (exact name, owner/phase labels). Only
# after all present objects pass is the container stopped/removed and then the
# network and volume removed. A mismatch, a missing handle, a same-named
# object without the recorded ID, or ANY non-zero `inspect` refuses with ZERO
# stop/remove calls and keeps the creation record.
#
# A non-zero `inspect` is never read as "already absent": it may equally be a
# daemon, permission or transient failure. This revision deliberately has no
# absent-object shortcut; after a partial cleanup an operator must inspect the
# recorded objects and decide, rather than letting the script guess.
#
# It never prunes, never matches by port or process name and never removes
# another container, volume, network or image.
#
#   bash docs/slide/development/MAX-236/real-a/env-clean.sh
set -euo pipefail

OWNER="15coder1-reala"
PHASE="P0-REAL-A"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
STATE_DIR="${MAX236_REALA_STATE_DIR:-$ROOT/.max236-reala}"
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
IMG="$(handle_field image)"
VOL="$(handle_field volume)"
NET="$(handle_field network)"
NETID="$(handle_field network_id)"
PORT="$(handle_field port)"
[ "$(handle_field owner)" = "$OWNER" ] || die "handle owner mismatch"
[ "$(handle_field phase)" = "$PHASE" ] || die "handle phase mismatch"

# ---------------------------------------------------------------- verify ALL
# Only reads happen in this block; no stop/remove is reachable before it passes.
# `probe` returns only when the object is freshly proven to exist. Any non-zero
# inspect (daemon down, permission denied, transient error, wrong ID) refuses
# here, before the first mutation, and leaves the handle in place.
probe() {
  local kind="$1" ref="$2"
  docker "$kind" inspect "$ref" >/dev/null 2>&1 \
    || die "$kind inspect failed for $ref; cannot prove it exists (a non-zero inspect is NOT absence); kept handle, no action"
}

probe container "$CID"
[ "$(docker inspect --type container --format '{{.Id}}' "$CID")" = "$CID" ] || die "container ID changed"
[ "$(docker inspect --type container --format '{{.Image}}' "$CID")" = "$IMG" ] || die "container image mismatch"
[ "$(docker inspect --type container --format '{{index .Config.Labels "max236.owner"}}' "$CID")" = "$OWNER" ] || die "container owner label mismatch"
[ "$(docker inspect --type container --format '{{index .Config.Labels "max236.phase"}}' "$CID")" = "$PHASE" ] || die "container phase label mismatch"
[ "$(docker inspect --type container --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}};{{end}}' "$CID")" = "volume|$VOL|/var/lib/mysql;" ] || die "container mount mismatch"
[ "$(docker inspect --type container --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}};{{end}}' "$CID")" = "$NET;" ] || die "container network mismatch"
[ "$(docker port "$CID" 3306/tcp)" = "127.0.0.1:$PORT" ] || die "published port mismatch"

probe network "$NETID"
[ "$(docker network inspect --format '{{.Id}}' "$NETID")" = "$NETID" ] || die "network ID changed"
[ "$(docker network inspect --format '{{index .Labels "max236.owner"}}' "$NETID")" = "$OWNER" ] || die "network owner label mismatch"
[ "$(docker network inspect --format '{{index .Labels "max236.phase"}}' "$NETID")" = "$PHASE" ] || die "network phase label mismatch"

probe volume "$VOL"
[ "$(docker volume inspect --format '{{.Name}}' "$VOL")" = "$VOL" ] || die "volume name mismatch"
[ "$(docker volume inspect --format '{{index .Labels "max236.owner"}}' "$VOL")" = "$OWNER" ] || die "volume owner label mismatch"
[ "$(docker volume inspect --format '{{index .Labels "max236.phase"}}' "$VOL")" = "$PHASE" ] || die "volume phase label mismatch"

# ---------------------------------------------------------------- mutate
echo "stopping recorded container $CID"
docker stop --time 30 "$CID" >/dev/null || die "graceful stop failed"
docker rm -v "$CID" >/dev/null || die "container removal failed"

docker network rm "$NETID" >/dev/null || die "network removal failed"

docker volume rm "$VOL" >/dev/null || die "volume removal failed"

fail=0
containers="$(docker ps -a --filter "id=$CID" --format '{{.Names}}')"
[ -z "$containers" ] || { echo "container still present: $containers" >&2; fail=1; }
networks="$(docker network ls --filter "label=max236.owner=$OWNER" --format '{{.Name}}')"
[ -z "$networks" ] || { echo "network still present: $networks" >&2; fail=1; }
volumes="$(docker volume ls --filter "label=max236.owner=$OWNER" --format '{{.Name}}')"
[ -z "$volumes" ] || { echo "volume still present: $volumes" >&2; fail=1; }
[ "$fail" -eq 0 ] || die "post-cleanup check found owned objects"

rm -f "$HANDLE"
echo "clean: recorded container/network/volume removed; handle deleted"
