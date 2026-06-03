---
phase: 96-oracle-database-support
plan: 02
subsystem: frontend
tags: [oracle, frontend, codemirror, dialect, instance-detail, form]
dependency_graph:
  requires: [plan-01-backend]
  provides: [oracle-frontend-touchpoints]
  affects: []
tech-stack:
  added: [OracleDialect via @codemirror/lang-sql SQLDialect.define]
  patterns: [dialect-switching-via-db_type, conditional-form-field-lit-reactive]
key-files:
  modified:
    - frontend/src/openclaw/ui/views/sql-console.ts
    - frontend/src/openclaw/ui/views/instances-db.ts
    - frontend/src/openclaw/ui/views/instance-detail.ts
decisions:
  - "OracleDialect structure aligned to DamengDialect pattern (SQLDialect.define + keywords/builtin/types)"
  - "upperCaseKeywords: true for Oracle (matching Oracle documentation convention)"
  - "caseInsensitiveIdentifiers: true (Oracle is case-insensitive by default, per RESEARCH Pitfall 4)"
  - "PL/SQL keyword set includes: PACKAGE, PROCEDURE, FUNCTION, EXCEPTION, CURSOR, BULK, FORALL, RETURNING, PIPELINED"
  - "builtin set includes: V$*, DBA_*, ALL_*, USER_* views + Oracle functions (NVL, DECODE, TO_CHAR, TO_DATE, etc.) + DBMS_*, UTL_* packages"
  - "Add-instance form field uses Lit reactive binding (this.formData.db_type) for label/placeholder/hint switching on db_type change"
  - "Oracle overview cards placed within existing overview-grid (no new tabs per D-07)"
  - "Tablespace usage card uses color coding: green < 80%, orange 80-90%, red >= 90%"
metrics:
  completed_date: "2026-05-19"
---

# Phase 96 Plan 02: Oracle Frontend Touchpoints Summary

**One-liner:** Added Oracle PL/SQL CodeMirror dialect with dialect switching, conditional Oracle database identifier field to add-instance form, and Oracle-specific overview cards (version, SGA, PGA, tablespace usage) to instance detail page.

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | feat(96): add Oracle PL/SQL CodeMirror dialect with dialect switching | c02d774237a | frontend/src/openclaw/ui/views/sql-console.ts |
| 2 | feat(96): add Oracle identifier form field and instance detail overview cards | c619c61e22e | frontend/src/openclaw/ui/views/instances-db.ts, frontend/src/openclaw/ui/views/instance-detail.ts |

## Artifacts by File

### sql-console.ts

**OracleDialect definition (D-04):** Defined a full Oracle PL/SQL dialect via `SQLDialect.define()` after the existing DamengDialect definition. Contains:

- **keywords:** ~300 PL/SQL keywords including PACKAGE, PROCEDURE, FUNCTION, DECLARE, BEGIN, EXCEPTION, CURSOR, BULK COLLECT, FORALL, RETURNING, PIPELINED, AUTONOMOUS_TRANSACTION, PRAGMA, VARRAY, NESTED TABLE, and all standard SQL keywords.
- **builtin:** ~200 entries including Oracle functions (NVL, DECODE, TO_CHAR, TO_DATE, TO_NUMBER, SUBSTR, INSTR, etc.), V$* system views (V$SESSION, V$SQL, V$SGA, V$PGASTAT, V$SQLAREA, V$LOCK, etc.), DBA_* views (DBA_TABLESPACES, DBA_DATA_FILES, DBA_SEGMENTS, DBA_HIST_*), ALL_*/USER_* views, and DBMS_*/UTL_* packages.
- **types:** Oracle data types (VARCHAR2, NUMBER, CLOB, BLOB, BINARY_FLOAT, BINARY_DOUBLE, PLS_INTEGER, SYS_REFCURSOR, XMLTYPE, etc.)
- `plsqlQuotingMechanism: true` (supports `q'[delimiter]...'` syntax)
- `caseInsensitiveIdentifiers: true` (Oracle is case-insensitive by default)
- `identifierQuotes: '"'` (Oracle uses double quotes for quoted identifiers)

**Dialect switching (D-05):** Updated the existing `_switchTab` method. The dialect selection logic now checks `db_type === 'oracle'` first (before dameng):

```typescript
const selectedDialect = instance?.db_type === 'oracle' ? OracleDialect
  : instance?.db_type === 'dameng' ? DamengDialect
  : MySQL;
```

