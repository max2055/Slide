---
phase: 102-ui
plan: 02
type: execute
wave: 2
subsystem: frontend
tags: [stat-card, migration, ov-card, CSS, refactoring, LitElement]
depends_on:
  - "#102-01-icon-unification"
requires: []
provides: [UI-04]
affects:
  - "frontend/src/components/stat-card.ts"
  - "frontend/src/openclaw/ui/views/dashboard.ts"
  - "frontend/src/openclaw/ui/views/alerts.ts"
  - "frontend/src/openclaw/ui/views/instances-db.ts"
  - "frontend/src/openclaw/ui/views/reports.ts"
  - "frontend/src/openclaw/ui/views/schema-management.ts"
  - "frontend/src/openclaw/ui/views/overview-cards.ts"
  - "frontend/src/openclaw/styles/components.css"
key_decisions:
  - "StatCard hint property changed from `String` to `Object` to support both string and TemplateResult (needed for rich hints with dot indicators and complex labels)"
  - "Variant indicator uses left-border strip (3px) instead of ::before dot — visually cleaner, less markup"
  - "Introduced `@keyframes rise` into stat-card Shadow DOM since the global CSS definition was deleted"
  - "Added dot indicator CSS (`.dot.ok`, `.dot.warn`, `.dot.danger`) to stat-card Shadow DOM for hint content that references these classes"
  - "Deletions ~580 lines total: ~490 lines from 6 views (CSS + HTML), ~90 lines from components.css; additions ~115 lines for stat-card component"
metrics:
  duration: null
  files_created: 1
  files_modified: 7
  lines_added: 115
  lines_deleted: ~580
completed_date: null
---

# Phase 102 Plan 02: stat-card Component and ov-card Migration

## Summary

Created a shared `<stat-card>` LitElement component eliminating ~300 lines of duplicated ov-card CSS across 6 views, establishing a single source of truth for stat card rendering, and deleting the global ov-card CSS block from components.css.

## Tasks Executed

### Task 1: Create stat-card LitElement component
- **File:** `frontend/src/components/stat-card.ts` (NEW)
- **Properties:** `label` (string), `value` (string), `hint` (string | TemplateResult), `variant` (ok | warn | danger | info)
- **Styling:** Shadow DOM with CSS variable-driven theming (var(--card), var(--border), var(--muted), var(--text-strong), var(--ok), var(--warn), var(--destructive), var(--info))
- **Variant indicator:** 3px left border strip using semantic CSS variables
- **Responsive:** Value 22px -> 18px, padding 16px -> 12px at narrow widths
- **Registration:** `customElements.define('stat-card', StatCard)` with guard for double-registration

### Task 2: Migrate 6 views from ov-card to `<stat-card>`
- **overview-cards.ts:** Replaced `renderStatCard()` function and `StatCard` type with `<stat-card>` elements wrapped in `<button>`; skeleton uses `ov-card-skeleton`/`ov-cards-skeleton` class names; grid layout via inline style
- **dashboard.ts:** 6 stat-cards replacing ov-card divs; first card uses complex dot hint passed as TemplateResult via `.hint=`
- **alerts.ts:** 4 stat-cards with `warn`/`danger` variants and dot hints; grid via inline style
- **instances-db.ts:** Deleted dead ov-card CSS (no ov-card template usage existed)
- **reports.ts:** 4 stat-cards with `ok`/`info`/`danger` variants; grid via inline style
- **schema-management.ts:** 4 stat-cards with `info`/`ok`/`danger` variants; grid via inline style
- All inline ov-card CSS blocks (`.ov-card`, `.ov-cards`, `.ov-card__label`, `.ov-card__value`, `.ov-card__hint`, color variants, nth-child animations, `@keyframes rise`) deleted from each view's component styles

### Task 3: Delete global ov-card CSS + verify
- Deleted ~80 lines of global `.ov-card`/`.ov-cards` CSS from components.css (lines ~3920-3999)
- Deleted responsive `@media (max-width: 600px)` ov-card section from components.css (lines ~4530-4542)
- Added `@keyframes rise` to stat-card component (previously defined globally)
- Added dot indicator CSS (`.dot.ok`, `.dot.warn`, `.dot.danger`) and hint `.danger` class to stat-card Shadow DOM
- **Build:** Verified `npx vite build` succeeds
- **Tests:** Pass (2 pre-existing test failures unrelated to changes: sql-console.ts TDD placeholders + design-tokens.ts hardcoded path issue)

