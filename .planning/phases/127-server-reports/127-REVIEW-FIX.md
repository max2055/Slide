---
phase: 127-server-reports
fixed_at: 2026-07-08T22:10:00Z
review_path: .planning/phases/127-server-reports/127-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 127: Code Review Fix Report

**Fixed at:** 2026-07-08T22:10:00Z
**Source review:** .planning/phases/127-server-reports/127-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4
- Fixed: 4
- Skipped: 0

## Fixed Issues

### WR-01: _statusBadge does not escape status value (XSS vector)

**Files modified:** `apps/db-ops-api/src/server-report-service.ts`
**Commit:** 007e840
**Applied fix:** Replaced raw status interpolation with a CSS class mapping object (`cssMap`) to decouple CSS class names from status values. The status text content is now passed through `_escapeHtml()` before rendering. Unknown statuses fall back to the `offline` CSS class. This also addresses IN-03 (raw status as CSS class name) in the same change.

### WR-02: NULL metric_value silently converts to 0 (false healthy reading)

**Files modified:** `apps/db-ops-api/src/server-report-service.ts`
**Commit:** c00ec00
**Applied fix:** Added a null/undefined guard before `Number(row.metric_value)`. Rows where `metric_value` is null or undefined are now skipped via `continue`, preventing silent 0 conversion that would produce false healthy readings for CPU, memory, disk, and load metrics.

### WR-03: Load scoring ignores actual CPU core count

**Files modified:** `apps/db-ops-api/src/server-report-service.ts`
**Commit:** 75c67fb
**Applied fix:** Added a `coreCount` parameter (defaulting to 4) to `scoreLoad()`. The raw `value` is now divided by `coreCount` before applying the per-core thresholds (<1, 1-2, >2). This prevents false-critical alarms on multi-core servers where a load_1min of 6.0 is normal on 32 cores but was previously scored as 20 (critical). The JSDoc comment was updated to clarify the per-core semantics.

### WR-04: Score boundary renders 80/100 as "warning" when 3/4 dimensions are perfect

**Files modified:** `apps/db-ops-api/src/server-report-service.ts`
**Commit:** 9c45809
**Applied fix:** Changed the threshold from `> 80` to `>= 80` in both `scoreClass()` and the count categorization loop. A score of exactly 80 is now classified as "good"/"healthy" instead of "warning", so a server with three perfect scores (100 each) and one slightly elevated metric (score 60) is correctly categorized as healthy rather than warning.

---

_Fixed: 2026-07-08T22:10:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
