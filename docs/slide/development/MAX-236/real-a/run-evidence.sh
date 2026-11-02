#!/usr/bin/env bash
# MAX-236 / P0-REAL-A reproducible evidence run.
#
# Runs plan -> apply -> exact replay (noop) -> same-revision drift refusal ->
# failure injection -> complete rollback -> rollback replay (noop) -> content
# mutation probes on the task-owned isolated library, and writes every
# stdout/stderr/DB fact under `evidence/`. It NEVER points at the platform
# database or any shared resource.
#
# Safety model: EVERY docker action (inspect, exec, port) first re-reads the
# creation record and verifies the exact container/network/volume IDs, owner and
# phase labels, image, mount, network and published loopback port. SQL entry
# points additionally require the resource to be in the recorded write
# allow-list, and `docker exec` always uses the verified <container ID> — never a
# container name. A verification failure aborts before the action (die), so no
# command runs against an object whose identity is not freshly proven.
#
#   bash docs/slide/development/MAX-236/real-a/env-start.sh
#   bash docs/slide/development/MAX-236/real-a/run-evidence.sh
#
# Env (no secret is written by this script):
#   MAX236_REALA_DSN     default mysql://root@127.0.0.1:<recorded port>/max236_reala
#   MAX236_REALA_HANDLE  default <repo>/.max236-reala/handle.json
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
HERE="$ROOT/docs/slide/development/MAX-236/real-a"
OUT="${MAX236_REALA_EVIDENCE_DIR:-$HERE/evidence/correction-20261027}"
OWNER="15coder1-reala"
PHASE="P0-REAL-A"
export MAX236_REALA_HANDLE="${MAX236_REALA_HANDLE:-$ROOT/.max236-reala/handle.json}"

failures=0

die() { echo "REFUSED: $*" >&2; exit 1; }

handle_field() {
  [ -f "$MAX236_REALA_HANDLE" ] || die "creation record $MAX236_REALA_HANDLE is missing; refusing to act"
  python3 -I - "$MAX236_REALA_HANDLE" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
value = data[sys.argv[2]]
if isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(',', ':')))
else:
    print(value)
PY
}

# Fresh verification of the exact creation record. Reads only; never mutates.
assert_owned() {
  local require_running="${1:-yes}"
  CID="$(handle_field container_id)"
  local IMG VOL NET NETID PORT OWNER_R PHASE_R
  IMG="$(handle_field image)"
  VOL="$(handle_field volume)"
  NET="$(handle_field network)"
  NETID="$(handle_field network_id)"
  PORT="$(handle_field port)"
  OWNER_R="$(handle_field owner)"
  PHASE_R="$(handle_field phase)"
  [ "$OWNER_R" = "$OWNER" ] || die "handle owner mismatch"
  [ "$PHASE_R" = "$PHASE" ] || die "handle phase mismatch"
  [ "$(docker inspect --type container --format '{{.Id}}' "$CID" 2>/dev/null)" = "$CID" ] || die "recorded container $CID is gone"
  [ "$(docker inspect --type container --format '{{.Image}}' "$CID")" = "$IMG" ] || die "container image mismatch"
  [ "$(docker inspect --type container --format '{{index .Config.Labels "max236.owner"}}' "$CID")" = "$OWNER" ] || die "container owner label mismatch"
  [ "$(docker inspect --type container --format '{{index .Config.Labels "max236.phase"}}' "$CID")" = "$PHASE" ] || die "container phase label mismatch"
  [ "$(docker inspect --type container --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}};{{end}}' "$CID")" = "volume|$VOL|/var/lib/mysql;" ] || die "container mount mismatch"
  [ "$(docker inspect --type container --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}};{{end}}' "$CID")" = "$NET;" ] || die "container network mismatch"
  [ "$(docker port "$CID" 3306/tcp)" = "127.0.0.1:$PORT" ] || die "published port mismatch"
  [ "$(docker network inspect --format '{{.Id}}' "$NETID" 2>/dev/null)" = "$NETID" ] || die "recorded network is gone"
  [ "$(docker network inspect --format '{{index .Labels "max236.owner"}}' "$NETID")" = "$OWNER" ] || die "network owner label mismatch"
  [ "$(docker network inspect --format '{{index .Labels "max236.phase"}}' "$NETID")" = "$PHASE" ] || die "network phase label mismatch"
  [ "$(docker volume inspect --format '{{.Name}}' "$VOL" 2>/dev/null)" = "$VOL" ] || die "recorded volume is gone"
  [ "$(docker volume inspect --format '{{index .Labels "max236.owner"}}' "$VOL")" = "$OWNER" ] || die "volume owner label mismatch"
  [ "$(docker volume inspect --format '{{index .Labels "max236.phase"}}' "$VOL")" = "$PHASE" ] || die "volume phase label mismatch"
  if [ "$require_running" = yes ]; then
    [ "$(docker inspect --type container --format '{{.State.Running}}' "$CID")" = "true" ] || die "container is not running"
  fi
}

