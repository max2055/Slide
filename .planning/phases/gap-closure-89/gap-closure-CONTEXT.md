# Phase 89: Gap Closure - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning

## Remaining v1.1 Issues

### P0 — Functional Gaps

**D-01: Database selector for SQL Console + Approval**
- SQL Console only has instance selector, not database/schema selector
- Approval auto-exec DDL goes to default connection database (e.g. mysql system db instead of db_ops_ai)
- Need: database dropdown in SQL Console, database param in approval execution
- Scope: frontend (sql-console.ts) + backend (approval-service.ts, sql-executor.ts)

**D-02: Diagnosis stuck on "running"**
- Instance detail → 一键诊断 submits OK but status stays "running" indefinitely
- API returns `{id, status:"running", session_key:"diagnosis-xxx"}` correctly
- Polling `/api/ai/analysis/:id/status` always returns `status: "running"`
- Likely: OpenClaw diagnosis session hangs / LLM call doesn't complete
- Scope: backend server.ts diagnosis flow, OpenClaw gateway session

### P1 — Edge-case bugs

**D-03: Slow query tab shows badge but no content**
- Instance detail → topsql badge shows "2" but tab content empty
- API `/api/database/instances/:id/topsql` returns 2 records correctly
- Frontend rendering logic at instance-detail.ts:1743 may have data mismatch
- Scope: frontend instance-detail.ts topsql rendering

**D-04: Schema check "Bad Request"**
- Instance detail → table structure → 检查变更 returns Bad Request
- API `/api/schema/changes/:instanceId` POST returns `{success:true, changes:[]}` correctly for admin
- May be: permission issue (requirePermission + requireInstanceAccess middleware), or frontend not sending auth headers
- Scope: frontend schema-management.ts + backend permission middleware

### P2 — Usability

**D-05: Metric registry — can't delete built-in metrics (no reason given)**
- Delete button disabled with `?disabled=${metric.is_builtin}` but no explanation
- Need: tooltip or message explaining why built-in metrics can't be deleted
- Also: can't edit collection SQL when editing metrics
- Scope: frontend metric-registry.ts

### P3 — Cosmetic

**D-06: EXPLAIN format coverage**
- Normalizer covers `query_block` and `query_plan` but some MySQL/PostgreSQL EXPLAIN JSON variants may not match
- Scope: frontend sql-console.ts normalizer

**D-07: Approval checkbox visual separation**
- Batch selection checkbox and "execute after approve" checkbox are in the same row
- Already added bg color distinction, but could be better
- Scope: frontend approval-dashboard.ts CSS
