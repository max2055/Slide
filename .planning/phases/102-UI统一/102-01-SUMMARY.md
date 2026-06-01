---
phase: 102-ui
plan: 01
subsystem: frontend
tags: [icons, ui, refactor]
requires: []
provides: [canonical-icon-file]
affects: [frontend]
tech-stack:
  added: []
  patterns: [kebab-case-icon-naming, canonical-icon-source]
key-files:
  created:
    - frontend/src/icons.ts
  modified:
    - frontend/src/components/AppHeader.ts
    - frontend/src/components/AppLayout.ts
    - frontend/src/components/AppSidebar.ts
    - frontend/src/components/InstanceDetailLayout.ts
    - frontend/src/openclaw/ui/app-render.helpers.ts
    - frontend/src/openclaw/ui/app-render.ts
    - frontend/src/openclaw/ui/navigation.ts
    - frontend/src/openclaw/ui/tool-display.ts
    - frontend/src/openclaw/ui/chat/copy-as-markdown.ts
    - frontend/src/openclaw/ui/chat/grouped-render.ts
    - frontend/src/openclaw/ui/chat/slash-commands.ts
    - frontend/src/openclaw/ui/chat/tool-cards.ts
    - frontend/src/openclaw/ui/views/agents-panels-status-files.ts
    - frontend/src/openclaw/ui/views/alerts.ts
    - frontend/src/openclaw/ui/views/chat.ts
    - frontend/src/openclaw/ui/views/command-palette.ts
    - frontend/src/openclaw/ui/views/config-form.node.ts
    - frontend/src/openclaw/ui/views/config-form.render.ts
    - frontend/src/openclaw/ui/views/config.ts
    - frontend/src/openclaw/ui/views/dashboard.ts
    - frontend/src/openclaw/ui/views/instance-detail.ts
    - frontend/src/openclaw/ui/views/instances-db.ts
    - frontend/src/openclaw/ui/views/login-gate.ts
    - frontend/src/openclaw/ui/views/markdown-sidebar.ts
    - frontend/src/openclaw/ui/views/overview-attention.ts
    - frontend/src/openclaw/ui/views/overview-event-log.ts
    - frontend/src/openclaw/ui/views/overview-log-tail.ts
    - frontend/src/openclaw/ui/views/overview.ts
    - frontend/src/openclaw/ui/views/reports.ts
    - frontend/src/openclaw/ui/views/schema-management.ts
    - frontend/src/openclaw/ui/views/sessions.ts
    - frontend/src/openclaw/ui/views/sql-console.ts
    - frontend/src/openclaw/ui/views/instance-detail-diagnosis.test.ts
  deleted:
    - frontend/src/openclaw/ui/icons.ts
    - frontend/src/styles/icons.ts
decisions:
  - Unified all icons into single file frontend/src/icons.ts with kebab-case naming
  - Chose styles/icons.ts SVG attributes (complete) as source of truth for same-name icons
  - Omitted renderEmojiIcon/setEmojiIcon (confirmed dead code via grep)
  - renderIcon default className changed from 'nav-item__icon' to 'icon'
metrics:
  duration: ~8 minutes
  completed_date: 2026-05-21
---

# Phase 102 Plan 01: Icon Unification — SUMMARY

**Objective achieved.** Created canonical merged icon file `frontend/src/icons.ts` with 111 kebab-case icons, updated all ~33 import paths, batch-renamed all camelCase icon references to kebab-case bracket notation, and deleted the two old icon files.

## Outcomes

### Merged Icon File (`frontend/src/icons.ts`)
- 111 icon definitions in kebab-case, alphabetically sorted
- All SVGs include `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`
- 4 API exports: `icons`, `IconName`, `icon()`, `renderIcon()`
- 8 previously-missing icons added: `bell-off`, `party-popper`, `calendar`, `pause`, `alert-circle`, `x-circle`, `message-square`, `layout-dashboard`
- Special case preserved: `lobster` with gradient fill and defs
- `Zap`/`zap` deduped (kept lowercase `zap`)
- `renderEmojiIcon`/`setEmojiIcon` omitted (confirmed dead code)

### Import Path Migration
- components/ (`../icons.js`)
- views/, chat/ (`../../../icons.js`)
- openclaw/ui/ (`../../icons.js`)
- All `icons.X` dot-access converted to `icons['X']` bracket notation
- All camelCase icon names converted to kebab-case
- Special mappings: `alertTriangle` -> `triangle-alert`, `history` -> `clock`, `user` -> `users`
- `config-form.node.ts` alias `sharedIcons` preserved

### Verification
- `grep -rn 'icons\.' src/ --include='*.ts'`: 0 remaining camelCase dot-access patterns
- `grep -rn 'from.*openclaw/ui/icons\|from.*styles/icons'`: 0 remaining old import paths
- `grep -rn 'renderEmojiIcon\|setEmojiIcon'`: 0 remaining references
- Vite build: succeeds in 2.58s
- Vitest: 218 passing, 19 pre-existing failures (sql-console RED placeholders + design-tokens edge case)

## Deviations from Plan

### Rule 1 — Bug: InstanceDetailLayout.ts `layout-dashboard` bracket syntax
- **Found during:** Task 2 (build verification)
- **Issue:** `icons.layout-dashboard` was incorrectly converted to `icons['layout']-dashboard` because the sed bracket wrapper only captured `layout` (before the `-`)
- **Fix:** Replaced with `(icons as any)['layout-dashboard']`

### Rule 1 — Bug: Import path corruption from bracket conversion
- **Found during:** Task 2 (post-conversion check)
- **Issue:** The bracket conversion sed (`s/icons\.X/icons['X']/g`) also matched `.js` in import paths, turning `icons.js` into `icons['js']`
- **Fix:** Global sed replacement of `icons['js']` -> `icons.js` across all affected files

### Rule 1 — Bug: Incorrect relative import depth for views/ and chat/
- **Found during:** Task 3 (vite build)
- **Issue:** Import paths used `../../icons.js` for views/ and chat/ but should be `../../../icons.js`
- **Fix:** Sed replacement from `../../icons.js` to `../../../icons.js` for both directories

### Rule 1 — Bug: Test failure from renamed icon string
- **Found during:** Task 3 (vitest run)
- **Issue:** `instance-detail-diagnosis.test.ts:84` checked for string `'chevronRight'` which no longer exists in source after rename to `chevron-right`
- **Fix:** Updated test expectation from `chevronRight` to `chevron-right`

## Commit History

| Task | Commit | Summary |
|------|--------|---------|
| 1 | f6daf41d2c6 | feat(102-ui-01): create merged canonical icon file with kebab-case naming |
| 2 | b2bdbe0760d | feat(102-ui-01): update import paths and batch-rename icons to kebab-case bracket notation |
| 3 | c86b493abfe | chore(102-ui-01): delete old icon files, verify build, fix test |

## Success Criteria

- [x] `frontend/src/icons.ts` exists with 111 kebab-case icons and 4 API exports
- [x] All 8 previously missing icons exist
- [x] Zero remaining imports from `openclaw/ui/icons.ts` or `styles/icons.ts`
- [x] Zero remaining `icons.someName` camelCase dot-access patterns
- [x] Both old icon files deleted
- [x] Vite build succeeds without errors
- [x] Vitest passes (218 passing, 19 pre-existing failures documented)
