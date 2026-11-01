#!/usr/bin/env bash
# MAX-237 / T2B — isolated, disposable MySQL fixture for the storage-compatibility
# candidate and its exclusive up/down drill. Creates ONE MySQL 8.4 container, its
# own named data volume and a one-time DML-only test user, then creates exactly
# three schemas inside it:
#
#   max237_t2b_d1       byte-identical original DDL 140 (migration source)
#   max237_t2b          T2B candidate DDL (migration target)
#   max237_t2b_restore  byte-identical original DDL 140 (down/rollback target)
#
# These are one fixture's source/candidate/restore copies, not three registries
# and not a business writer. Nothing outside this container is touched.
#
# Exact selectors are fixed by the T2B admission decision:
#   container `max237-t2b-15coder1-20261027`
#   labels    max237.owner=15coder1-t2b, max237.phase=T2B-20261027
#   volume    `max237-t2b-15coder1-20261027-data`
#
# It records the exact container ID, image ID, loopback port, mounts, volume and
# schema allowlist in a private handle, re-verifies that handle before every
# mutation, and refuses — without reusing or deleting — any same-named object
# that has no creation record. It never loads an application `.env`, never
# touches the platform compose stack/database, never mounts a host path or
# shared volume and creates no network object.
#
#   bash docs/slide/development/MAX-237/t2b/env-start.sh
#
# Requires: docker with the local mysql:8.4 image, and openssl.
set -euo pipefail

OWNER="15coder1-t2b"
PHASE="T2B-20261027"
NAME="max237-t2b-15coder1-20261027"
VOL="max237-t2b-15coder1-20261027-data"
DB_D1="max237_t2b_d1"
DB_MAIN="max237_t2b"
DB_RESTORE="max237_t2b_restore"
APP_USER="max237_t2b_app"
IMAGE="mysql:8.4"
EXPECTED_IMAGE_ID="sha256:c592c15aaf4a1961e15d82eb31ea5987dda862d1c4b1e93424438c0e91dc1f8d"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
DDL_D1="$ROOT/docs/slide/development/MAX-237/t2a/sql/140_metric_template_aggregate.sql"
DDL_CANDIDATE="$ROOT/docs/slide/development/MAX-237/t2b/sql/t2b_metric_template_aggregate.sql"
STATE_DIR="${MAX237_T2B_STATE_DIR:-$ROOT/.max237-t2b}"
HANDLE="$STATE_DIR/handle.json"
CREDENTIALS="$STATE_DIR/credentials.env"

die() { echo "REFUSED: $*" >&2; exit 1; }

[ -f "$DDL_D1" ] || die "missing $DDL_D1"
[ -f "$DDL_CANDIDATE" ] || die "missing $DDL_CANDIDATE"
command -v openssl >/dev/null 2>&1 || die "openssl is required to generate throwaway secrets"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "missing local image $IMAGE; pull it explicitly before running this script"
[ "$(docker image inspect --format '{{.Id}}' "$IMAGE")" = "$EXPECTED_IMAGE_ID" ] \
  || die "cached $IMAGE image ID is not the admitted $EXPECTED_IMAGE_ID"

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

mysql_root() {
  docker exec -e "MYSQL_PWD=$1" -i "$2" mysql -uroot "${@:3}"
}

