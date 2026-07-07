---
phase: 125-ssh-metrics
plan: 01
subsystem: backend
tags: ssh, metrics, monitoring, cron, ssh2, mysql

requires:
  - phase: 124-server-registration
    provides: servers table, ServerDatabaseService with CRUD + credential decryption

provides:
  - server_metrics KV table (migration 020)
  - SshSessionPool singleton with connection reuse, keepalive, batch exec
  - ServerMetricProvider with 11 Linux metric commands and parsers
  - ServerCollector with configurable interval, auto status transition
  - 3 metric API routes (latest, history, one-shot collect)
  - ServerCollector wired into monitor-collector.ts startup/shutdown

affects:
  - alert-integration (Phase 125 Plan 02+)
  - frontend-server-metrics (Phase 125 Plan 03+)
  - security-hardening (host key verification)

tech-stack:
  added:
    - ssh2 (npm package for SSH connections)
  patterns:
    - Connection pool pattern for SSH (mirrors DB connection pool)
    - Key-value metric storage for server OS metrics
    - Singleton collector with independent timer (sibling to MonitorCollector)

key-files:
  created:
    - apps/db-ops-api/sql/migrations/020_add_server_metrics_table.sql
    - apps/db-ops-api/src/ssh-session-pool.ts
    - apps/db-ops-api/src/server-metric-provider.ts
    - apps/db-ops-api/src/server-collector.ts
  modified:
    - apps/db-ops-api/src/server-database-service.ts
    - apps/db-ops-api/src/monitor-collector.ts
    - apps/db-ops-api/server.ts
    - apps/db-ops-api/package.json
    - apps/db-ops-api/pnpm-lock.yaml

key-decisions:
  - "Store server metrics in key-value format (server_metrics KV table) instead of fixed columns, matching the existing metrics_history anti-pattern avoidance for server OS metrics"
  - "ServerCollector runs as a sibling component (independent timer) rather than inline in the monitor-collector tick to prevent SSH latency from blocking DB metric collection (Pitfall 3 avoidance)"
  - "Host key verification deferred (hostVerifier: () => true) to keep Phase 125 focused on collection pipeline; security hardening will be a separate phase"
  - "LANG=C LC_ALL=C prefix on all SSH commands to ensure locale-independent parsing (Pitfall 4 avoidance)"

patterns-established:
  - "SSH connection pooling: SshSessionPool reuses connections per host:port, limits to 3 sessions per server"
  - "Metric provider pattern: ServerMetricProvider defines commands + parsers, collector orchestrates execution and storage"
  - "Status transition: collector tracks consecutive failures per server in memory, transitions to unreachable at threshold"

requirements-completed:
  - COL-01
  - COL-02
  - COL-03
  - COL-04
  - COL-05
  - COL-06
  - COL-07
  - COL-08
  - SRV-05

duration: 28min
completed: 2026-07-07
status: complete
---

# Phase 125 Plan 01: SSH Metric Collection Backend Summary

**SshSessionPool, ServerMetricProvider, ServerCollector, server_metrics KV table, and 3 metric API routes**

## Performance

- **Duration:** 28 min
- **Started:** 2026-07-07T15:42:20Z
- **Completed:** 2026-07-07T16:10:15Z
- **Tasks:** 5
- **Files modified:** 8

## Accomplishments

- Created `server_metrics` KV table (migration 020) with indexes on (server_id, recorded_at) and (server_id, metric_name, recorded_at)
- Implemented `SshSessionPool` singleton with connection reuse, keepalive (60s interval, 3 count max), stale cleanup, and batch command execution
- Created `ServerMetricProvider` with 11 Linux metric definitions covering CPU, memory, swap, disk (per-mount), load (1/5/15 min), and uptime
- Built `ServerCollector` with configurable 5-minute interval, auto-status transition (online after success, unreachable after 3 consecutive failures), and disk detail per-mount-point parsing
- Wired ServerCollector into `monitor-collector.ts` start/stop lifecycle
- Added 3 metric API routes: latest values, time-series history with range filtering, and one-shot collection trigger
- Added `getCollectionEnabledServers()` and `updateServerStatus()` methods to `ServerDatabaseService`

## Task Commits

Each task was committed atomically:

