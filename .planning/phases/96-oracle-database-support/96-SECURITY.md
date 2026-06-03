---
phase: 96
slug: oracle-database-support
status: verified
threats_open: 0
asvs_level: 1
created: 2026-05-19
---

# Phase 96 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| API backend -> oracledb driver | Backend connects to Oracle using oracledb driver; credentials from encrypted storage | Database credentials |
| oracledb driver -> Oracle DB | TCP/TCPS network connection between backend and Oracle database | SQL queries, result sets |
| Browser -> CodeMirror | CodeMirror 6 runs entirely client-side; dialect definition is static TypeScript | SQL text (client-only) |
| User input -> editor state | SQL text entered by user in the editor | Query text |
| Browser -> API | Instance detail fetches metrics from backend API | Metric data via HTTP |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-96-01 | Tampering | oracledb.execute() | mitigate | Hardcoded metric queries (no user input). User SQL via sql-executor.ts uses parameterized bind params | closed |
| T-96-02 | Information Disclosure | oracledb.createPool() credentials | mitigate | Credentials encrypted via encryptData/decryptData in instance-database-service.ts | closed |
| T-96-03 | Information Disclosure | TCP connection | mitigate | TCP for local dev per D-13 allowance; TCPS available for production via wallet | closed |
| T-96-04 | Denial of Service | Connection pool exhaustion | mitigate | poolMax=4, queueMax=500, queueTimeout=60000 limits in createPool() | closed |
| T-96-05 | Tampering | Agent tool input | mitigate | ASH/AWR tools accept only instance_id + time/snap params (no raw SQL injection path) | closed |
| T-96-06 | Information Disclosure | DBA view exposure | accept | Monitoring user with DBA sees all tablespace/segment data — expected for ops tools. ALL_*/USER_* fallback when DBA_* blocked | closed |
| T-96-07 | Logic Error | checkOracleHealth() null pointer | mitigate | dbVersion/dataSizeGB properly declared; DBA_DATA_FILES query wrapped in try/catch with null fallback | closed |
| T-96-08 | Elevation of Privilege | PLAN_TABLE exploit | accept | EXPLAIN PLAN only reads execution plans; no DDL capability through explain | closed |
| T-96-09 | Tampering | CodeMirror dialect definition | accept | OracleDialect is hardcoded frontend source; no user-customizable keywords. Non-exploitable | closed |
| T-96-10 | Information Disclosure | SQL text in editor | accept | Same risk surface as existing MySQL/Dameng consoles; no new disclosure vector | closed |
| T-96-11 | Information Disclosure | Oracle instance detail data | accept | Oracle metrics shown in overview tab from existing /api/metrics endpoint; no escalation from existing data | closed |
| T-96-12 | Logic Error | Conditional form field | mitigate | Oracle identifier field uses `this.formData.db_type` Lit reactive binding; label updates automatically on db_type change | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-96-01 | T-96-06 | Monitoring users naturally see all DBA data — within scope of operations tools | Developer | 2026-05-19 |
| AR-96-02 | T-96-08 | EXPLAIN PLAN is read-only; user must already have Oracle access | Developer | 2026-05-19 |
| AR-96-03 | T-96-09 | Static frontend code — no injection surface | Developer | 2026-05-19 |
| AR-96-04 | T-96-10 | Parity with existing MySQL/Dameng console risk profile | Developer | 2026-05-19 |
| AR-96-05 | T-96-11 | Same data sensitivity as existing instance detail pages | Developer | 2026-05-19 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-05-19 | 12 | 12 | 0 | gsd-security-auditor (sonnet) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-05-19
