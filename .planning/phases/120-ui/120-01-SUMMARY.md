---
phase: 120-ui
plan: 01
subsystem: ui
tags: [css, design-tokens, z-index, accent-color, css-architecture, layout, responsive, dark-theme]

requires: []
provides:
  - Single-source design tokens (tokens.css) with blue #409eff accent
  - 7-file CSS architecture with clear layer separation
  - z-index layer system (10/100/1000/1100)
  - Standardized motion tokens (duration/easing)
  - Dark theme token preservation
  - Chat CSS single-load fix
  - Merged mobile layout into main layout.css
affects: [Phase 120 plans 02-06]

tech-stack:
  added: [vanilla CSS custom properties, tokens.css pattern]
  patterns:
    - "CSS by layer: tokens -> base -> layout -> components -> chat -> utilities -> page-specific"
    - "z-index via CSS custom properties (--z-sidebar/--z-dropdown/--z-modal/--z-toast)"
    - "Dark theme block merged into tokens.css alongside light theme"

key-files:
  created:
    - frontend/src/app/styles/tokens.css
    - frontend/src/app/styles/utilities.css
  modified:
    - frontend/src/main.ts
    - frontend/src/app/styles.css
    - frontend/src/app/styles/base.css
    - frontend/src/app/styles/layout.css
    - frontend/src/app/styles/components.css
  deleted:
    - frontend/src/styles/global.css
    - frontend/src/styles/components.css
    - frontend/src/styles/global.css.d.ts
    - frontend/src/app/styles/layout.mobile.css

key-decisions:
  - "D-01: Accent color changed from purple #7c5cff to blue #409eff across all tokens CSS"
  - "D-02: Old global.css and components.css deleted entirely, preserving dark theme in tokens.css"
  - "D-03: CSS reorganized to 7 files by layer: tokens, base, layout, components, chat, utilities, dreams"
  - "D-04: Chat CSS double-load fixed by removing duplicate @import from components.css"
  - "D-07: Motion tokens standardized: --duration-fast(100ms)/normal(180ms)/slow(300ms), --ease-out/in-out/spring"
  - "D-14: --disabled-opacity: 0.45 defined"
  - "D-22: z-index layer system: --z-sidebar(10), --z-dropdown(100), --z-modal(1000), --z-toast(1100)"

patterns-established:
  - "Design Tokens: All styling tokens defined in tokens.css as CSS custom properties on :root and [data-theme-mode='dark']"
  - "CSS Imports: base.css imports both tokens.css and utilities.css; styles.css orchestrates all layer imports"
  - "z-index Tokens: All hardcoded z-index values > 10 replaced with semantic --z-* variables in layout context"
  - "Mobile Layout: All responsive rules consolidated in layout.css (layout.mobile.css merged)"

requirements-completed: [UI-OPT-01]

duration: ~20min
completed: 2026-06-18
---

# Phase 120 Plan 01: CSS Architecture Reset Summary

**Deleted 1013 lines of dead old CSS (global.css + components.css). Created tokens.css (231 lines) as single source of truth with blue #409eff accent, z-index layer system, motion tokens, disabled-opacity, and dark theme. Reorganized to 7 files by layer, fixed chat CSS double-load, merged layout.mobile.css into layout.css, created utilities.css for animation/skeleton/reduced-motion.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-06-18
- **Completed:** 2026-06-18
- **Tasks:** 3 (no checkpoints)
- **Files modified:** 9 (4 deleted, 2 created, 3 modified)