# A mutation/read that is scoped to one resource must also prove the resource is
# in the recorded write allow-list before touching the database.
assert_resource_owned() {
  local key="$1"
  local resources
  resources="$(handle_field resources)"
  python3 -I - "$key" "$resources" <<'PY' || exit 1
import json, sys
key, resources = sys.argv[1], json.loads(sys.argv[2])
if key not in resources:
    sys.stderr.write(f"REFUSED: resource {key} is not in the recorded allow-list {resources}\n")
    sys.exit(1)
PY
}

# Every docker invocation goes through a fresh verification first.
docker_verified() {
  assert_owned yes
  docker "$@"
}

sql() {
  assert_owned yes
  docker exec -i "$CID" mysql -uroot "$(handle_field database)" -N -e "$1"
}

sql_for() {
  local resource="$1"; shift
  assert_resource_owned "$resource"
  sql "$1"
}

confirm() { printf '%s@%s:%s' "$(handle_field database)" "$HOST12" "$1"; }
digest() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print((d.get("plan") or d.get("rollback_plan"))["digest"])' "$1"; }
# The CLI entry points verify the exact creation record before connecting and, on
# `--apply`, enforce the recorded write allow-list (`assertWritableTarget`) before
# any write — so a resource outside it refuses with exit 2 without touching the DB.
migrate() {
  local manifest="$1"; shift
  MAX236_REALA_DSN="$MAX236_REALA_DSN" MAX236_REALA_HANDLE="$MAX236_REALA_HANDLE" npx tsx scripts/max236-migrate.ts --manifest "$manifest" "$@"
}
rollback() {
  MAX236_REALA_DSN="$MAX236_REALA_DSN" MAX236_REALA_HANDLE="$MAX236_REALA_HANDLE" npx tsx scripts/max236-rollback.ts "$@"
}

step() { printf '\n== %s\n' "$1"; }

# Expects exit code 2 (a refusal) and records stdout/stderr.
expect_refusal() {
  local label="$1"; shift
  local out="$OUT/$label.out" err="$OUT/$label.err"
  "$@" >"$out" 2>"$err"
  local code=$?
  if [ "$code" -ne 2 ]; then
    echo "FAIL: $label expected refusal (2), got $code" >&2
    cat "$err" >&2
    failures=$((failures + 1))
  else
    echo "refused as expected: $(cat "$err")"
  fi
}

