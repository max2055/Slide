---
status: investigating
trigger: "4 out of 5 database instances have null metrics (cpu_usage, memory_usage, connections, qps), health_score=0, health_check_history last entry is 2026-06-06"
created: 2026-06-13T12:00:00Z
updated: 2026-06-13T14:05:00Z
---

## Current Focus

hypothesis: CONFIRMED — Instances have null metrics because their Docker containers are not running
test: Started postgresql container → metrics auto-recovered within 10s → health_score=100
expecting: Confirmed
next_action: "Return structured diagnosis to user"

## Symptoms

expected: All database instances should have current metrics and health scores
actual: Instance 1 (mysql3306) has metrics OK, health OK; Instances 2,6,7,8 have all null metrics, health_score=0
errors: health_check_history last entry is 2026-06-06 (a week ago)
reproduction: Check any API endpoint that returns instance metrics
started: Metrics stopped updating after containers exited

## Eliminated

- hypothesis: "Collector loop is not running"
  evidence: GET /api/collector/status returns running:true with schedule entries for all 5 instances (1,2,6,7,8) and lastCollected timestamps within seconds
  timestamp: 2026-06-13T13:50:00Z

- hypothesis: "Instances are not 'active' status and thus filtered out by getAllInstances()"
  evidence: GET /api/database/instances shows all 5 instances have status:'active'
  timestamp: 2026-06-13T13:52:00Z

- hypothesis: "Health check recording is broken (recordHealthCheck fails silently)"
  evidence: health_check_history DOES have entries up to current time (2026-06-13T13:53:27) for all instances, showing score=0/status=critical. Recording is working.
  timestamp: 2026-06-13T13:54:00Z

- hypothesis: "Connection issue is a code bug"
  evidence: After starting postgresql container, instance 2 auto-recovered within 10s without any code change. Confirms code works correctly.
  timestamp: 2026-06-13T14:03:00Z

## Evidence

- timestamp: 2026-06-13T13:48:00Z
  checked: GET /api/collector/status
  found: Collector running=true, heartbeatMs=10000, all 5 instances in schedule with recent lastCollected
  implication: Collector loop is operational, not crashed

- timestamp: 2026-06-13T13:50:00Z
  checked: GET /api/database/instances/:id/metrics for instances 1,2,6,7,8
  found: Instance 1 returns full metrics (cpu=21, mem=14, connections=10, etc.). Instances 2,6,7,8 return {"error":"无法获取指标，实例可能未连接"}
  implication: databaseService.getRealtimeMetrics() returns null because _withAutoReconnect finds no connection in the Map

- timestamp: 2026-06-13T13:50:00Z
  checked: GET /api/database/instances
  found: All 5 instances have status:'active'. Instances 2,6,7,8 have health_score=0, health_status='critical', but last_health_check_at is recent (June 13)
  implication: updateHealthStatus IS being called and updating last_health_check_at, but health_score stays 0

- timestamp: 2026-06-13T13:52:00Z
  checked: Instance connection details
  found: Instance 2=postgresql(localhost:5432), Instance 7=oracle(127.0.0.1:1521), Instance 6=dameng(localhost:5236), Instance 8=mysql(localhost:3308)
  implication: Verify if these services are listening

- timestamp: 2026-06-13T13:55:00Z
  checked: docker ps + lsof -i for ports 5432,1521,5236,3308
  found: Only mysql (port 3306) is running. Containers: postgresql(Exited 47h ago), oracle19c(Exited 13h ago), dameng(Exited 13h ago), mysql3308(Exited 13h ago). Ports 5432,1521,5236,3308 have NO listeners.
  implication: No database server is listening on these ports — all connection attempts fail

- timestamp: 2026-06-13T13:56:00Z
  checked: docker ps -a (all containers)
  found: Only mysql container is Up (13 hours). All other DB containers are Exited.
  implication: Infrastructure root cause — containers stopped, no code bug

- timestamp: 2026-06-13T14:00:00Z
  checked: Code path tracing
  found: server.ts:3979-4017 calls addConnection for each instance. Port 3306 succeeds → connection entry in Map. Ports 5432/1521/5236/3308 fail (ECONNREFUSED) → addConnection returns false at database-service.ts:304 → no connection entry. Later, every databaseService method (getRealtimeMetrics, checkHealth) goes through _withAutoReconnect (line 3022) which returns null at line 3028 because connections.get(id) is null.
  implication: The code works correctly — it just has no connection to operate on

- timestamp: 2026-06-13T14:03:00Z
  checked: Started postgresql container, waited 15s, checked metrics
  found: Instance 2 metrics fully populated (cpu=1, memory=70, connections=9, qps=1, etc), health_score=100, health_status=healthy. Auto-recovered within one collector tick.
  implication: Code auto-recovery works correctly. Root cause is confirmed as infrastructure.

## Resolution

root_cause: "The database server containers for instances 2 (postgresql), 6 (dameng), 7 (oracle19c), and 8 (mysql3308) have exited and are no longer running. Only the MySQL container (port 3306) for instance 1 (mysql3306) is running. When the Slide server starts, it tries to establish connections (server.ts:3979-4017). addConnection() succeeds for instance 1 (3306 is listening) but fails for instances 2,6,7,8 because their TCP ports refuse connections. Without connection entries in the DatabaseService.connections Map (database-service.ts:151), _withAutoReconnect (line 3022) immediately returns null at line 3028, so getRealtimeMetrics() and checkHealth() both return null. The collector IS running and tries to reconnect every tick via tryReconnect (monitor-collector.ts:263), but ECONNREFUSED is not a transient error — it means nothing is listening."

fix: "docker start postgresql oracle19c dameng mysql3308"
verification: "PostgreSQL container started → instance 2 recovered to health_score=100 within 10 seconds without any code change. Same expected for instances 6,7,8."
files_changed: []