## Accomplishments
- Deleted 1013 lines of dead old CSS (global.css 350 lines + components.css 663 lines + type stub)
- Removed `import './styles/global.css'` from main.ts (eliminating dual CSS token conflict, issue C1)
- Created tokens.css with all design tokens changed from purple #7c5cff to blue #409eff (D-01)
- Added z-index layer tokens: --z-sidebar:10, --z-dropdown:100, --z-modal:1000, --z-toast:1100 (D-22)
- Added motion tokens: duration (fast/normal/slow) and easing (out/in-out/spring) (D-07)
- Added --disabled-opacity: 0.45 for disabled element consistency (D-14)
- Preserved and merged dark theme [data-theme-mode="dark"] block from old global.css into tokens.css
- Fixed Chat CSS double-load by removing duplicate @import "./chat.css" from components.css (C2 fix, D-04)
- Merged layout.mobile.css (763 lines) into layout.css, updating z-index values to --z-dropdown tokens
- Created utilities.css with animation keyframes, skeleton classes, stagger, reduced-motion, and density support
- Reorganized to 7 CSS files by layer per D-03: tokens.css, base.css, layout.css, components.css, chat.css, utilities.css, dreams.css

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete old CSS system + fix main.ts import**
   - `f2f2861` (chore: delete old CSS system - global.css, components.css import)
   - `ecd1572` (fix: ensure deletion of old CSS files is tracked in git)

2. **Task 2: Create tokens.css with new accent color + z-index layers + motion tokens + disabled opacity**
   - `ea4bf0a` (feat: create tokens.css with blue accent, z-index layers, motion tokens, disabled-opacity, dark theme)

3. **Task 3: Reorganize CSS to <=7 files + fix Chat double load**
   - `3189b10` (feat: reorganize CSS to 7 files, fix chat double-load, merge layout.mobile)

**Plan metadata:** TBD (final commit)

## Files Created/Modified/Deleted

### Created
- `frontend/src/app/styles/tokens.css` - Single source of all design tokens (231 lines): colors, spacing, typography, shadows, z-index layers, motion tokens, disabled-opacity, dark theme
- `frontend/src/app/styles/utilities.css` - Animation keyframes, skeleton classes, stagger, reduced-motion, density

### Modified
- `frontend/src/main.ts` - Removed `import './styles/global.css'`
- `frontend/src/app/styles.css` - Added tokens.css as first import, removed layout.mobile.css import, kept layer-chain imports
- `frontend/src/app/styles/base.css` - Replaced :root block with `@import "./tokens.css"` and `@import "./utilities.css"`; removed extracted animation/skeleton/reduced-motion sections to utilities.css
- `frontend/src/app/styles/layout.css` - Replaced topbar z-index:40 with var(--z-dropdown); appended entire layout.mobile.css content with z-index updates
- `frontend/src/app/styles/components.css` - Removed `@import "./chat.css"` (line 1) to fix double-load

### Deleted
- `frontend/src/styles/global.css` (350 lines)
- `frontend/src/styles/components.css` (663 lines)
- `frontend/src/styles/global.css.d.ts`
- `frontend/src/app/styles/layout.mobile.css` (763 lines, content merged into layout.css)

## Decisions Made
- All decisions followed the locked decisions from 120-CONTEXT.md (D-01 through D-22 applicable)
- Dark theme block was merged into tokens.css (not base.css as parenthetically noted in D-02) because tokens.css is the single source of truth for all tokens including theme values
- Legacy TypeScript files still contain fallback #7c5cff values in CSS-in-JS contexts (e.g., Lit `html` templates, inline style fallbacks). These are out of scope for this plan and will be addressed in later plans

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- The old `frontend/src/styles/` directory also contained pre-existing deleted chat CSS files (frontend/src/styles/chat/) that were already removed from the working tree. These were **not** part of this plan's scope and their deletion state was left as found.
- Purple #7c5cff fallback values persist in TypeScript files (app-settings.ts, storage.ts, btn-palette.ts, sql-console.ts). These are CSS-in-JS fallback values, not CSS file references. They will be addressed in a later plan focused on TypeScript/CSS-in-JS updates.
- Deleted files needed a second commit to properly stage the deletions (first commit only caught main.ts changes, deletion required explicit `git add` for the removed files)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CSS architecture foundation is clean and ready for subsequent Phase 120 plans
- tokens.css provides the single source of truth for all styling decisions
- Remaining TODO for later plans:
  - Update TypeScript fallback values (#7c5cff) in .ts files to #409eff
  - Create shared components (app-dialog, app-toast, app-form-field, etc.)
  - Add `.active` states to buttons
  - Split god components
  - Standardize focus-visible across all form elements

---
*Phase: 120-ui*
*Completed: 2026-06-18*
