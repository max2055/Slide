---
phase: 104-告警系统增强
created: 2026-05-21
status: drafted
nyquist_compliance: true
---

# Phase 104: 告警系统增强 — Validation Strategy

## Critical Failure Modes

| Mode | Description | Mitigation |
|------|-------------|------------|
| F1 | threshold_type/silence_minutes silently fail to persist (same bug repeats) | Verify SELECT returns populated fields after INSERT/UPDATE in all 3 plans |
| F2 | Sliding window incorrectly groups or splits alerts | Compare alert counts before/after fix on same data |
| F3 | Toggle switch breaks other rule fields (partial update) | PUT should send full rule object; verify other fields unchanged after toggle |
| F4 | Dynamic threshold always returns null (same as current bug) | Explicit code-path check: rule.threshold_type === 'dynamic' triggers resolveDynamicThreshold |
| F5 | Three-threshold editors don't validate warning < error < critical | Client-side validation + server-side reject invalid combos |

## Validation Dimensions

### 1. Functional Correctness
- **Metric:** All 4 ROADMAP success criteria are TRUE after all 3 plans execute
- **Evidence:** Automated CRUD verification (POST → GET → PUT → GET → DELETE), threshold validation tests, toggle state persistence test

### 2. Data Integrity
- **Metric:** Zero data loss during threshold_template migration from single-threshold to three-threshold model
- **Evidence:** Pre/post comparison of alert_rules table, seed data integrity check

### 3. Event Aggregation Accuracy
- **Metric:** Alerts within 10-min window are grouped into same event; alerts >10 min apart are separate
- **Evidence:** Integration test with synthetic alert data at boundary timestamps

### 4. UI Regression Prevention
- **Metric:** Existing rule CRUD operations still work alongside new fields
- **Evidence:** Human verification checklist item in 104-03

## Validation Architecture

| Layer | What to Validate | How |
|-------|-----------------|-----|
| Database | Columns exist and persist | `DESCRIBE alert_rules` → threshold_type, dynamic_config, silence_minutes present |
| Backend API | CRUD reads/writes all fields | POST rule → GET rule → VERIFY all 3 new fields match |
| Backend Logic | Sliding window groups correctly | Unit test in event-aggregator |
| Frontend Form | 3 thresholds + toggle + threshold_type switcher | Human UAT checklist |
| Integration | Toggle persists across page reload | E2E test: toggle → reload → verify state |

## Test Strategy

### Backend (104-01)
- Verify `getAlertRules()` SELECT includes threshold_type, dynamic_config, silence_minutes
- Verify `createAlertRule()` INSERT writes all 3 columns
- Verify `updateAlertRule()` UPDATE writes all 3 columns
- Verify server.ts POST/PUT routes forward all 3 fields

### Event Aggregation (104-02)
- Verify `aggregate()` groups alerts within 10 minutes (same instance+type+metric)
- Verify `aggregate()` splits alerts >10 minutes apart
- Verify `NOT EXISTS` guard prevents re-aggregation of already-grouped alerts

### Frontend (104-03)
- Verify rule editor shows 3 independent threshold inputs
- Verify threshold_type switcher shows/hides manual threshold inputs
- Verify silence_minutes input exists and persists
- Verify toggle switch uses optimistic UI and persists
- Human verification: full CRUD workflow with new fields

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Existing rules have NULL threshold_type | High | Default to 'static' on read; migration not needed |
| threshold_template JSON shape mismatch with frontend | Medium | Validate shape on save; use fallback default |
| Sliding window performance on high alert volume | Low | 10-min window limits query scope; index on created_at exists |
