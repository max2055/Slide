---
status: investigating
trigger: "Diagnose two issues: 1) Dashboard capacity trend shows only 1 instance out of 5; 2) Alert events API returns unparseable data"
created: 2026-06-13T00:00:00.000Z
updated: 2026-06-13T13:55:00.000Z
---

## Current Focus

hypothesis: (both issues diagnosed — preparing final report)
test: Completed
expecting: See Resolution section
next_action: Present findings to user

## Symptoms

expected: 
  - Issue 1: GET /api/dashboard/capacity-trend?hours=168 should show trend data for 5 instances
  - Issue 2: GET /api/alerts/events?limit=5 should return parseable JSON that jq can handle
actual:
  - Issue 1: Recent hours show instance_count: 1 (only instance 1 has data)
  - Issue 2: Current response is valid JSON { items: [...], total: N } — format differs from expectation
errors: []
reproduction: 
  - Issue 1: curl http://localhost:3000/api/dashboard/capacity-trend?hours=168
  - Issue 2: curl http://localhost:3000/api/alerts/events?limit=5 | jq '.'
started: unknown

## Eliminated

- hypothesis: Issue 2 — response contains invalid JSON due to BigInt values
  evidence: Tested multiple times with jq, python3 json parser — all pass. Field types are regular int, not BigInt
  timestamp: 2026-06-13
- hypothesis: Issue 2 — response has wrong Content-Type or encoding
  evidence: Response has content-type: application/json; charset=utf-8, valid UTF-8
  timestamp: 2026-06-13

## Evidence

- timestamp: 2026-06-13
  checked: capacity-trend handler (server.ts:1536-1606)
  found: Query uses COUNT(DISTINCT instance_id) from capacity_history, grouped by hour bucket
  implication: instance_count reflects how many distinct instances have data in each hour

- timestamp: 2026-06-13
  checked: Database query — capacity_history last 72 hours
  found: Only instance 1 (mysql3306) has data after 08:39:50 today. Instances 6,7,8 all stopped at exactly 08:39:50. Instance 2 (postgresql5432) stopped at June 11 20:47.
  implication: Recent hours show only 1 instance because capacity data collection fails for other instances

- timestamp: 2026-06-13
  checked: collectCapacity() in monitor-collector.ts (line 360-389)
  found: Iterates all active instances, calls databaseService.getCapacityInfo(id). Errors are caught and silently skipped.
  implication: If getCapacityInfo returns null/undefined, the instance is silently skipped

- timestamp: 2026-06-13
  checked: getCapacityInfo() in database-service.ts (line 2675-2693)
  found: Routes to db-type-specific methods. Each checks for live connection:
    - getMySQLCapacity: if (!conn.pool) return null;
    - getPostgreSQLCapacity: if (!conn.pgClient) return null;
    - getOracleCapacity: if (!conn.oraclePool) return null;
    - getDamengCapacity: if (!conn.dmConnection) return null;
  implication: If instance's database service isn't running, connection is null, capacity can't be collected

- timestamp: 2026-06-13
  checked: All 5 instance connections
  found: All 5 are status=active. But only instance 1 (mysql on localhost:3306, the main Slide DB) has a live database connection for capacity queries. Others (oracle1521 on 127.0.0.1:1521, postgresql5432 on localhost:5432, dameng on localhost:5236, test mysql on localhost:3308) likely have no running database services.
  implication: Capacity collection silently fails for 4/5 instances → only 1 instance in trend

- timestamp: 2026-06-13
  checked: Alert events handler (server.ts:3761-3768)
  found: Delegates to alertEventService.getEvents(), returns result directly
  implication: Response = { items: rows, total: N } — object wrapper, not flat array

- timestamp: 2026-06-13
  checked: getEvents() in alert-event-service.ts (line 26-104)
  found: Returns { items: rows, total }. Without limit parameter, ALL 22823 events returned (~11 MB). Offset without limit causes SQL error (MySQL OFFSET requires LIMIT).
  implication: Response format is valid JSON but differs from flat-array expectation. Missing default limit is a robustness issue.

- timestamp: 2026-06-13
  checked: Actual GET /api/alerts/events?limit=5 response with jq
  found: jq parses fine. 2450 bytes, content-type: application/json. Works with jq '.' and jq '.items[]'.
  implication: Current endpoint returns valid JSON. Cannot reproduce "unparseable" issue.

## Resolution

root_cause: 
  Issue 1: Capacity_history only collects data for instance 1 (mysql3306 on localhost:3306). Other 4 instances' database services (oracle, postgresql, dameng, test mysql on 3308) are not running or their connections are broken. getCapacityInfo() silently returns null → capacity_history has no recent data for them → COUNT(DISTINCT instance_id) = 1.
  
  Issue 2: The endpoint returns { items: [...], total: N } — an object wrapper, not a flat array. The response is valid JSON but the format may mismatch expectations. Additionally, no default LIMIT means calling without ?limit=N returns all 22823 events (~11 MB), and offset without limit causes a silent SQL error (MySQL requires LIMIT before OFFSET).

fix: (pending)
verification: (pending)
files_changed: []