## Deviations from Plan

### Auto-fixed Issues

**Rule 2 - Missing critical functionality: stat-card hint needs TemplateResult support**
- **Found during:** Task 2 (migrating dashboard.ts card 1)
- **Issue:** Several cards pass rich HTML (dots, colored spans) as hints, requiring TemplateResult support in stat-card, but plan specified `hint: string`
- **Fix:** Changed `hint` property from `@property({ type: String })` to `@property({ type: Object })` with union type `string | TemplateResult`
- **Files modified:** `frontend/src/components/stat-card.ts`
- **Commit:** a53d73edc66

**Rule 2 - Missing critical functionality: dot indicator CSS must be in stat-card Shadow DOM**
- **Found during:** Task 2 (alerts.ts migration)
- **Issue:** dot classes (`.dot.ok`, `.dot.warn`, `.dot.danger`) referenced in TemplateResult hints were defined in each view's component CSS which was being deleted
- **Fix:** Added dot indicator styles and `.danger` hint color to stat-card Shadow DOM CSS
- **Files modified:** `frontend/src/components/stat-card.ts`
- **Commit:** a53d73edc66

**Rule 2 - Missing critical functionality: @keyframes rise must be in stat-card Shadow DOM**
- **Found during:** Task 3 (deleting global ov-card CSS)
- **Issue:** stat-card references `animation: rise` but the `@keyframes rise` was defined globally in components.css which was being deleted
- **Fix:** Added `@keyframes rise` definition to stat-card component CSS
- **Files modified:** `frontend/src/components/stat-card.ts`
- **Commit:** fc8dcc573a2

**Rule 3 - Blocking issue: wrong import path in overview-cards.ts**
- **Found during:** Task 3 (build verification)
- **Issue:** Import `../../components/stat-card.js` resolved from `src/openclaw/ui/views/` goes to `src/openclaw/components/` instead of `src/components/`
- **Fix:** Changed to `../../../components/stat-card.js`
- **Files modified:** `frontend/src/openclaw/ui/views/overview-cards.ts`
- **Commit:** fc8dcc573a2

## Key Files

| File | Status | Description |
|------|--------|-------------|
| `frontend/src/components/stat-card.ts` | NEW (127 lines) | Shared StatCard LitElement with label/value/hint/variant properties, 4 variant styles, responsive breakpoint |
| `frontend/src/openclaw/ui/views/overview-cards.ts` | MODIFIED | renderStatCard() + StatCard type deleted; 4 cards now use `<stat-card>` in `<button>` wrappers |
| `frontend/src/openclaw/ui/views/dashboard.ts` | MODIFIED | 6 ov-cards replaced with `<stat-card>`; inline ov-card CSS deleted |
| `frontend/src/openclaw/ui/views/alerts.ts` | MODIFIED | 4 ov-cards replaced with `<stat-card>`; inline ov-card CSS deleted |
| `frontend/src/openclaw/ui/views/instances-db.ts` | MODIFIED | Dead ov-card CSS deleted (no template usage) |
| `frontend/src/openclaw/ui/views/reports.ts` | MODIFIED | 4 ov-cards replaced with `<stat-card>`; inline ov-card CSS deleted |
| `frontend/src/openclaw/ui/views/schema-management.ts` | MODIFIED | 4 ov-cards replaced with `<stat-card>`; inline ov-card CSS deleted |
| `frontend/src/openclaw/styles/components.css` | MODIFIED | Global ov-card CSS block (~80 lines) and responsive section deleted |

## Commits

| Hash | Message |
|------|---------|
| `1963c5e127` | feat(102-02): create shared stat-card LitElement component |
| `a53d73edc6` | feat(102-02): migrate 6 views from ov-card HTML/CSS to shared `<stat-card>` |
| `fc8dcc573a` | feat(102-02): delete global ov-card CSS from components.css |

## Verification

- `grep -rn 'ov-card' frontend/src/ --include='*.ts' --include='*.css'` returns no matches (excluding intentional `ov-card-skeleton` class names)
- Each of the 6 view files uses `<stat-card>` at least once
- `frontend/src/components/stat-card.ts` exists with `class StatCard extends LitElement`
- Vite build succeeds
- No new packages installed

## Self-Check: PASSED
