---
phase: 86-sql-console-upgrade
plan: 02
subsystem: frontend
tags: [lit-element, codemirror, multi-tab, autocomplete, localStorage, sql-console]

requires:
  - "86-01: Test infrastructure (vitest, test stubs)"
provides:
  - Multi-tab editor with independent EditorView instances per tab
  - Tab bar with create/switch/close/rename interactions
  - localStorage persistence for tabs and editor content
  - Schema-driven autocomplete with context-aware table/column suggestions
affects: [Plan 03, Plan 04, Plan 05]

tech-stack:
  added: []
  patterns:
    - "Multi-EditorView pattern: per-tab EditorView instances stored in Tab interface"
    - "localStorage persistence with json parse/stringify and corruption fallback"
    - "Inline rename via double-click with @keydown/@blur handlers"
    - "Confirmation modal for destructive tab close (Pattern 7 from users-management.ts)"
    - "Schema-driven autocomplete with matchBefore regex and dot-prefix column detection"

key-files:
  modified:
    - frontend/src/openclaw/ui/views/sql-console.ts

key-decisions:
  - "Tab.STORAGE_KEY = 'sql-console-tabs' for localStorage key"
  - "_saveTabs reads editorView.state.doc.toString() for current content, not tab.sql initial value"
  - "Tab default name: first SQL line (truncated 40 chars) or '标签 N'"
  - "Autocomplete shows SQL keywords only when no schema completions exist"
  - "Completion regex /[\\w$.一-鿿]+/ supports Chinese character matching in object names"

requirements-completed: [SQLC-01, SQLC-05]

duration: 18min
completed: 2026-05-10
---

# Phase 86 Plan 02: Multi-Tab Editor & Enhanced Autocomplete Summary

**Multi-tab editor with independent EditorView instances, localStorage persistence, inline rename, unsaved-SQL confirmation dialog, 10-tab soft cap warning, and schema-driven context-aware autocomplete**

## Performance

- **Duration:** 18 min
- **Started:** 2026-05-10T18:46:00Z
- **Completed:** 2026-05-10T19:04:00Z
- **Tasks:** 2 (merged into 1 commit — interdependent same-file changes)
- **Files modified:** 1

## Accomplishments

### Task 1: Multi-tab system (SQLC-05)
- Added `interface Tab` with `id`, `name`, `sql`, `editorView`, `result` fields
- Replaced single `private editorView` field with `@state() tabs: Tab[]` array and `activeTabId`
- Implemented `_switchTab(tabId)`: clears `.cm-wrap` container, creates or appends EditorView
- Implemented `_createTab(sql?)`: generates unique id (`tab_` + Date.now()), auto-names from first SQL line or "标签 N"
- Implemented `_closeTab(tabId, force?)`: checks for non-empty editor content, shows confirmation modal or closes immediately
- Implemented tab rename via `_startRename`/`_finishRename`: double-click label shows `<input>`, Enter/blur confirms, Escape cancels
- Added tab bar with active indicator, close button (`icons.x`), add button (`+`), and 10-tab warning message
- Added confirmation modal overlay on close-tab-with-content (Pattern 7 from users-management.ts)
- Added `_saveTabs()`/`_restoreTabs()`: localStorage key `sql-console-tabs`, `_restoreTabs` wraps JSON.parse in try/catch (T-86-02), creates default empty tab on missing/corrupted data
- Updated `_execute()`/`_directExecute()` to use `activeTab.result` per-tab instead of shared `this.result`
- Updated `getSQL()`/`setSQL()` to use `activeTab.editorView` instead of `this.editorView`
- Updated `connectedCallback()` to call `_restoreTabs()`
- Updated `firstUpdated()` to switch to first/active tab (creates initial EditorView after render)
- Added tab bar and modal CSS to existing styles block

### Task 2: Schema-driven autocomplete (SQLC-01)
- Replaced flat keyword list with context-aware filtering via `context.matchBefore(/[\w$.一-鿿]+/)`
- Table completions include `type: 'keyword'` with `detail: 'schema.table'`
- Column completions appear after `table.` prefix detection with `type: 'property'` and column type `detail`
- SQL keywords shown only when no schema completions exist (reduces noise)
- `autocompletion({ override: [this._sqlCompletions.bind(this)] })` registered on every new EditorView

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1+2  | Multi-tab editor + enhanced autocomplete | `8982c0e1fc` |

## Files Modified
- `frontend/src/openclaw/ui/views/sql-console.ts` — +284/-87 lines, now 551 lines

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed _saveTabs to persist current editor content, not initial tab.sql value**
- **Found during:** Post-implementation review
- **Issue:** `_saveTabs` was persisting `t.sql` (the initial value), not the current editor content. After user types, content lives in `editorView.state.doc.toString()`, not the initial `tab.sql` field.
- **Fix:** Changed `_saveTabs` to read `t.editorView.state.doc.toString()` when editorView exists, falling back to `t.sql` if null.
- **File modified:** `frontend/src/openclaw/ui/views/sql-console.ts`
- **Commit:** `8982c0e1fc`

## Acceptance Criteria Verification

| Criterion | Result |
|-----------|--------|
| No `private editorView: EditorView \| null = null` | PASS (0 occurrences) |
| Contains `interface Tab {` with id, name, sql, editorView, result | PASS |
| Contains `_switchTab(`, `_createTab(`, `_closeTab(`, `_startRename(`, `_finishRename(` | PASS (all found) |
| Contains `.tab-bar` CSS class | PASS |
| Contains `sql-console-tabs` string (localStorage key) | PASS |
| Contains `context.matchBefore(/[\w$.一-鿿]+/)` | PASS (line 272) |
| Contains `{ from, options: completions }` return | PASS (line 322) |
| Contains table completions with `type: 'keyword'` and schema.table `detail` | PASS |
| Contains column completions with `type: 'property'` and column type `detail` | PASS |
| Registers `autocompletion({ override: [...] })` in each EditorView | PASS |
| Contains `@customElement("sql-console-page")` and existing imports | PASS |
| File is at least 480 lines | PASS (551 lines) |
| `npx vitest run` discovers all 18 tests (RED state) | PASS |

## Issues Encountered

**Pre-existing build error.** `npx vite build` fails due to a missing file `./views/instances-db.ts` referenced by `app-render.ts`. This is unrelated to the sql-console.ts changes and is out of scope per the deviation rules.

## Stub Tracking

No new stubs introduced. The test stubs (18 RED tests from Plan 01) remain — they will resolve as Plans 03-05 implement the remaining features.

## Threat Surface Scan

No new threat surface found. The plan's threat model (T-86-02 localStorage tampering, T-86-03 autocomplete disclosure) is fully addressed:
- T-86-02: `_restoreTabs` wraps `JSON.parse` in try/catch with fallback to fresh state
- T-86-03: Schema data was already public to authenticated users — accepted per plan

## Self-Check: PASSED

- File `frontend/src/openclaw/ui/views/sql-console.ts` exists and is 551 lines
- Commit `8982c0e1fc` exists in git log
- All acceptance criteria patterns verified above
- `npx vitest run` discovers all 18 tests (RED stubs as expected)

---
*Phase: 86-sql-console-upgrade*
*Completed: 2026-05-10*