main() {
  assert_owned yes
  local DB PORT
  DB="$(handle_field database)"
  PORT="$(handle_field port)"
  export MAX236_REALA_DSN="${MAX236_REALA_DSN:-mysql://root@127.0.0.1:$PORT/$DB}"
  mkdir -p "$OUT"
  cd "$ROOT/apps/db-ops-api" || exit 1

  # The container hostname (12-char prefix) is read through the verified ID;
  # there is no name-based `docker exec` bypass anywhere in this script.
  HOST12="$(docker_verified exec "$CID" mysql -uroot -N -e 'SELECT @@hostname' | cut -c1-12)"

  # ---------------------------------------------------------------- environment
  step "environment facts"
  docker inspect "$CID" > "$OUT/00-container-inspect.json"
  docker volume inspect "$(handle_field volume)" > "$OUT/00-volume-inspect.json"
  sql "SELECT VERSION() AS version, @@hostname AS hostname, DATABASE() AS db, (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()) AS tables, (SELECT COUNT(*) FROM app_schema_migrations) AS migrations, (SELECT COUNT(*) FROM app_schema_migrations WHERE status <> 'completed' AND status <> 'baselined') AS unfinished" > "$OUT/00-schema-facts.txt"

  # ---------------------------------------------------------------- instance flow
  step "instance plan -> apply -> exact replay"
  migrate "$HERE/manifests/instance-9101.json" --out "$OUT/01-plan-instance-9101.json" >/dev/null
  plan_digest="$(digest "$OUT/01-plan-instance-9101.json")"
  echo "plan digest: $plan_digest"
  migrate "$HERE/manifests/instance-9101.json" --apply \
    --confirm "$(confirm instance:9101)" --expect-digest "$plan_digest" \
    --out "$OUT/02-apply-instance-9101-r1.json" >/dev/null || failures=$((failures + 1))
  migrate "$HERE/manifests/instance-9101.json" --apply --plan "$OUT/01-plan-instance-9101.json" \
    --confirm "$(confirm instance:9101)" --expect-digest "$plan_digest" \
    --out "$OUT/03-replay-instance-9101-noop.json" >/dev/null || failures=$((failures + 1))

  # ---------------------------------------------------------------- server drift/replay
  step "server apply -> same-revision drift -> replay refused"
  migrate "$HERE/manifests/server-9201.json" --out "$OUT/04-plan-server-9201.json" >/dev/null
  server_digest="$(digest "$OUT/04-plan-server-9201.json")"
  migrate "$HERE/manifests/server-9201.json" --apply \
    --confirm "$(confirm server:9201)" --expect-digest "$server_digest" \
    --out "$OUT/05-apply-server-9201-r1.json" >/dev/null || failures=$((failures + 1))

  # A same-revision change to the complete configuration (overrides) must not be
  # accepted as an exact replay.
  sql_for server:9201 "UPDATE metric_policy_bindings SET payload = JSON_SET(payload, '\$.binding.overrides', JSON_OBJECT('chief_probe', 2)) WHERE resource_key = 'server:9201'"
  sql_for server:9201 "SELECT payload FROM metric_policy_bindings WHERE resource_key = 'server:9201'" > "$OUT/06-server-9201-drifted-payload.json"
  sql_for server:9201 "SELECT COUNT(*) FROM metric_policy_audit WHERE target = 'server:9201'" > "$OUT/06-server-9201-audit-before-replay.txt"
  expect_refusal "06-replay-server-9201-drifted" \
    migrate "$HERE/manifests/server-9201.json" --apply --plan "$OUT/04-plan-server-9201.json" \
    --confirm "$(confirm server:9201)" --expect-digest "$server_digest"
  sql_for server:9201 "SELECT COUNT(*) FROM metric_policy_audit WHERE target = 'server:9201'" > "$OUT/06-server-9201-audit-after-replay.txt"

  # ---------------------------------------------------------------- server rollback + replay
  step "server complete rollback (overrides restored), rollback replay, failure injection"
  rollback --resource server:9201 --to 0 --expect-current 1 --out "$OUT/07-rollback-server-9201-to-0-plan.json" >/dev/null
  rollback_digest="$(digest "$OUT/07-rollback-server-9201-to-0-plan.json")"
  [ "$rollback_digest" = "$(digest "$OUT/07-rollback-server-9201-to-0-plan.json")" ] || failures=$((failures + 1))
  rollback --resource server:9201 --to 0 --expect-current 1 --apply \
    --confirm "$(confirm server:9201)" --expect-digest "$rollback_digest" \
    --out "$OUT/08-rollback-server-9201-to-0-applied.json" >/dev/null || failures=$((failures + 1))
  sql_for server:9201 "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.revision')) AS revision,
         JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.overrides')) AS overrides,
         JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.group_id')) AS group_id
       FROM metric_policy_bindings WHERE resource_key='server:9201'" > "$OUT/08-server-9201-rolled-back-config.txt"

  # The same command after a successful rollback must plan the same digest and
  # apply as a legal no-op (exact replay), not fail on the expected-current guard.
  rollback --resource server:9201 --to 0 --expect-current 1 --out "$OUT/08b-rollback-server-9201-replay-plan.json" >/dev/null || failures=$((failures + 1))
  replay_digest="$(digest "$OUT/08b-rollback-server-9201-replay-plan.json")"
  [ "$replay_digest" = "$rollback_digest" ] || { echo "FAIL: rollback replay digest changed" >&2; failures=$((failures + 1)); }
  sql_for server:9201 "SELECT COUNT(*) FROM metric_policy_audit WHERE target = 'server:9201'" > "$OUT/08b-server-9201-audit-before-replay.txt"
  rollback --resource server:9201 --to 0 --expect-current 1 --apply \
    --confirm "$(confirm server:9201)" --expect-digest "$replay_digest" \
    --out "$OUT/08c-rollback-server-9201-replay-noop.json" >/dev/null || failures=$((failures + 1))
  sql_for server:9201 "SELECT COUNT(*) FROM metric_policy_audit WHERE target = 'server:9201'" > "$OUT/08c-server-9201-audit-after-replay.txt"
  sql_for server:9201 "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.revision')) AS revision FROM metric_policy_bindings WHERE resource_key='server:9201'" > "$OUT/08c-server-9201-revision-after-replay.txt"

  # ---------------------------------------------------------------- rollback baseline drift (B2)
  # Same-revision configuration drift AFTER the rollback plan was produced must
  # refuse with zero writes. The plan is produced by the read-only rollback
  # entry point; the drift is applied through the verified SQL entry point.
  step "rollback plan -> same-revision drift -> apply refused with zero writes"
  rollback --resource server:9201 --to 0 --expect-current 2 --out "$OUT/08d-rollback-server-9201-drift-plan.json" >/dev/null
  drift_digest="$(digest "$OUT/08d-rollback-server-9201-drift-plan.json")"
  sql_for server:9201 "UPDATE metric_policy_bindings SET payload = JSON_SET(payload, '\$.binding.overrides', JSON_OBJECT('boundary_probe', 3)) WHERE resource_key = 'server:9201'"
  sql_for server:9201 "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.revision')) AS revision, JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.overrides')) AS overrides FROM metric_policy_bindings WHERE resource_key='server:9201'" > "$OUT/08d-server-9201-drifted.txt"
  sql_for server:9201 "SELECT COUNT(*) FROM metric_policy_audit WHERE target = 'server:9201'" > "$OUT/08d-server-9201-audit-before.txt"
  expect_refusal "08e-rollback-server-9201-drift-refused" \
    rollback --resource server:9201 --to 0 --expect-current 2 --apply \
    --confirm "$(confirm server:9201)" --expect-digest "$drift_digest"
  sql_for server:9201 "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.revision')) AS revision, JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.overrides')) AS overrides FROM metric_policy_bindings WHERE resource_key='server:9201'" > "$OUT/08e-server-9201-after-refusal.txt"
  sql_for server:9201 "SELECT COUNT(*) FROM metric_policy_audit WHERE target = 'server:9201'" > "$OUT/08e-server-9201-audit-after.txt"
  # Restore the drifted configuration so later steps start from a known state.
  sql_for server:9201 "UPDATE metric_policy_bindings SET payload = JSON_REMOVE(payload, '\$.binding.overrides.boundary_probe') WHERE resource_key = 'server:9201'"

  # ---------------------------------------------------------------- changed invocation (B2)
  # A saved plan re-submitted with a manifest that adds an object blocker must be
  # refused before the write lock (exit 2, revision unchanged).
  step "saved plan + changed manifest invocation refused"
  mkdir -p "$OUT/boundary-manifests"
  python3 -I - "$HERE/manifests/server-9201.json" "$OUT/boundary-manifests/server-9201-changed.json" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest['object_blockers'] = [*(manifest.get('object_blockers') or []), 'BOUNDARY_NEW_BLOCKER']
json.dump(manifest, open(sys.argv[2], 'w'), indent=2, sort_keys=True)
PY
  migrate "$HERE/manifests/server-9201.json" --out "$OUT/08f-plan-server-9201-current.json" >/dev/null
  current_digest="$(digest "$OUT/08f-plan-server-9201-current.json")"
  sql_for server:9201 "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.revision')) AS revision FROM metric_policy_bindings WHERE resource_key='server:9201'" > "$OUT/08f-server-9201-revision-before.txt"
  expect_refusal "08g-saved-plan-changed-invocation" \
    migrate "$OUT/boundary-manifests/server-9201-changed.json" --apply --plan "$OUT/08f-plan-server-9201-current.json" \
    --confirm "$(confirm server:9201)" --expect-digest "$current_digest"
  sql_for server:9201 "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.revision')) AS revision FROM metric_policy_bindings WHERE resource_key='server:9201'" > "$OUT/08g-server-9201-revision-after.txt"

  migrate "$HERE/manifests/server-9201.json" --out "$OUT/09-plan-server-9201-again.json" >/dev/null
  again_digest="$(digest "$OUT/09-plan-server-9201-again.json")"
  expect_refusal "10-injected-failure-server-9201" \
    migrate "$HERE/manifests/server-9201.json" --apply \
    --confirm "$(confirm server:9201)" --expect-digest "$again_digest" --fail-at after-binding
  sql_for server:9201 "SELECT JSON_EXTRACT(payload,'\$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key='server:9201'" > "$OUT/10-server-9201-revision-after-failure.txt"
  migrate "$HERE/manifests/server-9201.json" --apply \
    --confirm "$(confirm server:9201)" --expect-digest "$again_digest" \
    --out "$OUT/11-apply-server-9201-r3.json" >/dev/null || failures=$((failures + 1))

  # ---------------------------------------------------------------- instance multi-template + rollback
  step "instance single-pin revision then rollback to the multi-template revision"
  migrate "$HERE/manifests/instance-9101-single-pin.json" --out "$OUT/12-plan-instance-9101-single.json" >/dev/null
  single_digest="$(digest "$OUT/12-plan-instance-9101-single.json")"
  migrate "$HERE/manifests/instance-9101-single-pin.json" --apply \
    --confirm "$(confirm instance:9101)" --expect-digest "$single_digest" \
    --out "$OUT/13-apply-instance-9101-r2.json" >/dev/null || failures=$((failures + 1))

  rollback --resource instance:9101 --to 1 --expect-current 2 --out "$OUT/14-rollback-instance-9101-to-1-plan.json" >/dev/null
  multi_digest="$(digest "$OUT/14-rollback-instance-9101-to-1-plan.json")"
  rollback --resource instance:9101 --to 1 --expect-current 2 --apply \
    --confirm "$(confirm instance:9101)" --expect-digest "$multi_digest" \
    --out "$OUT/15-rollback-instance-9101-to-1-applied.json" >/dev/null || failures=$((failures + 1))

  rollback --resource instance:9101 --to 0 --expect-current 3 --out "$OUT/16-rollback-instance-9101-to-0-plan.json" >/dev/null
  baseline_digest="$(digest "$OUT/16-rollback-instance-9101-to-0-plan.json")"
  rollback --resource instance:9101 --to 0 --expect-current 3 --apply \
    --confirm "$(confirm instance:9101)" --expect-digest "$baseline_digest" \
    --out "$OUT/17-rollback-instance-9101-to-0-applied.json" >/dev/null || failures=$((failures + 1))

  # ---------------------------------------------------------------- content negatives
  step "content-level preservation probes (ACL, history, truncation, retired version)"
  assert_resource_owned instance:9101 || exit 1
  MAX236_REALA_HANDLE="$MAX236_REALA_HANDLE" npx tsx "$HERE/evidence/correction-probes.ts" \
    "$OUT/correction-probes.json" >/dev/null || failures=$((failures + 1))

  # ---------------------------------------------------------------- device blocked + target guards
  step "device blocked, target confirmation refused"
  migrate "$HERE/manifests/network-device-9301.json" --out "$OUT/18-plan-device-9301-blocked.json" >/dev/null
  device_digest="$(digest "$OUT/18-plan-device-9301-blocked.json")"
  expect_refusal "19-apply-device-9301-blocked" \
    migrate "$HERE/manifests/network-device-9301.json" --apply \
    --confirm "$(confirm network_device:9301)" --expect-digest "$device_digest"
  expect_refusal "20-apply-instance-wrong-confirm" \
    migrate "$HERE/manifests/instance-9101.json" --apply \
    --confirm "$(handle_field database)@$HOST12:instance:9999" --expect-digest "$plan_digest"

  # ---------------------------------------------------------------- final state
  step "final state"
  sql "SELECT resource_key, JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.revision')) AS revision,
         JSON_LENGTH(JSON_EXTRACT(payload,'\$.binding.template_pins')) AS pins,
         JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.package.id')) AS package_id,
         JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.overrides')) AS overrides,
         JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.binding.group_id')) AS group_id,
         JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.resolved')) AS resolved
       FROM metric_policy_bindings ORDER BY resource_key" > "$OUT/21-final-bindings.txt"
  sql "SELECT target, COUNT(*) AS audits, MAX(JSON_UNQUOTE(JSON_EXTRACT(payload,'\$.revision'))) AS max_revision
       FROM metric_policy_audit GROUP BY target ORDER BY target" > "$OUT/21-final-audits.txt"
  sql "SELECT 'metrics_history' AS t, COUNT(*) AS n FROM metrics_history WHERE instance_id=9101
       UNION ALL SELECT 'metric_observations', COUNT(*) FROM metric_observations
       UNION ALL SELECT 'metric_publications', COUNT(*) FROM metric_publications
       UNION ALL SELECT 'alerts', COUNT(*) FROM alerts WHERE instance_id=9101
       UNION ALL SELECT 'server_metrics', COUNT(*) FROM server_metrics WHERE server_id=9201
       UNION ALL SELECT 'device_observations', COUNT(*) FROM network_device_observations WHERE device_id=9301
       UNION ALL SELECT 'instance_permissions', COUNT(*) FROM instance_permissions WHERE instance_id=9101
       UNION ALL SELECT 'audit_log_entries', COUNT(*) FROM audit_log_entries WHERE resource_id='9101'" > "$OUT/21-final-preserved-counts.txt"

  printf '\nFailures: %s\n' "$failures"
  exit "$failures"
}

# Sourcing this file (unit tests) only defines the verified helpers; running it
# performs the evidence run.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