# Fresh verification of the exact creation record. Never matches by name.
assert_owned() {
  local allow_stopped="${1:-no}"
  [ -f "$HANDLE" ] || die "creation record $HANDLE is missing; refusing to touch same-named objects"
  local CID IMG PORT OWNER_R PHASE_R VOL_R RUNNING
  CID="$(handle_field container_id)"
  IMG="$(handle_field image_id)"
  PORT="$(handle_field port)"
  OWNER_R="$(handle_field owner)"
  PHASE_R="$(handle_field phase)"
  VOL_R="$(handle_field volume)"
  [ "$OWNER_R" = "$OWNER" ] || die "handle owner mismatch"
  [ "$PHASE_R" = "$PHASE" ] || die "handle phase mismatch"
  [ "$(handle_field schemas)" = "[\"$DB_D1\",\"$DB_MAIN\",\"$DB_RESTORE\"]" ] || die "handle schema allowlist mismatch"
  [ "$(docker inspect --type container --format '{{.Id}}' "$CID" 2>/dev/null)" = "$CID" ] || die "recorded container $CID is gone or changed"
  [ "$(docker inspect --type container --format '{{.Image}}' "$CID")" = "$IMG" ] || die "container image mismatch"
  [ "$(docker inspect --type container --format '{{index .Config.Labels "max237.owner"}}' "$CID")" = "$OWNER" ] || die "container owner label mismatch"
  [ "$(docker inspect --type container --format '{{index .Config.Labels "max237.phase"}}' "$CID")" = "$PHASE" ] || die "container phase label mismatch"
  [ "$(docker inspect --type container --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}};{{end}}' "$CID")" = "volume|$VOL_R|/var/lib/mysql;" ] || die "container mount mismatch"
  [ "$(docker port "$CID" 3306/tcp)" = "127.0.0.1:$PORT" ] || die "published port mismatch"
  [ "$(docker volume inspect --format '{{.Name}}' "$VOL_R" 2>/dev/null)" = "$VOL_R" ] || die "recorded volume is gone"
  [ "$(docker volume inspect --format '{{index .Labels "max237.owner"}}' "$VOL_R")" = "$OWNER" ] || die "volume owner label mismatch"
  [ "$(docker volume inspect --format '{{index .Labels "max237.phase"}}' "$VOL_R")" = "$PHASE" ] || die "volume phase label mismatch"
  RUNNING="$(docker inspect --type container --format '{{.State.Running}}' "$CID")"
  if [ "$allow_stopped" != "yes" ] && [ "$RUNNING" != "true" ]; then die "container is not running"; fi
}

if [ -f "$HANDLE" ]; then
  assert_owned yes
  CID="$(handle_field container_id)"
  echo "container already recorded; starting verified ID $CID"
  docker start "$CID" >/dev/null
else
  if docker container inspect "$NAME" >/dev/null 2>&1 || docker volume inspect "$VOL" >/dev/null 2>&1; then
    die "object named $NAME/$VOL exists without a creation record; refusing to reuse or remove it"
  fi
  IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
  ROOT_PW="$(openssl rand -hex 24)"
  APP_PW="$(openssl rand -hex 24)"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  docker volume create --label "max237.owner=$OWNER" --label "max237.phase=$PHASE" "$VOL" >/dev/null
  CID="$(docker run -d --name "$NAME" \
    --label "max237.owner=$OWNER" --label "max237.phase=$PHASE" \
    -e "MYSQL_ROOT_PASSWORD=$ROOT_PW" \
    -p 127.0.0.1::3306 -v "$VOL":/var/lib/mysql "$IMAGE")"
  PORT="$(docker port "$CID" 3306/tcp | sed 's/^127\.0\.0\.1://')"
  [ -n "$PORT" ] || die "no published loopback port"
  [ "$(docker inspect --type container --format '{{.Image}}' "$CID")" = "$IMAGE_ID" ] || die "container image ID mismatch right after create"
  python3 -I - "$HANDLE" "$OWNER" "$PHASE" "$CID" "$NAME" "$IMAGE" "$IMAGE_ID" "$VOL" "$PORT" \
    "$DB_D1" "$DB_MAIN" "$DB_RESTORE" "$APP_USER" <<'PY'
import json, sys
(path, owner, phase, cid, name, image, image_id, vol, port,
 d1, main, restore, app_user) = sys.argv[1:14]
json.dump({
    'owner': owner, 'phase': phase, 'container_id': cid, 'container_name': name,
    'image': image, 'image_id': image_id, 'volume': vol, 'volume_destination': '/var/lib/mysql',
    'volume_labels': {'max237.owner': owner, 'max237.phase': phase},
    'port': int(port), 'schemas': [d1, main, restore], 'source_schema': d1,
    'candidate_schema': main, 'restore_schema': restore, 'app_user': app_user,
    'created_at': __import__('datetime').datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
}, open(path, 'w'), indent=2, sort_keys=True)
open(path, 'a').write('\n')
PY
  chmod 600 "$HANDLE"
  umask 077
  printf 'MYSQL_ROOT_PASSWORD=%s\nMAX237_T2B_MYSQL_PASSWORD=%s\nMAX237_T2B_MYSQL_PORT=%s\nMAX237_T2B_MYSQL_USER=%s\nMAX237_T2B_MYSQL_DATABASE=%s\nexport MYSQL_ROOT_PASSWORD MAX237_T2B_MYSQL_PASSWORD MAX237_T2B_MYSQL_PORT MAX237_T2B_MYSQL_USER MAX237_T2B_MYSQL_DATABASE\n' \
    "$ROOT_PW" "$APP_PW" "$PORT" "$APP_USER" "$DB_MAIN" > "$CREDENTIALS"
  chmod 600 "$CREDENTIALS"
  unset ROOT_PW APP_PW
