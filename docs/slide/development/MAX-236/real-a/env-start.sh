#!/usr/bin/env bash
# MAX-236 / P0-REAL-A isolated acceptance environment (task-owned, disposable).
#
# Creates a dedicated MySQL 8.4 container + named volume + dedicated network,
# all labelled max236.owner=15coder1-reala / max236.phase=P0-REAL-A, publishes an
# ephemeral 127.0.0.1 port, and records the EXACT object IDs in a runtime handle
# file. Every later action (start, drop, seed) re-verifies that exact handle
# first; a same-named container/volume/network without the recorded ID or labels
# is refused rather than reused.
#
# It never touches the platform compose stack, the platform database, shared
# volumes or any resource it did not create. Run from the repository root:
#
#   bash docs/slide/development/MAX-236/real-a/env-start.sh
#
# Requires: docker with the local mysql:8.4 image, and pnpm install at the root
# (the migration runner is executed with npx tsx from apps/db-ops-api).
set -euo pipefail

OWNER="15coder1-reala"
PHASE="P0-REAL-A"
NAME="max236-reala-15coder1"
VOL="max236-reala-15coder1-data"
NET="max236-reala-15coder1-net"
DB="max236_reala"
IMAGE="mysql:8.4"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
SQL_DIR="$ROOT/docs/slide/development/MAX-236/real-a/sql"
SEED="$ROOT/docs/slide/development/MAX-236/real-a/bootstrap-library.sql"
STATE_DIR="${MAX236_REALA_STATE_DIR:-$ROOT/.max236-reala}"
HANDLE="$STATE_DIR/handle.json"
MWRITE_RESOURCES='["instance:9101","server:9201"]'

