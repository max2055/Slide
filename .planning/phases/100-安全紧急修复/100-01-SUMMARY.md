---
phase: 100
plan: 01
subsystem: api-core, frontend-icons
tags: ["security", "auth", "icon-fix", "information-disclosure"]
requires: []
provides:
  - "Auth gate on GET /api/database/instances (SEC-01)"
  - "Auth gate on GET /api/alerts (SEC-01)"
  - "Auth gate on GET /api/metrics/:instanceId (SEC-01)"
  - "Auth gate on GET /api/chat/history (SEC-01)"
  - "eyeOff SVG rendering fix (SEC-02)"
affects:
  - apps/db-ops-api/server.ts
  - frontend/src/openclaw/ui/icons.ts
tech-stack:
  added: []
  patterns:
    - "Fastify route config: preHandler: [verifyToken] on GET routes"
    - "Lucide-style SVG rendering attributes on icons"
key-files:
  created: []
  modified:
    - apps/db-ops-api/server.ts
    - frontend/src/openclaw/ui/icons.ts
decisions:
  - "Use preHandler only (no requirePermission) for read-only GET routes — authentication is sufficient, authorization granularity deferred"
metrics:
  duration: null
  completed_date: "2026-05-20"
---

# Phase 100 Plan 01: Security Emergency Fix Summary

Add JWT auth middleware to 4 unprotected GET data routes and fix eyeOff SVG rendering attributes that caused login page crash.

## One-Liner

Auth-gate 4 data-exposing GET routes (instances, alerts, metrics, chat history) and add missing rendering attributes to eyeOff SVG icon to fix login page runtime crash.

## Tasks

### Task 1: Add `preHandler: [verifyToken]` to 4 GET routes

**Files modified:** `apps/db-ops-api/server.ts`

Applied `{ preHandler: [verifyToken] }` as the second argument to 4 `fastify.get()` calls:

| Route | Line | Before | After |
|-------|------|--------|-------|
| GET /api/database/instances | L388 | No auth | `preHandler: [verifyToken]` |
| GET /api/alerts | L532 | No auth | `preHandler: [verifyToken]` |
| GET /api/metrics/:instanceId | L567 | No auth | `preHandler: [verifyToken]` |
| GET /api/chat/history | L578 | No auth | `preHandler: [verifyToken]` |

- No `requirePermission` added per decision D-01 (authentication sufficient for read-only access)
- Existing auth routes (POST/DELETE /api/alerts, POST /api/database/instances, etc.) untouched
- No import changes needed — `verifyToken` already defined at L85

**Verification:**
- `grep -c "preHandler: \[verifyToken\]" server.ts` returns 4 (exactly the new routes)
- All 4 target routes confirmed via grep to include `preHandler`

**Threat mitigation:** T-100-01 through T-100-04 (Information Disclosure) — mitigated per STRIDE register.

### Task 2: Fix eyeOff SVG rendering attributes

**Files modified:** `frontend/src/openclaw/ui/icons.ts`

Added 5 rendering attributes to the eyeOff `<svg>` element:

```
Before:  <svg viewBox="0 0 24 24">
After:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
```

- All 4 `<path>` elements preserved unchanged
- Other icons (eye, shield, moreHorizontal, etc.) not modified
- Follows Lucide icon pattern matching shield icon at L489

**Verification:**
- SVG element confirmed to contain all required rendering attributes
- Path elements verified unchanged

## Deviations from Plan

None — plan executed exactly as written.

## Threat Flags

None — all security-relevant changes (4 new auth gates) were covered by the plan's threat model.

## Verification Results

### Automated Verification

1. grep count for `preHandler: [verifyToken]`: **4** (PASS)
2. All 4 routes confirmed with preHandler: **PASS**
3. eyeOff SVG rendering attributes confirmed: **PASS**

## Self-Check: PASSED

- `apps/db-ops-api/server.ts` — 4 preHandler additions verified
- `frontend/src/openclaw/ui/icons.ts` — eyeOff SVG attributes verified
- Commit `634c46149cb`: Task 1 committed
- Commit `e6220e0573c`: Task 2 committed
