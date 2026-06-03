---
phase: 106-指标采集可配置化
created: 2026-05-22
status: drafted
nyquist_compliance: true
---

# Phase 106: 指标采集可配置化 — Validation Strategy

## Critical Failure Modes

| Mode | Description | Mitigation |
|------|-------------|------------|
| F1 | Provider extraction breaks existing metrics collection | Compare pre/post metrics values for all 4 DB types |
| F2 | JSON column merge breaks alert evaluation | Unit test getMetricValue() with both fixed + JSON data |
| F3 | Custom SQL whitelist bypassed via injection | Node-sql-parser AST check + integration test with malicious SQL |
| F4 | Provider file scan fails silently | Log all discovered/registered providers on startup |
| F5 | Custom SQL degrades collection cycle performance | Timeout per SQL (30s) + overall cycle duration monitoring |

## Validation Dimensions

### 1. Provider Architecture
- Verify all 4 existing Providers produce identical metrics to pre-refactor code
- Verify CustomSQLProvider reads from metric_definitions and executes user SQL
- Verify file system scanning discovers all Provider classes

### 2. Storage
- Verify JSON column co-exists with fixed columns (dual-write)
- Verify getMetricValue() merges fixed + JSON correctly
- Verify metrics_history INSERT/query works with new column

### 3. SQL Safety
- Verify SQL whitelist rejects non-SELECT statements
- Verify custom SQL timeout (30s) enforced
- Verify independent failure: one bad SQL doesn't block others

### 4. Frontend
- Verify new fields render from FIELD_CONFIG array
- Verify AI generate button calls API and populates textarea
- Verify save includes all new fields

### 5. Alert Integration
- Verify alert rule save rejects invalid metric_name
- Verify alert engine evaluates custom metrics from JSON column

## Test Strategy

### Backend (106-01)
- Registry<T> unit test: register/enable/disable/list/get
- SQL validator unit test: SELECT allowed, INSERT/DELETE blocked
- Migration test: column exists, old queries still work

### Provider Extraction (106-02)
- Per-Provider unit test: collect() returns same values as old methods
- Integration test: full collection cycle with all Providers

### Alert Integration (106-03)
- getMetricValue() unit test with JSON merge
- Alert rule save validation test

### Frontend (106-04)
- Human verification: new metric form fields
- Human verification: AI generate SQL flow

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Provider extraction introduces subtle behavior differences | Medium | Comprehensive comparison testing pre/post refactor |
| node-sql-parser can't handle Oracle/Dameng dialect | Medium | Graceful degradation: parse failure → block SQL with safe fallback message |
| JSON column query performance on large history | Low | Index on created_at already exists; JSON_EXTRACT used sparingly |