die() { echo "REFUSED: $*" >&2; exit 1; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  die "missing local image $IMAGE; pull it explicitly before running this script"
fi

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

# Fresh verification of the exact creation record. Never matches by name.
assert_owned() {
  local allow_stopped="${1:-no}"
  [ -f "$HANDLE" ] || die "creation record $HANDLE is missing; refusing to touch same-named objects"
  local CID IMG PORT OWNER_R PHASE_R VOL_R NET_R NETID_R RUNNING
  CID="$(handle_field container_id)"
  IMG="$(handle_field image)"
  PORT="$(handle_field port)"
  OWNER_R="$(handle_field owner)"
  PHASE_R="$(handle_field phase)"
  VOL_R="$(handle_field volume)"
  NET_R="$(handle_field network)"
  NETID_R="$(handle_field network_id)"
  [ "$OWNER_R" = "$OWNER" ] || die "handle owner mismatch"
  [ "$PHASE_R" = "$PHASE" ] || die "handle phase mismatch"

  local real_id real_image real_owner real_phase real_mounts real_networks
  real_id="$(docker inspect --type container --format '{{.Id}}' "$CID" 2>/dev/null)" || die "recorded container $CID is gone"
  [ "$real_id" = "$CID" ] || die "container ID changed"
  real_image="$(docker inspect --type container --format '{{.Image}}' "$CID")"
  [ "$real_image" = "$IMG" ] || die "container image mismatch: $real_image != $IMG"
  real_owner="$(docker inspect --type container --format '{{index .Config.Labels "max236.owner"}}' "$CID")"
  real_phase="$(docker inspect --type container --format '{{index .Config.Labels "max236.phase"}}' "$CID")"
  [ "$real_owner" = "$OWNER" ] || die "container owner label mismatch"
  [ "$real_phase" = "$PHASE" ] || die "container phase label mismatch"
  real_mounts="$(docker inspect --type container --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}};{{end}}' "$CID")"
  [ "$real_mounts" = "volume|$VOL_R|/var/lib/mysql;" ] || die "container mount mismatch: $real_mounts"
  real_networks="$(docker inspect --type container --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}};{{end}}' "$CID")"
  [ "$real_networks" = "$NET_R;" ] || die "container network mismatch: $real_networks"
  [ "$(docker network inspect --format '{{.Id}}' "$NETID_R" 2>/dev/null)" = "$NETID_R" ] || die "recorded network is gone"
  [ "$(docker network inspect --format '{{index .Labels "max236.owner"}}' "$NETID_R")" = "$OWNER" ] || die "network owner label mismatch"
  [ "$(docker network inspect --format '{{index .Labels "max236.phase"}}' "$NETID_R")" = "$PHASE" ] || die "network phase label mismatch"
  [ "$(docker volume inspect --format '{{.Name}}' "$VOL_R" 2>/dev/null)" = "$VOL_R" ] || die "recorded volume is gone"
  [ "$(docker volume inspect --format '{{index .Labels "max236.owner"}}' "$VOL_R")" = "$OWNER" ] || die "volume owner label mismatch"
  [ "$(docker volume inspect --format '{{index .Labels "max236.phase"}}' "$VOL_R")" = "$PHASE" ] || die "volume phase label mismatch"
  [ "$(docker port "$CID" 3306/tcp)" = "127.0.0.1:$PORT" ] || die "published port mismatch"
  RUNNING="$(docker inspect --type container --format '{{.State.Running}}' "$CID")"
  if [ "$allow_stopped" != "yes" ] && [ "$RUNNING" != "true" ]; then die "container is not running"; fi
}

if [ -f "$HANDLE" ]; then
  assert_owned yes
  CID="$(handle_field container_id)"
  echo "container already recorded; starting verified ID $CID"
  docker start "$CID" >/dev/null
else
  for name in "$NAME" "$VOL" "$NET"; do
    if docker container inspect "$name" >/dev/null 2>&1 || docker volume inspect "$name" >/dev/null 2>&1 || docker network inspect "$name" >/dev/null 2>&1; then
      die "object named $name exists without a creation record; refusing to reuse or remove it"
    fi
  done

  docker network create \
    --label "max236.owner=$OWNER" --label "max236.phase=$PHASE" "$NET" >/dev/null
  docker volume create \
    --label "max236.owner=$OWNER" --label "max236.phase=$PHASE" "$VOL" >/dev/null
  PORT_SPEC="127.0.0.1::3306"
  if [ -n "${MAX236_REALA_PORT:-}" ]; then PORT_SPEC="127.0.0.1:${MAX236_REALA_PORT}:3306"; fi
  CID="$(docker run -d --name "$NAME" \
    --label "max236.owner=$OWNER" --label "max236.phase=$PHASE" \
    --network "$NET" \
    -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e "MYSQL_DATABASE=$DB" \
    -p "$PORT_SPEC" -v "$VOL":/var/lib/mysql "$IMAGE")"
  PORT="$(docker port "$CID" 3306/tcp | sed 's/^127\.0\.0\.1://')"
  [ -n "$PORT" ] || die "no published loopback port"
  IMG="$(docker inspect --type container --format '{{.Image}}' "$CID")"
  NETID="$(docker network inspect --format '{{.Id}}' "$NET")"
  mkdir -p "$STATE_DIR"
  python3 -I - "$HANDLE" "$OWNER" "$PHASE" "$CID" "$NAME" "$IMG" "$NET" "$NETID" "$VOL" "$PORT" "$DB" "$MWRITE_RESOURCES" <<'PY'
import json, sys
path, owner, phase, cid, name, image, net, netid, vol, port, db, resources = sys.argv[1:13]
json.dump({
    'owner': owner, 'phase': phase, 'container_id': cid, 'container_name': name,
    'image': image, 'network': net, 'network_id': netid, 'volume': vol,
    'volume_destination': '/var/lib/mysql',
    'volume_labels': {'max236.owner': owner, 'max236.phase': phase},
    'port': int(port), 'database': db, 'user': 'root', 'password': 'empty',
    'resources': json.loads(resources), 'created_at': __import__('datetime').datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
}, open(path, 'w'), indent=2, sort_keys=True)
open(path, 'a').write('\n')
PY
  chmod 600 "$HANDLE"
fi

assert_owned
# Wait for the FINAL server on TCP 3306, not the entrypoint's temporary
# socket-only init server: a socket ping can succeed while TCP is still closed.
for _ in $(seq 1 120); do
  docker exec "$CID" mysqladmin ping -h 127.0.0.1 -P 3306 -uroot --silent >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CID" mysqladmin ping -h 127.0.0.1 -P 3306 -uroot --silent >/dev/null 2>&1 || die "MySQL did not become ready"

# Fresh re-verification immediately before the destructive DROP/seed.
assert_owned

PORT="$(handle_field port)"
docker exec "$CID" mysql -uroot -e "DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

(
  cd "$ROOT/apps/db-ops-api"
  DB_HOST=127.0.0.1 DB_PORT="$PORT" DB_USER=root DB_PASSWORD= DB_NAME="$DB" npx tsx init-db.ts >/dev/null
)

for file in "$SQL_DIR"/14[0-2]_*.sql; do
  docker exec -i "$CID" mysql -uroot "$DB" < "$file"
done

assert_owned
docker exec -i "$CID" mysql -uroot "$DB" < "$SEED"

hostname12="$(docker exec "$CID" mysql -uroot -N -e 'SELECT @@hostname')"
hostname12="${hostname12:0:12}"
echo "ready: database=$DB hostname12=$hostname12 port=$PORT container=$NAME"
echo "handle: $HANDLE (exact IDs; do not commit)"
echo "confirmation string for a write: ${DB}@${hostname12}:<resource>"
