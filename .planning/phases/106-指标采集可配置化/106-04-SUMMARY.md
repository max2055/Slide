---
phase: 106
plan: 04
subsystem: metric-registry, ai-assist
tags: [ai-sql-generation, form-update, metric-registry, llm-integration]
requires: [106-01, 106-02, 106-03]
provides: [ai-sql-generation-endpoint, metric-form-collection-sql, metric-form-value-type-category, ai-generate-sql-button]
affects: [sql-generator, server-routes, metric-registry-form]
tech-stack:
  added: []
  patterns: [ai-sql-generation-via-llm-service, declare-form-fields-in-modal, frontend-ai-button-call-backend]
key-files:
  created:
    - path: apps/db-ops-api/src/sql-generator.ts
      purpose: AI SQL generation service calling llmService.chat() with system prompt for SQL generation
    - path: apps/db-ops-api/src/sql-generator.test.ts
      purpose: 10 unit tests covering generateCollectionSql and extractSqlFromResponse
  modified:
    - path: apps/db-ops-api/server.ts
      changes: POST /api/metrics/generate-sql route with metric:write permission (lines 3108-3129)
    - path: frontend/src/openclaw/ui/views/metric-registry.ts
      changes: Updated MetricDefinition interface, table columns, detail view, modal form with new fields, AI button, _aiGenerateSql method, updated save/delete logic
decisions:
  - Reuse existing llmService.chat() with ChatMessage[] interface instead of standalone fetch to env ANTHROPIC_API_KEY, leveraging existing provider routing and usage tracking
  - Route uses dynamic import for sql-generator to avoid circular dependency risk
  - AI button reads db_type from first checked checkbox and description from name/description fields
metrics:
  duration: 8 min
  completed-date: 2026-05-22
  tasks: 2
  commits: 3
  test-files: 1
  test-cases: 10
---

# Phase 106 Plan 04: AI SQL Generation + Form Update SUMMARY

## Objective

Implement AI-assisted SQL generation endpoint (D-10) and update the metric-registry frontend form: add collection_sql, value_type, category, updated_by fields, field configuration array declarative rendering (D-08), and AI SQL generation button.

## Task Execution

### Task 1: AI SQL Generation Backend Endpoint (TDD)

**RED phase:** Created `sql-generator.test.ts` with 10 tests covering:
- Valid mysql description returns SELECT SQL
- Empty description returns error
- Generated SQL passes `validateSqlIsSelectOnly()`
- LLM call failure returns error
- `extractSqlFromResponse` handles markdown code blocks (with and without `sql` tag), raw text, and empty input
- System prompt contains proper db_type-specific instructions

6 tests failed as expected (minimal stub).

**GREEN phase:** Implemented `sql-generator.ts`:
- `generateCollectionSql(dbType, description, instanceId?)` calls `llmService.chat()` with properly structured system prompt and user message
- `extractSqlFromResponse()` handles markdown code blocks (```sql, ```), raw text, and edge cases
- Input validation returns `{error: '请提供指标描述'}` for empty/whitespace-only description
- Added `POST /api/metrics/generate-sql` route in `server.ts` with `metric:write` permission

All 10 tests pass.

**Route registration:** Inserted at line 3108 (between metric DELETE at 3106 and baseline calculation at 3131), uses dynamic `import('./src/sql-generator.js')` to avoid potential circular dependency.

### Task 2: Frontend metric-registry Form Update

Updated `metrics-registry.ts` with:

**Interface:** Added `collection_sql?`, `value_type?`, `category?`, `updated_by?` to `MetricDefinition`.

**Table (D-08):** Added `<th>值类型</th>` and `<th>分类</th>` columns. Each row displays `value_type` (with badge styling) and `category`.

**Detail view:** Added `collection_sql` display in `<pre><code>` block (shown only when value exists). Added footer with `updated_by` and builtin indicator.

**Modal form (D-08):**
- `collection_sql` textarea with monospace font, disabled for builtin metrics
- "AI 生成采集 SQL" button that calls `_aiGenerateSql()` and fills the textarea
- `value_type` select (gauge/counter/histogram with descriptions), disabled for builtins
- `category` input with placeholder, readonly for builtins
- `updated_by` display in edit mode for non-builtin metrics

**_saveMetric():** Collects `collection_sql`, `value_type`, `category` into the POST/PUT body. `collection_sql` is sent as `null` when empty.

**_aiGenerateSql():** Reads first checked db_type from checkboxes, reads description from textarea or name input, calls `POST /api/metrics/generate-sql`, fills the `collection_sql` textarea, shows status feedback ("生成中...", "SQL 已生成 ✓", error messages).

**_deleteMetric():** Updated to handle 400 response with `referencedBy` array, showing human-readable error listing all referencing alert rule names.

## TDD Gate Compliance

- RED gate commit: `test(106-04): add failing test for AI SQL generation service`
- GREEN gate commit: `feat(106-04): implement AI SQL generation service and route`
- REFACTOR gate: Not needed (implementation matches test expectations directly)

## Deviations from Plan

None -- plan executed exactly as written.

## Commit History

| Commit | Message |
|--------|---------|
| `4ee93d8621f` | test(106-04): add failing test for AI SQL generation service |
| `e11169bd99f` | feat(106-04): implement AI SQL generation service and route |
| `a3fea894f5d` | feat(106-04): update metric-registry form with new fields and AI SQL button |

## Known Stubs

None -- all features are fully wired end-to-end. Forms have complete data flow, AI button calls backend, save payload includes all new fields.

## Threat Surface Scan

No new security-relevant surface introduced beyond what was in the plan's threat model:
- T-106-11 (Information Disclosure): Accepted -- description text and generated SQL are non-sensitive metric metadata
- T-106-12 (Tampering): Mitigated by existing `validateSqlIsSelectOnly()` call in POST/PUT routes (Plan 01/03) -- generate-sql endpoint does not persist SQL, only generates it

## Self-Check: PASSED

- `apps/db-ops-api/src/sql-generator.ts`: FOUND
- `apps/db-ops-api/src/sql-generator.test.ts`: FOUND
- `apps/db-ops-api/server.ts` (modified): FOUND (generate-sql route at line 3108)
- `frontend/src/openclaw/ui/views/metric-registry.ts` (modified): FOUND
- Commit hashes verified: all 3 commits exist