Sets `upperCaseKeywords: true` for both Oracle and Dameng dialects (matching their documentation convention).

**Autocomplete (D-06):** Autocomplete works via the existing `sqlCompletionSource` (set up via `autocompletion({ override: [this._sqlCompletions.bind(this)] })`). The dialect's extensive builtin entries (V$*, DBA_*, ALL_*, USER_* views + Oracle functions) are automatically available for autocomplete suggestions when OracleDialect is active. No additional changes needed.

**No changes to:** SQL execution logic, explain plan logic, result display, schema browser, CSS styles, or non-Oracle dialect behavior.

### instances-db.ts

**Conditional Oracle database identifier field (D-12):** The existing "数据库名" form field now conditionally renders different labels, placeholders, and hints based on `this.formData.db_type`:

| Element | Default (non-Oracle) | Oracle (db_type === 'oracle') |
|---------|---------------------|-------------------------------|
| Label | 数据库名 | Oracle 数据库标识 (SID/Service Name) |
| Placeholder | 默认数据库名 | 如：ORCL 或 pdb1.subnet.vcn.oraclevcn.com |
| Hint | 连接后默认使用的数据库 | 用于 Easy Connect 格式的数据库标识，支持 SID 或 Service Name |

Uses Lit's reactive `this.formData.db_type` binding — when the user selects "Oracle" in the db_type dropdown, the field updates automatically.

### instance-detail.ts

**MetricsData interface update:** Added 8 Oracle-specific optional fields:
- `sga_size_mb?: number` — SGA size in MB
- `pga_size_mb?: number` — PGA size in MB
- `tablespace_usage_percent?: number` — Tablespace usage percentage
- `library_cache_hit_rate?: number` — Library cache hit rate
- `pga_cache_hit_rate?: number` — PGA cache hit rate
- `shared_pool_hit_rate?: number` — Shared pool hit rate
- `active_sessions?: number` — Active session count
- `enqueue_deadlocks?: number` — Enqueue deadlock count

**Oracle overview cards (D-08):** Conditionally rendered inside the existing overview-grid when `inst.db_type === 'oracle'`:

1. **Oracle 版本** — Displays `this.metrics.version` with word-break for long version strings
2. **SGA 大小** — Displays `this.metrics.sga_size_mb` with "MB" suffix
3. **PGA 大小** — Displays `this.metrics.pga_size_mb` with "MB" suffix
4. **表空间使用率** — Displays `this.metrics.tablespace_usage_percent` with color coding:
   - Green (< 80%): class `ok`
   - Orange (80-90%): class `warn`
   - Red (>= 90%): class `danger`

All cards only render when the corresponding metric value is present (ensuring graceful degradation if backend doesn't return Oracle-specific fields). Non-Oracle instances are completely unaffected (D-07: no new tabs).

## Deviations from Plan

### Scope Boundaries Respected

- Did NOT add Oracle-specific metric cards to the real-time metrics section (the plan considered this but decided to keep Oracle changes focused on the overview-grid only)
- Did NOT modify: tab structure (no new tabs per D-07), CSS styles, non-Oracle instance behavior, health status/score logic, capacity/topsql/sessions tabs
- Did NOT modify MySQL, PostgreSQL, or Dameng instance behavior in any way

## Success Criteria

- [x] OracleDialect defined in sql-console.ts via SQLDialect.define() with complete PL/SQL keywords, V$*/DBA_* system views, and Oracle functions (D-04)
- [x] Dialect switching works: Oracle instances get PL/SQL highlighting, other types unchanged (D-05)
- [x] Autocomplete includes V$*/DBA_* views when OracleDialect is active (D-06)
- [x] Add-instance form shows Oracle database identifier field (label + placeholder + hint) when db_type === 'oracle' (D-12)
- [x] Instance detail overview tab shows Oracle version + SGA size + PGA size + tablespace usage (D-08)
- [x] No new Oracle-specific tabs created -- all info within existing overview tab (D-07)
- [x] MySQL, PostgreSQL, Dameng instances completely unaffected

## Self-Check: PASSED

All verification grep checks passed:
- `OracleDialect` defined and used in sql-console.ts
- `SQLDialect.define` present (OracleDialect definition)
- `caseInsensitiveIdentifiers: true` set
- `'oracle'` db_type dispatch in dialect selection
- `sga_size_mb`, `pga_size_mb`, `tablespace_usage_percent` in instance-detail.ts
- `SID/Service Name` conditional label in instances-db.ts
- No TypeScript compilation errors in modified files (all errors are pre-existing)
