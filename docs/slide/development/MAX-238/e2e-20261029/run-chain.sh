#!/usr/bin/env bash
# MAX238-COLLECTION-DISPLAY-E2E-R1 — reproducible chain over the real HTTP API.
#
# Inputs (environment only; no secret is written to this file):
#   MAX238_API=http://127.0.0.1:3001
#   MAX238_ADMIN_USER / MAX238_ADMIN_PASSWORD
#   MAX238_RESOURCE_TYPE=instance MAX238_RESOURCE_ID=1
#   MAX238_EXPECTED_REVISION=4            # current binding revision of the target
#   MAX238_TEMPLATE_ID=e19c120027e04da69b130e0f6cea29fc
#   MAX238_TEMPLATE_V1_HASH / MAX238_TEMPLATE_V2_HASH (omit V2 to let the script repin)
#
# It performs: token → template list → preview (incompatible pin must fail) →
# repin (optional) → preview → trial → apply → latest-data query. Every response
# is printed as JSON; nothing is written to the platform database beyond the
# binding flow the API itself performs.
set -euo pipefail

API="${MAX238_API:-http://127.0.0.1:3001}"
TYPE="${MAX238_RESOURCE_TYPE:-instance}"
ID="${MAX238_RESOURCE_ID:-1}"
REVISION="${MAX238_EXPECTED_REVISION:-4}"
TEMPLATE="${MAX238_TEMPLATE_ID:-e19c120027e04da69b130e0f6cea29fc}"
V1_HASH="${MAX238_TEMPLATE_V1_HASH:-sha256:4db4800495801f3993cfd5a21eda672bdd7bccbbb535bc8224cd57be7fbb107a}"
V2_HASH="${MAX238_TEMPLATE_V2_HASH:-}"
NONCE="${MAX238_NONCE:-$(date +%s)}"

post() { curl -sS -X POST "$API$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"; }
get() { curl -sS "$API$1" -H "Authorization: Bearer $TOKEN"; }
pin() { printf '{"template_id":"%s","version":%s,"content_hash":"%s"}' "$TEMPLATE" "$1" "$2"; }

TOKEN=$(curl -sS -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${MAX238_ADMIN_USER:-admin}\",\"password\":\"${MAX238_ADMIN_PASSWORD:?set MAX238_ADMIN_PASSWORD}\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

echo '== templates =='; get /api/metrics/templates | python3 -m json.tool
echo '== preview v1 (must be executable=false on a 9.6 target) =='
post "/api/metrics/template-bindings/$TYPE/$ID/preview" \
  "{\"expected_revision\":$REVISION,\"template_pins\":[$(pin 1 "$V1_HASH")]}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"executable":d.get("executable"),"releases":[{"release":r["release"],"applicability":r["applicability"],"collectors":r["collector_ids"]} for r in d.get("releases",[])],"items":[{"item_id":i["item_id"],"decision":i["decision"]} for i in d.get("items",[])]},indent=2))'

if [ -z "$V2_HASH" ]; then
  echo '== repin: publish a new immutable version for this target =='
  post "/api/metrics/templates/$TEMPLATE/repin" "{\"resource\":{\"type\":\"$TYPE\",\"id\":$ID}}" | python3 -m json.tool
  V2_HASH=$(get "/api/metrics/templates" | python3 -c "
import json,sys
d=json.load(sys.stdin)
t=[x for x in d['templates'] if x['template_id']=='$TEMPLATE'][0]
print(sorted(t['versions'], key=lambda v: v['version'])[-1]['content_hash'])")
fi

echo '== preview v2 =='
post "/api/metrics/template-bindings/$TYPE/$ID/preview" \
  "{\"expected_revision\":$REVISION,\"template_pins\":[$(pin 2 "$V2_HASH")]}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"executable":d.get("executable"),"resolution_identity":d.get("resolution_identity"),"releases":[{"release":r["release"],"applicability":r["applicability"],"collectors":r["collector_ids"],"metrics":r["metric_keys"]} for r in d.get("releases",[])]},indent=2))'

echo '== trial (real read-only collection) =='
RECEIPT="max238-e2e-trial-$NONCE"
post "/api/metrics/template-bindings/$TYPE/$ID/trial" \
  "{\"expected_revision\":$REVISION,\"receipt_id\":\"$RECEIPT\",\"template_pins\":[$(pin 2 "$V2_HASH")]}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"decision":d.get("decision"),"receipt_id":d.get("receipt_id"),"items":d.get("items"),"samples":[{"metric":s["metric"],"value":s["value"],"unit":s["unit"],"observed_at":s["observed_at"],"read":s["read"]} for s in d.get("samples",[])]},indent=2))'

echo '== apply =='
post "/api/metrics/template-bindings/$TYPE/$ID/apply" \
  "{\"expected_revision\":$REVISION,\"receipt_id\":\"$RECEIPT\",\"caller_key\":\"max238-e2e-apply-$NONCE\",\"template_pins\":[$(pin 2 "$V2_HASH")]}" \
  | python3 -m json.tool

echo '== binding status =='; get "/api/metrics/template-bindings/$TYPE/$ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(json.dumps({k:d.get(k) for k in ('source','revision','application','template_pins')},indent=2))"

echo '== latest data =='
post /api/metrics/query "{\"resource\":{\"type\":\"$TYPE\",\"id\":$ID},\"view\":\"all\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d: print(d); raise SystemExit(1)
for m in d['metrics']:
    if m['definition']['id']=='db.uptime_seconds':
        buckets=[b for s in m['series'] for b in s['buckets'] if b['value']]
        print(json.dumps({'state':m['state'],'enabled':m['enabled'],'capability':(m.get('capability') or {}).get('status'),
          'latest':buckets[-1] if buckets else None},indent=2))"