1. **Task 1: Create SQL migration for server_metrics table** - `5a8be7f` (feat)
2. **Task 2: Create SshSessionPool** - `f6fc7e5` (feat)
3. **Task 3: Create ServerMetricProvider** - `11375f9` (feat)
4. **Task 4: Create ServerCollector + wire into monitor-collector** - `39c8477` (feat)
5. **Task 5: Add server metric API routes** - `601ba44` (feat)

## Files Created/Modified

| File | Action | Purpose |
|------|--------|---------|
| `apps/db-ops-api/sql/migrations/020_add_server_metrics_table.sql` | Created | server_metrics KV table migration |
| `apps/db-ops-api/src/ssh-session-pool.ts` | Created | SSH connection pool with reuse, batch exec, keepalive |
| `apps/db-ops-api/src/server-metric-provider.ts` | Created | Linux metric command definitions and parsers |
| `apps/db-ops-api/src/server-collector.ts` | Created | Cron-based collection loop with status transition |
| `apps/db-ops-api/src/server-database-service.ts` | Modified | Added getCollectionEnabledServers(), updateServerStatus() |
| `apps/db-ops-api/src/monitor-collector.ts` | Modified | Wired serverCollector.start()/stop() into lifecycle |
| `apps/db-ops-api/server.ts` | Modified | Added 3 metric API routes |
| `apps/db-ops-api/package.json` | Modified | Added ssh2 dependency |
| `apps/db-ops-api/pnpm-lock.yaml` | Modified | ssh2 dependency resolution |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed missing ssh2 npm dependency**
- **Found during:** Project initialization (before Task 1)
- **Issue:** ssh2 was not in package.json or node_modules; the SshSessionPool code requires it for SSH connections. Not installing would make the pool unusable.
- **Fix:** Ran `pnpm add ssh2 -F slide-api` from the monorepo root
- **Files modified:** apps/db-ops-api/package.json, apps/db-ops-api/pnpm-lock.yaml
- **Verification:** Import succeeds at typecheck; no errors in ssh-session-pool.ts
- **Committed in:** (dependency install committed alongside Task 2 commit f6fc7e5)

**2. [Rule 3 - Environment] Reset worktree to expected base commit**
- **Found during:** Worktree branch check at agent startup
- **Issue:** Worktree HEAD was at `80067576` (Phase 123 commit) but expected base was `8a7caf07` (Phase 124 summary commit). If left, commits would be on the wrong ancestor.
- **Fix:** Ran `git reset --hard 8a7caf077776d4438e772c5228a3ddd94e64c064` to align with expected base
- **Verification:** HEAD matches `8a7caf07` after reset
- **Committed in:** (environment fix, no commit needed)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 environment)
**Impact on plan:** Both fixes were necessary to proceed. No scope creep.

## Known Stubs

| File | Line | Reason |
|------|------|--------|
| `apps/db-ops-api/src/ssh-session-pool.ts` | `hostVerifier: () => true` | Host key verification deferred to security hardening phase. All connections are accepted without verifying remote host identity (MITM risk accepted per Phase 125 scope). |

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| `threat_flag: new_network_client` | `apps/db-ops-api/src/ssh-session-pool.ts` | SshSessionPool opens SSH connections to configured servers on port 22 (or custom port). This introduces a new outbound network path from the API server to managed servers. |
| `threat_flag: credential_loaded_to_memory` | `apps/db-ops-api/src/server-collector.ts` | Decrypted SSH credentials are held in Node.js process memory during collection. The credential is used for connection then released, but is not explicitly zeroed. |

## Issues Encountered

- **Worktree branch mismatch:** The worktree was on a Phase 123 commit instead of the expected Phase 124 base. Hard-reset the worktree branch to align with expected base before executing.
- **Edit tool tracking issues:** The Write/Edit tools did not consistently track reads for `server-database-service.ts` and `monitor-collector.ts`, requiring sed/Python fallbacks for edits.
- **Backtick escaping in Python generation:** Initial Python script for server.ts route injection used `\`` in a regular Python string, which preserved the backslash. Fixed by replacing `\`` -> `` ` `` and `\$` -> `$` in the generated section.

## Next Phase Readiness

- Foundation complete for SSH metric collection pipeline
- Alert integration (Phase 125 Plan 02+) can query server_metrics for threshold evaluation
- Frontend metrics views can consume GET /api/servers/:id/metrics and /metrics/history endpoints
- Host key verification still open — security hardening phase must address hostVerifier

---
*Phase: 125-ssh-metrics*
*Completed: 2026-07-07*
