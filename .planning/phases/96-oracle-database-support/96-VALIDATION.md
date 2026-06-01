---
phase: 96
slug: 96-oracle-database-support
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-19
---

# Phase 96 — Oracle Database Support Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (backend: node env, frontend: jsdom env) |
| **Config file** | `apps/db-ops-api/vitest.config.ts`, `frontend/vitest.config.ts` |
| **Quick run command** | `cd apps/db-ops-api && npx vitest run src/__tests__/` ; `cd frontend && npx vitest run src/openclaw/ui/views/__tests__/` |
| **Full suite command** | `cd apps/db-ops-api && npx vitest run` ; `cd frontend && npx vitest run` |
| **Estimated runtime** | ~1s (48 tests across 6 files) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/__tests__/` (backend) / `npx vitest run src/openclaw/ui/views/__tests__/` (frontend)
- **After every plan wave:** Full suite must be green
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 96-01-01 | 01 | 1 | D-01, D-02 | T-96-01, T-96-02 | Oracle backend wiring | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/metric-registry.test.ts src/__tests__/oracle-database-service.test.ts` | yes | green |
| 96-01-02 | 01 | 1 | D-01, D-02, D-12, D-13 | T-96-02, T-96-03 | metric-registry + testConnection | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/metric-registry.test.ts` | yes | green |
| 96-01-03 | 01 | 1 | D-09, D-10, D-11 | T-96-05 | Agent tool enums + params | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/oracle-agent-tools.test.ts` | yes | green |
| 96-02-01 | 02 | 1 | D-04, D-05, D-06 | T-96-09 | OracleDialect + switching + autocomplete | unit | `cd frontend && npx vitest run src/openclaw/ui/views/__tests__/oracle-dialect.test.ts` | yes | green |
| 96-02-02 | 02 | 1 | D-07, D-08, D-12 | T-96-12 | Form field + overview cards | unit | `cd frontend && npx vitest run src/openclaw/ui/views/__tests__/oracle-instance-form.test.ts src/openclaw/ui/views/__tests__/oracle-instance-detail.test.ts` | yes | green |
| 96-03-01 | 03 | 2 | WR-01, WR-02 | T-96-07 | V$SYSSTAT fix + DBA fallback | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/oracle-database-service.test.ts` | yes | green |
| 96-03-02 | 03 | 2 | CR-01 | T-96-05 | ASH parameter name fix | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/oracle-agent-tools.test.ts` | yes | green |
| 96-03-03 | 03 | 2 | CR-03 | — | Null-safe tablespace guard | unit | `cd frontend && npx vitest run src/openclaw/ui/views/__tests__/oracle-instance-detail.test.ts` | yes | green |
| 96-04-01 | 04 | 2 | D-13, D-17 | T-96-03 | sslOptions/fetchAs module mutation fix | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/oracle-database-service.test.ts` | yes | green |
| 96-04-02 | 04 | 2 | D-13 | T-96-03 | testConnection sslOptions removal | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/oracle-database-service.test.ts` | yes | green |

*Status: green = passing, red = failing, pending = not yet run*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No Wave 0 install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Oracle connection via TCPS + createPool | D-13, D-14 | Requires real Oracle 19c Docker container | UAT Test 1: Add Oracle instance, verify connection succeeds with health_score |
| SQL Console Oracle dialect rendering | D-04, D-05 | CodeMirror rendering requires browser DOM | UAT Test 2: Open SQL console with Oracle instance, verify PL/SQL highlighting |
| Instance detail overview cards display | D-08 | Requires real metrics from Oracle backend | UAT Test 3: Open Oracle instance detail, verify version/SGA/PGA/tablespace cards |
| ASH/AWR report generation | D-10, D-11 | Requires Oracle Enterprise Edition + Diagnostics Pack | Run oracle_ash_report / oracle_awr_report tools against Oracle instance |
| Tablespace detail query | D-10 | Requires DBA privileges on Oracle | Run oracle_tablespace_detail tool against Oracle instance |
| Frontend E2E Oracle instance add flow | D-12 | Requires full frontend+backend integration | UAT Test 1: Add Oracle instance through UI form |

---

## Validation Audit 2026-05-19

| Metric | Count |
|--------|-------|
| Gaps found | 10 |
| Resolved | 10 |
| Escalated | 0 |

### Tests Created

| # | File | Tests |
|---|------|-------|
| 1 | `apps/db-ops-api/src/__tests__/metric-registry.test.ts` | 8 |
| 2 | `apps/db-ops-api/src/__tests__/oracle-agent-tools.test.ts` | 7 |
| 3 | `apps/db-ops-api/src/__tests__/oracle-database-service.test.ts` | 17 |
| 4 | `frontend/src/openclaw/ui/views/__tests__/oracle-dialect.test.ts` | 9 |
| 5 | `frontend/src/openclaw/ui/views/__tests__/oracle-instance-form.test.ts` | 4 |
| 6 | `frontend/src/openclaw/ui/views/__tests__/oracle-instance-detail.test.ts` | 3 |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-19
