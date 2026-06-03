---
phase: 107
slug: 实例详情页指标动态化
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-27
---

# Phase 107 — Validation Strategy

> Per-phase validation contract. Backward-compatible interface extensions + UI refactoring. No new packages or infrastructure.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | None (no new test files) |
| **Strategy** | Compile-time verification (tsc) + grep checks + manual UI inspection |
| **Rationale** | All changes are additive (optional `metricIds` param, new JSON_EXTRACT query, dynamic loop rendering). No new business logic that requires unit tests. Existing test infrastructure covers the unchanged code paths. |

## Verification Approach

| Plan | Verification Method |
|------|---------------------|
| 107-01 | `tsc --noEmit` on modified files; grep for `JSON_EXTRACT` and `metricIds` in metrics-database-service.ts; verify backward compat by calling endpoint without `metrics` param |
| 107-02 | `tsc --noEmit` on instance-detail.ts; grep to confirm no hardcoded metric keys remain (`cpu_usage`, `memory_usage`, `disk_usage` in _renderMetrics); manual UI check for dynamic card rendering |

## Nyquist Coverage

| Coverage Dimension | Status | Evidence |
|--------------------|--------|----------|
| Requirement traceability | SATISFIED | DYNMET-01 mapped to both plans |
| Key link verification | SATISFIED | All 6 key links verified in plan checker |
| Type safety | SATISFIED | TypeScript compilation gates in both plans |
| Backward compatibility | SATISFIED | Optional `metricIds` param preserves existing behavior |