fi

[ -f "$CREDENTIALS" ] || die "missing private credentials file $CREDENTIALS"
# shellcheck disable=SC1090
source "$CREDENTIALS"

assert_owned
# Wait for the FINAL server on TCP 3306, not the entrypoint's temporary
# socket-only init server.
for _ in $(seq 1 180); do
  mysql_root "$MYSQL_ROOT_PASSWORD" "$CID" -e 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
mysql_root "$MYSQL_ROOT_PASSWORD" "$CID" -e 'SELECT 1' >/dev/null 2>&1 || die "MySQL did not become ready"

assert_owned
PORT="$(handle_field port)"
mysql_root "$MYSQL_ROOT_PASSWORD" "$CID" -e \
  "DROP DATABASE IF EXISTS \`$DB_D1\`; CREATE DATABASE \`$DB_D1\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
   DROP DATABASE IF EXISTS \`$DB_MAIN\`; CREATE DATABASE \`$DB_MAIN\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
   DROP DATABASE IF EXISTS \`$DB_RESTORE\`; CREATE DATABASE \`$DB_RESTORE\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;"
docker exec -e "MYSQL_PWD=$MYSQL_ROOT_PASSWORD" -i "$CID" mysql -uroot "$DB_D1" < "$DDL_D1"
docker exec -e "MYSQL_PWD=$MYSQL_ROOT_PASSWORD" -i "$CID" mysql -uroot "$DB_MAIN" < "$DDL_CANDIDATE"
docker exec -e "MYSQL_PWD=$MYSQL_ROOT_PASSWORD" -i "$CID" mysql -uroot "$DB_RESTORE" < "$DDL_D1"

# One-time test user: DML on the three allowlisted schemas only, no DDL/DROP/GRANT.
GRANT_SQL="$STATE_DIR/grant.sql"
umask 077
printf "DROP USER IF EXISTS '%s'@'%%';\nCREATE USER '%s'@'%%' IDENTIFIED BY '%s';\nGRANT SELECT, INSERT, UPDATE, DELETE ON \`%s\`.* TO '%s'@'%%';\nGRANT SELECT, INSERT, UPDATE, DELETE ON \`%s\`.* TO '%s'@'%%';\nGRANT SELECT, INSERT, UPDATE, DELETE ON \`%s\`.* TO '%s'@'%%';\nFLUSH PRIVILEGES;\n" \
  "$APP_USER" "$APP_USER" "$MAX237_T2B_MYSQL_PASSWORD" "$DB_D1" "$APP_USER" "$DB_MAIN" "$APP_USER" "$DB_RESTORE" "$APP_USER" > "$GRANT_SQL"
chmod 600 "$GRANT_SQL"
mysql_root "$MYSQL_ROOT_PASSWORD" "$CID" < "$GRANT_SQL"
rm -f "$GRANT_SQL"

assert_owned

# Schema facts for the committed evidence (no secrets).
FACTS="$STATE_DIR/facts.json"
mysql_root "$MYSQL_ROOT_PASSWORD" "$CID" -N -e \
  "SELECT JSON_OBJECT(
     'version', @@version,
     'character_set_database', @@character_set_database,
     'collation_database', @@collation_database,
     'schemas', (SELECT JSON_ARRAYAGG(SCHEMA_NAME) FROM information_schema.SCHEMATA
                  WHERE SCHEMA_NAME IN ('$DB_D1', '$DB_MAIN', '$DB_RESTORE')),
     'tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT('schema', TABLE_SCHEMA, 'name', TABLE_NAME, 'collation', TABLE_COLLATION))
                  FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA IN ('$DB_D1', '$DB_MAIN', '$DB_RESTORE')),
     'hostname12', LEFT(@@hostname, 12)
   );" > "$FACTS"
chmod 600 "$FACTS"

echo "ready: schemas=$DB_D1,$DB_MAIN,$DB_RESTORE user=$APP_USER port=$PORT container=$NAME"
echo "handle: $HANDLE (exact IDs; do not commit)"
echo "test env: source $CREDENTIALS"
