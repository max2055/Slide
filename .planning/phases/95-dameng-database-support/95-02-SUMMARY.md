---
phase: 95-dameng-database-support
plan: 02
subsystem: frontend
tags: [codemirror, dameng, sql, dialect, highlight, autocomplete]

requires:
  - phase: 86-sql-console-upgrade
    provides: CodeMirror 6 SQL console with tab management, schema browser, result display
provides:
  - Dameng DM8 SQL dialect for CodeMirror with V$DM_* views, DM_SQL_* functions, and case-insensitive identifier handling
  - Dialect switching logic — editor uses DamengDialect when instance db_type is dameng, MySQL otherwise

tech-stack:
  added: []
  patterns:
    - "SQLDialect.define() for custom database dialect"
    - "Dialect selection based on instance db_type at editor creation time"

key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/views/sql-console.ts

key-decisions:
  - "DamengDialect uses SQLDialect.define() with full DM8 keywords, V$DM_* builtins, and caseInsensitiveIdentifiers: true"
  - "Dialect is set at editor creation time based on selectedInstance.db_type — no dynamic dialect switching for existing editors"
  - "Dameng keywords are upper-cased (upperCaseKeywords: true) while MySQL remains lower-case"

requirements-completed:
  - DB-01

duration: 5min
completed: 2026-05-18
---

# Phase 95 Plan 02: Dameng SQL Dialect for CodeMirror Summary

**Dameng DM8 SQL dialect for CodeMirror 6 using SQLDialect.define() with full keyword set, V$DM_* system views, DM_SQL_* functions, and dialect switching based on instance db_type**

## Performance

- **Duration:** 5min
- **Started:** 2026-05-18T00:54:00Z
- **Completed:** 2026-05-18T00:59:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Defined `DamengDialect` using `SQLDialect.define()` with full DM8 keyword set (400+ SQL reserved words), system view builtins (V$DM_*), data type types, and configuration flags
- Integrated the dialect into `_switchTab()` — when `instance.db_type === 'dameng'`, the editor uses `DamengDialect` with `upperCaseKeywords: true`; otherwise falls back to `MySQL` with default casing
- Set `caseInsensitiveIdentifiers: true` per RESEARCH.md Pitfall 4 (Dameng identifiers are case-insensitive by default)
- Configured `plsqlQuotingMechanism: true`, `doubleQuotedStrings: false`, `identifierQuotes: '"[]'` for Dameng's Oracle-compatible quoting behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Define DamengDialect + dialect switching in sql-console.ts** - `27adc7de54f` (feat)

## Files Created/Modified

- `frontend/src/openclaw/ui/views/sql-console.ts` - Added DamengDialect definition (~80 lines) and dialect switching logic in _switchTab (~3 lines)

## Decisions Made

- **Dialect selection at editor creation time**: The dialect is determined when `EditorState.create()` runs in `_switchTab()`. Editors are not dynamically re-created on instance change — this matches existing behavior (even MySQL editors keep their dialect from creation time). The dialect will update when a new tab is created or on page reload with a Dameng instance selected.
- **No changes to autocompletion**: The existing `sqlCompletionSource` (implemented as `_sqlCompletions`) already provides schema-aware completions. CodeMirror's built-in SQL completion adapts to the dialect for keyword completion. No additional changes needed.
- **No changes to execution/explain/schema-browser/CSS**: All existing functionality remains untouched per plan constraints.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Threat Surface Scan

No new threat surface introduced. The dialect definition is hardcoded frontend source code (matching accepted risks T-95-04/T-95-05 from the threat model).

## Next Phase Readiness

- Dameng SQL dialect is ready for the SQL console. When a Dameng instance is selected, the editor will use DM8-appropriate syntax highlighting with V$DM_* and DM_SQL_* identifiers correctly highlighted.
- Phase 95 Plan 03 (or the next plan) can now integrate the backend Dameng connection/driver changes.

---
*Phase: 95-dameng-database-support*
*Completed: 2026-05-18*
