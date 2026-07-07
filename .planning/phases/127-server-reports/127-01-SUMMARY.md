---
phase: 127-server-reports
plan: 01
subsystem: server-monitoring
tags:
  - server-report
  - health-inspection
  - report-generation
  - html-output
  - markdown-output
requires:
  - server-collector (metric data)
  - server-database-service (server list)
  - db-connection (metric queries)
provides:
  - ServerReportService
affects:
  - server.ts (route registration)
tech-stack:
  added:
    - server-report-service.ts (new report service)
    - TypeScript interfaces for report data structures
  patterns:
    - Follows existing report-service pattern with generateHtml/generateMarkdown
key-files:
  created:
    - apps/db-ops-api/src/server-report-service.ts
  modified:
    - apps/db-ops-api/server.ts
decisions:
  - Scoring thresholds follow the plan spec: CPU/memory/disk <50% → 100, 50-80% → 60, >80% → 20; load <1 → 100, 1-2 → 60, >2 → 20
  - GET /api/servers/reports uses requirePermission('servers:view'), POST uses requirePermission('servers:manage')
  - Default GET format is 'html'; pass ?format=md for markdown
metrics:
  duration: 8m
  completed_date: 2026-07-08T00:00:00Z
  tasks_completed: 1/1
  files_created: 1
  files_modified: 1
  commits: 1
status: complete

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
</frontmatter>

# Phase 127 Plan 01: ServerReportService — Health Inspection Reports

## Objective

Implement scheduled server health inspection reports. Create ServerReportService that generates health reports using CPU/memory/disk/load scoring with HTML and Markdown output formats, with API routes for trigger and retrieval.

## Context

This is the first plan of Phase 127 (server reports). It builds on the server management infrastructure from Phase 125 (server registration + SSH collection) by adding a report generation layer that aggregates server metrics into dimension-scored health reports.

The service queries the `server_metrics` KV table (populated by `server-collector.ts` via SSH metric collection) for the latest values of `cpu_usage`, `memory_usage`, `disk_usage_*` (per mount point), and `load_1min`. Each dimension is scored using tiered thresholds, an overall score is computed as the average of all available dimensions, and servers are sorted worst-first.

## Task Execution

### Task 1: Create ServerReportService (auto)

**Status:** Complete

**Implementation Details:**
- **`generateReport()`**: Queries all servers via `serverDatabaseService.getAllServers()`, then fetches latest metrics per server with a subquery-optimized SQL join on `server_metrics`. Computes 4 dimension scores using `scorePercentile` (CPU, memory, disk) and `scoreLoad` (load_1min). Overall score = average of available dimension scores. Returns structured `ReportData` sorted by `overall_score` ascending.
- **`generateHtml(reportData)`**: Generates a standalone HTML document with CSS-inline styling. Includes summary card grid (total/healthy/warning/critical counts), overall health banner, and scored server table with green (>80) / amber (60-80) / red (<60) color coding.
- **`generateMarkdown(reportData)`**: Generates markdown with overview table, warning banners, and detail table with all dimensions and raw metric values (CPU%, memory%, disk%, load).
- **API Routes**:
  - `POST /api/servers/reports/generate` — JWT + `servers:manage`, returns raw JSON `ReportData`
  - `GET /api/servers/reports?format=html|md` — JWT + `servers:view`, returns formatted report with appropriate Content-Type

**Metric Names Used:**
- `cpu_usage` — CPU percentage (scored as percentile)
- `memory_usage` — Memory usage percentage (scored as percentile)
- `disk_usage_*` — Per-mount-point disk usage (averaged, scored as percentile)
- `load_1min` — 1-minute load average (scored relative to 4 cores)

**Scoring Rules:**
| Dimension | Condition | Score |
|-----------|-----------|-------|
| CPU/Memory/Disk | <50% | 100 |
| CPU/Memory/Disk | 50-80% | 60 |
| CPU/Memory/Disk | >80% | 20 |
| Load (1min) | <1 | 100 |
| Load (1min) | 1-2 | 60 |
| Load (1min) | >2 | 20 |

**Commit:** `63c4666`

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| GET defaults to HTML format | Most common use case for browser viewing |
| GET uses `servers:view`, POST uses `servers:manage` | Viewing reports requires lower privilege than generating |
| Score 0 for missing dimension | Allows partial reports when some metrics haven't been collected yet |
| Worst-first sort order | Most critical servers appear first in the report |
| Direct DB queries (no caching) | Reports are on-demand or cron-driven; freshness matters more than speed |

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- [x] `apps/db-ops-api/src/server-report-service.ts` exists with `generateReport`, `generateHtml`, `generateMarkdown` methods
- [x] API routes registered in `server.ts`:
  - POST `/api/servers/reports/generate` (line 1542)
  - GET `/api/servers/reports` (line 1552)
- [x] Report generates CPU/memory/disk/load dimension scores
- [x] Reports available in HTML and Markdown formats
- [x] Auth protection — both routes require JWT token via `verifyToken`

## Success Criteria

- [x] Server health reports generate with CPU/memory/disk/load dimension scores
- [x] Reports available in HTML and Markdown formats
- [x] API endpoint triggers report generation

## Self-Check: PASSED

- [x] `apps/db-ops-api/src/server-report-service.ts` — file exists
- [x] `grep -c 'generateReport\|generateHtml\|generateMarkdown'` = 3 — all methods present
- [x] `grep '/api/servers/reports'` — both routes registered
- [x] `63c4666` — commit exists
