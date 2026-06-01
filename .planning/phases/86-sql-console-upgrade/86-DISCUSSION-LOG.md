# Phase 86: SQL Console Upgrade - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 86-sql-console-upgrade
**Areas discussed:** Multi-tab behavior, Result table interaction, Query history design, EXPLAIN visualization

---

## Multi-tab Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Shared instance, independent state | All tabs share instance, each has own editor + results | ✓ |
| Fully independent tabs | Each tab has own instance + editor + results | |

**User's choice:** Shared instance across tabs, each with independent editor state and result set.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, save to localStorage | Tab list, instance, editor content persist across reloads | ✓ |
| No, start fresh each visit | Every load starts with single empty tab | |

**User's choice:** Persist tabs and editor content to localStorage. Results reset on reload.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Confirm with dialog | Show confirmation when closing tab with unsaved SQL | ✓ |
| Just close silently | No confirmation, immediate close | |

**User's choice:** Confirmation dialog for tabs with non-empty editor content.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Soft cap ~10 tabs + rename | Limit ~10 with warning, double-click to rename, × to close | ✓ |
| Unlimited tabs, no rename | No cap, auto-labeled by query preview | |

**User's choice:** Soft cap of ~10 tabs, double-click rename, × button to close.

---

## Result Table Interaction

| Option | Description | Selected |
|--------|-------------|----------|
| Click to cycle asc → desc → none | Arrow indicator (▲/▼) in sorted column header | ✓ |
| Click toggles asc/desc, right-click to clear | Separate clear mechanism | |

**User's choice:** Three-state sort cycle with arrow indicator in column header.

---

| Option | Description | Selected |
|--------|-------------|----------|
| 25 / 50 / 100 / All | Default 50, All renders full result set | ✓ |
| 10 / 25 / 50 / 100 | No "All" option | |

**User's choice:** Four presets including All, default 50.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, reset to defaults | New results clear sort and reset to page 1 | ✓ |
| Keep sort/page if columns match | Preserve state across re-executions | |

**User's choice:** Reset sort and pagination on query re-execution.

---

| Option | Description | Selected |
|--------|-------------|----------|
| "1-50 of 1,234 rows" | Page range + total with nav controls | ✓ |
| "1,234 rows" only | Total only, no page range | |

**User's choice:** Page range and total in header bar.

---

## Query History Design

| Option | Description | Selected |
|--------|-------------|----------|
| Toggleable sidebar replacing schema browser | Tab/toggle switches between Schema and History views | ✓ |
| Slide-out drawer from right | Overlay drawer, keeps schema visible | |
| Modal dialog | Large modal with search and list | |

**User's choice:** Left sidebar toggle between Schema browser and History panel.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Full-text search on SQL + filter by instance | Search box + instance dropdown filter | ✓ |
| Full-text search only | Single search box, no instance filter | |

**User's choice:** Search by SQL text with instance filter dropdown.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Load SQL into current active tab | Replace editor content of selected tab | ✓ |
| Open in a new tab | Create new tab with historical SQL pre-loaded | |

**User's choice:** Click loads SQL into the currently active tab.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Last 200 items, scroll-loaded | Infinite scroll, no time-based expiry | ✓ |
| Last 30 days, paginated | Date-range based with page controls | |

**User's choice:** Most recent 200 items, infinite scroll loading.

---

## EXPLAIN Visualization

| Option | Description | Selected |
|--------|-------------|----------|
| Both tree + table, toggleable | Default tree view, toggle to flat table with sortable columns | ✓ |
| Tree view only | Collapsible nested tree | |
| Table view only | Flat table with operation/cost/rows columns | |

**User's choice:** Both tree (default) and table views, toggleable.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Inline in results area, replacing data table | EXPLAIN renders in same panel, "Back to results" link to return | ✓ |
| Separate tab within results panel | Results and Explain Plan sub-tabs | |
| Modal dialog | Large modal overlay | |

**User's choice:** Inline in results area with back link to data view.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-run on current SQL | Click EXPLAIN button, immediately sends SQL to explain endpoint | ✓ |
| Open dialog to confirm/edit SQL | Shows SQL for review before running | |

**User's choice:** Auto-run without confirmation dialog.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Summary bar above the tree | Total cost, rows examined, efficiency grade at a glance | ✓ |
| Just the tree, no summary | Let users interpret the plan themselves | |

**User's choice:** Summary bar with cost, rows, and efficiency grade.

---

## Claude's Discretion

- Tab default naming (auto-generate from first SQL line or "Tab 1, Tab 2...")
- localStorage key structure for tab persistence
- Sort implementation details (in-memory array sort, type coercion for mixed data)
- CSV export implementation (client-side Blob download, filename format, CSV cell escaping)
- EXPLAIN tree component (recursive Lit template for nested JSON plan nodes)
- History API endpoint design (new endpoint or reused audit_log query)
- Efficiency grade heuristics for EXPLAIN summary bar
- Empty/loading/error state designs for all new components

## Deferred Ideas

- 自动 AI 分析结果在告警列表中不可见 — reviewed, not folded (AI/alert area, not SQL Console scope)
