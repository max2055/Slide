# Phase 102: UI统一 - Research

**Researched:** 2026-05-21
**Domain:** Frontend UI unification (Lit 3.3 Web Components, SVG icons)
**Confidence:** HIGH

## Summary

This phase unifies the frontend icon system and stat-card components, eliminating UI fractures caused by missing or broken icon imports. The project has two separate icon files (`openclaw/ui/icons.ts` with ~65 camelCase icons lacking SVG stroke attributes, and `styles/icons.ts` with ~52 kebab-case icons having proper attributes) and duplicated ov-card CSS across 6 views.

The primary work involves: (1) merging both icon files into a single `frontend/src/icons.ts` with all icons converted to kebab-case with proper SVG attributes, (2) updating ~32 import paths across the codebase, (3) batch-renaming ~100+ camelCase icon references to kebab-case, (4) replacing ~300 lines of duplicated ov-card CSS with a shared `<stat-card>` LitElement, and (5) replacing 4 emoji/inline-svg structural placeholders with proper icon calls.

**Primary recommendation:** Follow the locked decisions from CONTEXT.md precisely. The merge strategy, naming convention (kebab-case, Lucide-style), API compatibility (`icon()`, `renderIcon()`, `icons`, `IconName`), and stat-card component contract are all already decided. No library installations needed -- this is a pure codebase refactoring phase.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** New `frontend/src/icons.ts` as the sole canonical icon file; delete both old files after merge
- **D-02:** All icons get `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` attributes -- this is the root cause of invisible icons (e.g., eyeOff crash)
- **D-03:** Merge all icons with dedup (~70+ total); for conflicts use `styles/icons.ts` version (its SVG attributes are complete)
- **D-04:** Keep API compatibility: `export { icons, icon(), renderIcon(), type IconName }`; `renderIcon` default className becomes `'icon'` (matches styles/icons.ts)
- **D-05:** 31+ files' import paths change from two old files to `frontend/src/icons.js`
- **D-06:** Unify to kebab-case (Lucide style: `eye-off`, `bar-chart`, `file-text`, `trending-up`, `chevron-down`)
- **D-07:** Batch replace 100+ camelCase references directly (`eyeOff` to `eye-off`, etc.); no alias transition layer
- **D-08:** Naming conflicts resolved by `styles/icons.ts` name (closer to Lucide official). Same-graphic-different-name: styles/ wins. Different-graphic: both kept. Single-source-only: converted to kebab-case.
- **D-09:** `class StatCard extends LitElement` -- project is already Lit 3.3 + Web Components
- **D-10:** Properties: `label` (string), `value` (string), `hint` (string), `variant` (`'ok' | 'warn' | 'danger' | 'info'`, default no variant)
- **D-11:** No icon slot -- stat-card is pure text; variant renders indicator dot
- **D-12:** Pure display, no built-in click behavior; parent wraps `<button>` for clickability
- **D-13:** Colors via CSS variables (`var(--ok)`, `var(--warn)`, `var(--destructive)`, `var(--info)`)
- **D-14:** Delete ~80 lines ov-card CSS from `components.css` + ~300 lines from 6 inline views
- **D-15:** Replace 6 views: `dashboard.ts`, `alerts.ts`, `instances-db.ts`, `reports.ts`, `schema-management.ts`, `overview-cards.ts`
- **D-16:** 4 emoji structural replacements: `renderIcon()` calls instead of emoji characters
- **D-17:** Status-message emoji (checkmark, cross, warning in textual messages) kept as-is -- they are text semantics

### Claude's Discretion
- Same-named icon pair-by-pair comparison and selection mapping (30+ naming conflicts)
- `<stat-card>` component file location (default: `frontend/src/components/stat-card.ts`)
- Old icon file deletion timing (all-at-once after migration vs. staged)
- 6 views' ov-card to stat-card migration order

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UI-01 | Merge two icon files into one canonical file | Both files analyzed (65 camelCase icons in `openclaw/ui/icons.ts`, 52 kebab-case in `styles/icons.ts`). Styles file has proper SVG attributes; openclaw file lacks them. Merge to `frontend/src/icons.ts`. |
| UI-02 | Add 33 missing icon references (eyeOff, barChart, fileText, checkCircle) | Root cause identified: `openclaw/ui/icons.ts` icons lack `fill="none" stroke="currentColor"` attributes. At least 10 icon names referenced in code don't exist in either file (alertCircle, bellOff, calendar, checkCircle, hardDrive, history, info, partyPopper, pause, xCircle). Merge provides complete set. |
| UI-03 | Unify icon naming (kebab-case vs camelCase) | ~100+ camelCase references across 25+ view files + 4 component files. All must be converted to kebab-case (e.g., `icons.barChart` to `icons['bar-chart']`). No alias layer. |
| UI-04 | Extract ov-card CSS into shared `<stat-card>` component | 6 views duplicate ~50-80 lines each of identical ov-card CSS. `overview-cards.ts` has existing `renderStatCard()` function as reference. Stat-card component follows existing LitElement pattern (`AppHeader`, `AppSidebar`, `AppLayout`). |
| UI-05 | Replace emoji/inline SVG with shared icon calls | 4 locations found: query-analysis-tab.ts (🔍, 📊), instance-detail.ts (📦), event-management.ts (⚠️). Status-message emoji excluded per D-17. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Icon file definition | Frontend (Browser) | — | Icons are TemplateResult values rendered in Lit templates; no server involvement |
| Icon path resolution | Frontend (Build) | — | Vite resolves `.js` imports at build time; import paths are entirely frontend concern |
| stat-card rendering | Frontend (Browser) | — | LitElement custom element renders in browser Shadow DOM; CSS variables from theme system |
| ov-card CSS deletion | Frontend (Codebase) | — | CSS lives in frontend source files; no backend or shared assets |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Lit | `^3.3.2` | Web component framework | Project foundation; AppHeader, AppSidebar, AppLayout all use this pattern |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Vite | (bundled) | Module resolution | Resolves `.js` to `.ts` imports; all existing icon imports use `.js` extension |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom LitElement stat-card | Web component from library | No external component library for cards; project already has all design tokens as CSS vars |

**Installation:**
No new packages needed. This is a pure refactoring phase:
- No `npm install` required
- All existing imports use Vite's `.js` to `.ts` resolution
- stat-card component follows existing `AppHeader.ts` / `AppSidebar.ts` pattern with `customElements.define`

## Package Legitimacy Audit

> This phase installs NO external packages. All work is source-level refactoring of existing source code. Package legitimacy audit is not applicable.

## Architecture Patterns

### System Architecture Diagram

```
                    User Decision (CONTEXT.md)
                            |
                            v
     +----------+  merge   +----------+  delete   +---------------+
     | styles/  |--------->| src/     |--------->| OLD FILES     |
     | icons.ts |          | icons.ts |          | DELETED       |
     +----------+          |          |          +---------------+
     +----------+          | (~70+    |
     | openclaw/ |-------->|  icons   |
     | ui/icons  |          | kebab)   |
     +----------+          +----+-----+
                               |
                    import path redirect
                               |
              +----------------+----------------+
              |                |                 |
              v                v                 v
        ~25 views         4 components      2 type-only
       (openclaw/)        (src/comps/)       (navigation,
                                              tool-display)

    Duplicated ov-card CSS (6 views)
              |
              | extract
              v
        <stat-card> LitElement
              |
              | CSS variables
              v
        Theme system (var(--ok), var(--warn), ...)
```

### Recommended Project Structure (pre/post change)

**File structure changes:**
```
frontend/src/
  NEW:  icons.ts                     <- Canonical icon file (merged from 2 sources)
  REMOVED: openclaw/ui/icons.ts      <- Deprecated, merged into src/icons.ts
  REMOVED: styles/icons.ts           <- Deprecated, merged into src/icons.ts
  NEW:  components/stat-card.ts      <- Shared stat-card LitElement

  components/
    AppHeader.ts                     <- import changed: '../styles/icons.js' -> '../icons.js'
    AppSidebar.ts                    <- import changed: same
    AppLayout.ts                     <- import changed: same
    InstanceDetailLayout.ts          <- import changed: same (includes dynamic (icons as any)[tab.icon])

  openclaw/ui/views/*.ts (~25 files) <- import changed: '../icons.js' -> '../../icons.js'
  openclaw/ui/chat/*.ts (~3 files)   <- import changed: '../icons.js' -> '../../icons.js'
  openclaw/ui/app-render.helpers.ts  <- import changed: './icons.ts' -> '../../icons.js'
  openclaw/ui/navigation.ts          <- import changed: './icons.js' -> '../../icons.js'
  openclaw/ui/tool-display.ts        <- import changed: './icons.ts' -> '../../icons.js'
```

### Pattern 1: LitElement Component Definition
**What:** Standard pattern for defining Lit components in this codebase
**When to use:** For `<stat-card>` component and any future custom elements
**Source:** [VERIFIED: codebase analysis of AppHeader.ts, AppSidebar.ts, AppLayout.ts]

```typescript
export class StatCard extends LitElement {
  @property({ type: String }) label = '';
  @property({ type: String }) value = '';
  @property({ type: String }) hint = '';
  @property({ type: String }) variant?: 'ok' | 'warn' | 'danger' | 'info';

  static override styles = css`
    :host {
      display: block;
    }
    /* ... style using var(--ok), var(--warn), var(--destructive), var(--info) ... */
  `;

  override render() {
    return html`
      <div class="stat-card" part="root">
        <span class="stat-card__label">${this.label}</span>
        <span class="stat-card__value">${this.value}</span>
        ${this.hint ? html`<span class="stat-card__hint">${this.hint}</span>` : ''}
      </div>
    `;
  }
}

// At bottom of file (matching existing pattern):
if (!customElements.get('stat-card')) {
  customElements.define('stat-card', StatCard);
}
```

### Pattern 2: Icon Definition (merged format)
**What:** Every icon defined with complete SVG attributes
**When to use:** For all icons in `src/icons.ts`
**Source:** [VERIFIED: codebase analysis of styles/icons.ts]

```typescript
'eye-off': html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="..." />
    ...
  </svg>
`,
```

### Pattern 3: Dynamic Icon Access (AsAny)
**What:** Some views use `(icons as any)[dynamicKey]` for runtime icon resolution
**When to use:** For dynamic icon access where the key comes from data
**Source:** [VERIFIED: InstanceDetailLayout.ts line 392]

```typescript
// Existing pattern for kebab-case dynamic access:
${(icons as any)[tab.icon] || icons['layout-dashboard']}
```

The kebab-case naming convention works naturally with this pattern since icon keys are already strings.

### Anti-Patterns to Avoid
- **Partial SVG attributes:** Do not define icons without `fill="none" stroke="currentColor" stroke-width="2"` -- this is the root cause of invisible icons
- **Mixed naming in view files:** After migration, ALL references must use kebab-case bracket notation `icons['eye-off']` -- no camelCase `icons.eyeOff` remnants
- **Retaining old import paths:** Both old files MUST be deleted after the merge to prevent accidental re-imports
- **`<stat-card>` with built-in click handler:** Per D-12, stat-card is pure display. The existing `overview-cards.ts` `renderStatCard()` wraps ov-card in `<button>` -- this is correct and must be replicated as `<button><stat-card ...></stat-card></button>`

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Icon definitions | Third-party icon library | Keep existing Lucide-style SVG set | Project already has 70+ icons defined. Per out-of-scope: no `lucide-static` or `@material/web`. |
| SVG stroke attributes | Manual per-icon review | Scripted attribute injection | D-02: Every icon must have uniform attributes. Manual review of 70+ icons is error-prone. |
| Icon naming alias layer | Intermediate camelCase-to-kebab-case map | Direct batch replacement | D-07: No transition layer. All ~100 references renamed in one pass. |

**Key insight:** This is primarily a mechanical refactoring -- find-and-replace operations with careful verification. The risk is in missed references (icons left in camelCase, import paths not updated). Automation via batch search-and-replace is strongly preferred.

## Common Pitfalls

### Pitfall 1: Mixed Naming During Transition
**What goes wrong:** Some camelCase references are missed during batch rename, creating a mix of kebab-case and camelCase in view files.
**Why it happens:** 100+ icon references across 25+ files; easy to miss edge cases (dynamic access, conditional rendering, deeply nested templates).
**How to avoid:** After the batch replace, grep for the `icons.` (dot-access) pattern across the entire `frontend/src/` directory. Zero matches means complete.
**Warning signs:** TypeScript errors for unknown icon names; runtime blank icon areas.

### Pitfall 2: Styles Removed Before All ov-card Users Migrated
**What goes wrong:** The `components.css` ov-card rule (~80 lines) is deleted before all 6 views are migrated to `<stat-card>`, causing visual breakage.
**Why it happens:** ov-card CSS is split between `components.css` (global) and 6 inline view CSS. Some views may be missed.
**How to avoid:** Do NOT delete the global ov-card CSS from `components.css` until ALL 6 views have been migrated and verified. The inline view CSS (~50-80 lines each) should be deleted per-view as each view is migrated. After all views use `<stat-card>`, do a final `grep -r 'ov-card' frontend/src/` to confirm zero matches, then delete from `components.css`.
**Warning signs:** Stat cards appear unstyled, missing borders/padding/animations.

### Pitfall 3: Import Path `.js` vs `.ts` Inconsistency
**What goes wrong:** Some files use `from "../../icons.js"` while others use `from "../../icons.ts"` after migration.
**Why it happens:** Existing codebase uses both `.js` (Vite resolves to `.ts`) and `.ts` extensions inconsistently for icon imports.
**How to avoid:** Follow the existing convention in each importing file. Views in `openclaw/ui/views/` currently use `"../icons.js"` -- keep `.js` extension. Components use `'../styles/icons.js'` -- keep `.js`. `tool-display.ts` uses `"./icons.ts"` -- use `"../../icons.js"` (consistent with other views).
**Warning signs:** Vite resolution errors; module not found.

### Pitfall 4: Dynamic Icon Key Breakage
**What goes wrong:** Views using dynamic icon access like `icons[display.icon]` or `(icons as any)[tab.icon]` produce blank areas because the dynamic key doesn't match.
**Why it happens:** If a dynamic key is in camelCase (`barChart`) but the icon name is kebab-case (`bar-chart`), the lookup fails silently.
**How to avoid:** Check every instance of `icons[` (bracket access) in the codebase. The main locations are: `InstanceDetailLayout.ts:392` (`(icons as any)[tab.icon]`), `tool-cards.ts:473/554` (`icons[display.icon]`), `AppSidebar.ts:248` (`icons[item.icon]`). The data driving these keys must also be converted to kebab-case.
**Warning signs:** Empty or missing icons in sidebars, tool cards, instance detail tabs.

### Pitfall 5: TypeScript Union Type Exhaustion
**What goes wrong:** After merge, `IconName` type (union of all keys) may exceed TypeScript union member limits or cause slow compilation.
**Why it happens:** 70+ string literal union members from the merged `icons` object.
**How to avoid:** This is handled correctly by the existing pattern (`export type IconName = keyof typeof icons`). TypeScript union member limit is 100,000 -- 70 members is well within bounds.
**Warning signs:** TypeScript compilation errors on `IconName` type.

## Code Examples

### Merged Icon File Structure
```typescript
// frontend/src/icons.ts
import { html, type TemplateResult } from 'lit';

export const icons = {
  // All icons must have these SVG attributes:
  // fill="none" stroke="currentColor" stroke-width="2"
  // stroke-linecap="round" stroke-linejoin="round"

  'eye-off': html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 ..." />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 ..." />
      <path d="m2 2 20 20" />
    </svg>
  `,

  'bar-chart': html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" x2="12" y1="20" y2="10" />
      <line x1="18" x2="18" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="16" />
    </svg>
  `,

  'check-circle': html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  `,
  // ... ~70+ total icons
} as const;

export type IconName = keyof typeof icons;

export function icon(name: IconName): TemplateResult {
  return icons[name];
}

export function renderIcon(name: IconName, className = 'icon'): TemplateResult {
  return html`<span class="${className}" aria-hidden="true">${icons[name]}</span>`;
}
```

### Icon Name Mapping (camelCase to kebab-case)
```
barChart       -> bar-chart        (styles/icons.ts: 'bar-chart')
fileText       -> file-text        (styles/icons.ts: 'file-text')
checkCircle    -> check-circle     (styles/icons.ts: 'check-circle')
trendingUp     -> trending-up      (styles/icons.ts: 'trending-up')
chevronDown    -> chevron-down     (styles/icons.ts: 'chevron-down')
chevronRight   -> chevron-right    (styles/icons.ts: 'chevron-right')
panelLeftOpen  -> panel-left-open  (styles/icons.ts: 'panel-left-open')
panelLeftClose -> panel-left-close (styles/icons.ts: 'panel-left-close')
panelRightOpen -> panel-right-open (styles/icons.ts: 'panel-right-open')
moreHorizontal -> more-horizontal  (NEW -- not in styles/icons.ts, keep with kebab-case)
arrowUpDown    -> arrow-up-down    (NEW -- not in styles/icons.ts, keep with kebab-case)
messageSquare  -> message-square   (NEW -- styles has 'message', not 'message-square')
eyeOff         -> eye-off          (NEW -- not in styles/icons.ts, keep from openclaw)
bellOff        -> bell-off         (NEW -- need to add icon)
partyPopper    -> party-popper     (NEW -- need to add icon)
alertTriangle  -> triangle-alert   (styles/icons.ts: 'triangle-alert')
alertCircle    -> alert-circle     (NEW -- need to add icon, styles has 'circle-alert')
xCircle        -> x-circle         (NEW -- styles has 'circle-x' not 'x-circle')
hardDrive      -> hard-drive       (styles/icons.ts: 'hard-drive')
history        -> clock            (styles/icons.ts: 'clock')
info           -> info             (styles/icons.ts: 'info')
user           -> users            (styles/icons.ts: 'users')
calendar       -> calendar         (NEW -- need to add icon)
pause          -> pause            (NEW -- need to add icon)
```

### stat-card Usage Pattern (6 views)
```html
<!-- Instead of: -->
<div class="ov-cards">
  <div class="ov-card">
    <span class="ov-card__label">表数量</span>
    <span class="ov-card__value">${this.stats.totalTables}</span>
    <span class="ov-card__hint">当前快照</span>
  </div>
</div>

<!-- Use: -->
<stat-card
  label="表数量"
  value="${this.stats.totalTables}"
  hint="当前快照"
></stat-card>
```

### stat-card with Variant
```html
<stat-card
  label="告警"
  value="${alertCount}"
  hint="${criticalCount} critical"
  variant="${alertCount > 0 ? 'danger' : 'ok'}"
></stat-card>
```

### Wrapping for Clickability
```html
<button class="ov-card" @click=${() => onNavigate(tab)}>
  <stat-card label="${label}" value="${value}" hint="${hint}"></stat-card>
</button>
```

### Emoji Replacement Pattern
```typescript
// BEFORE: query-analysis-tab.ts line 191
<text>🔍 查询指纹分析</text>

// AFTER:
<text>${renderIcon('search')} 查询指纹分析</text>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Two separate icon files with different naming | Single canonical file, kebab-case | Phase 102 | Eliminates runtime crashes, unifies API |
| ov-card CSS duplicated in 6 views + global css | Shared `<stat-card>` LitElement | Phase 102 | ~300 lines removed, consistent rendering |
| Inline SVG without stroke attributes | All icons with uniform attributes | Phase 102 | Fixes invisible icons (eyeOff crash) |
| Emoji characters as icon placeholders | `renderIcon()` calls | Phase 102 | Consistent theming, accessibility |

**Deprecated/outdated:**
- `frontend/src/openclaw/ui/icons.ts`: Being completely replaced after merge
- `frontend/src/styles/icons.ts`: Being completely replaced after merge
- `frontend/src/openclaw/styles/components.css` ov-card section (lines ~3920-4000): Deleted after migration
- `renderEmojiIcon()` / `setEmojiIcon()`: Dead code -- not imported by any file outside their definition. Can be removed during merge.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `renderEmojiIcon` and `setEmojiIcon` are dead code (no external imports) | Code Examples | LOW -- verified by grep, only referenced in own definition |
| A2 | The 6 views using ov-card are exactly: dashboard.ts, alerts.ts, instances-db.ts, reports.ts, schema-management.ts, overview-cards.ts | Architecture Patterns | LOW -- verified by grep for `ov-card` across all frontend .ts files |
| A3 | overview-cards.ts uses ov-card CSS from components.css (global), not inline | Architecture Patterns | LOW -- overview-cards.ts has no `<style>` block with ov-card CSS; it uses the global rule from components.css |
| A4 | The exact icon count is approximately 70+ after dedup merge | Standard Stack | LOW -- exact count determined at merge time; no impact on plan |

## Open Questions

1. **New icons that need to be created**
   - What we know: Icons like `bell-off`, `party-popper`, `calendar`, `pause`, `alert-circle`, `x-circle`, `message-square` are referenced in code but exist in neither file. Some may exist in the Lucide set.
   - What's unclear: The exact SVG path data for these icons. The planner must decide: (a) create from Lucide source, (b) create simplified versions, or (c) map to existing similar icons.
   - Recommendation: This is under Claude's discretion for icon mapping. For icons that exist in Lucide but not in the project, add them with standard SVG attributes. For icons with no clear Lucide equivalent, use existing paths or create minimal versions.

2. **`layout-dashboard` fallback in InstanceDetailLayout**
   - What we know: `InstanceDetailLayout.ts:392` has `icons['layout-dashboard']` as a fallback. This icon name doesn't exist in either source file. The styles file has `layout-grid` and the openclaw file has no layout icon.
   - What's unclear: Should `layout-dashboard` be added, or should the fallback be changed to an existing icon?
   - Recommendation: Either add `layout-dashboard` as a new icon, or change fallback to `layout-grid` which exists in styles/icons.ts.

3. **`icons.js` file extension in merged file**
   - What we know: The new file will be `frontend/src/icons.ts`. Vite resolves `.js` imports to `.ts` files.
   - What's unclear: Whether any importers use `icons.ts` directly (tool-display.ts does: `"./icons.ts"`).
   - Recommendation: The file should be `.ts` (matching the original files). All import paths must use `.js` extension (following Vite convention in this project), except `tool-display.ts` which currently uses `.ts` -- keep `.ts` for that one file to minimize changes, or standardize to `.js`.

## Environment Availability

> Skip this section for Phase 102. The phase has no external dependencies (all work is source-level refactoring). No CLIs, no runtimes, no services required beyond the existing Vite dev server (`npm run dev`).

## Validation Architecture

> workflow.nyquist_validation is implicitly enabled (config key absent).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via `frontend/package.json`: `"test": "vitest run"`) |
| Config file | None detected at root; likely uses Vite config or default |
| Quick run command | `cd frontend && npx vitest run --reporter verbose 2>/dev/null | tail -30` |
| Full suite command | `cd frontend && npm test 2>/dev/null | tail -30` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UI-01 | Merged icons.ts exports `icons`, `icon()`, `renderIcon()`, `IconName` | Unit | `grep 'export' frontend/src/icons.ts` | ❌ Wave 0 |
| UI-02 | All previously missing icons render without errors | Manual/smoke | Start frontend, verify login page, dashboard, alerts, reports, schema-management, instances-db render without console errors | ❌ Manual |
| UI-03 | No camelCase icon references remain | Scripted | `grep -rn 'icons\.' frontend/src/ --include='*.ts' | grep -v node_modules | grep -v '\.d\.ts' | grep -v 'icons\[' | grep -v 'icons\.ts'` should return empty | ❌ Wave 0 |
| UI-03 | No imports from old icon files | Scripted | `grep -rn "from.*openclaw/ui/icons\|from.*styles/icons" frontend/src/ --include='*.ts'` should return empty | ❌ Wave 0 |
| UI-04 | All 6 views use `<stat-card>` instead of ov-card CSS | Scripted | `grep -rn 'ov-card' frontend/src/ --include='*.ts' --include='*.css' | grep -v node_modules | grep -v '\.d\.ts'` should return empty | ❌ Wave 0 |
| UI-05 | No structural emoji chars in views | Scripted | `grep -rn '[\u{1F50D}\u{1F4CA}\u{1F4E6}\u{26A0}]' frontend/src/openclaw/ui/views/ --include='*.ts'` should match only status-message emoji | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd frontend && npx vitest run --reporter verbose 2>/dev/null | tail -15`
- **Per wave merge:** `cd frontend && npm test 2>/dev/null | tail -15`
- **Phase gate:** Full test suite green + manual verification of 6 views + login page before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Verification test for `ui-01`: Check that `frontend/src/icons.ts` exists and exports the 4 expected symbols
- [ ] Verification for `ui-03`: Script to grep for remaining `icons.` dot-access patterns (camelCase remnants)
- [ ] Verification for `ui-04`: Script to grep for remaining `ov-card` class references

*(No framework-level gaps -- Vitest is already configured and used in the project.)*

## Security Domain

> `security_enforcement` is implicitly enabled (config key absent).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | no | Phase 102 is purely visual/UI refactoring; no user input processed |
| V6 Cryptography | no | No cryptographic operations |
| V16 Privacy/Sensitive Data | partial | `blurDigits()` in overview-cards.ts uses digits-only blurring; stat-card component should not accept or render sensitive data without sanitization |

### Known Threat Patterns for Frontend Refactoring

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| XSS via icon name injection | Tampering | Icon names are static string literals defined in `icons.ts`, never user-controlled. Dynamic access `(icons as any)[key]` reads from predefined keys only, no user-input interpolation into icon names. |
| DOM clobbering via custom element | Tampering | `<stat-card>` is defined via `customElements.define('stat-card', StatCard)` -- the `-` in the name prevents HTMLUnknownElement fallback. Existing pattern in AppHeader/AppSidebar. |

**No additional security controls needed** for this phase. Icon names are compile-time constants, and stat-card properties accept only pre-typed strings.

## Sources

### Primary (HIGH confidence)
- [VERIFIED: Codebase analysis] - `frontend/src/openclaw/ui/icons.ts` -- 65 camelCase icons, most missing SVG attributes
- [VERIFIED: Codebase analysis] - `frontend/src/styles/icons.ts` -- 52 kebab-case icons, all with proper SVG attributes
- [VERIFIED: Codebase analysis] - `frontend/src/openclaw/styles/components.css` lines 3920-4000 -- global ov-card CSS definition
- [VERIFIED: Codebase analysis] - `frontend/src/openclaw/ui/views/overview-cards.ts` -- existing `renderStatCard()` function (line 39), serves as component reference
- [VERIFIED: Codebase analysis] - `frontend/src/components/AppHeader.ts` -- LitElement pattern reference, `customElements.define('app-header', AppHeader)`
- [VERIFIED: Codebase analysis] - `frontend/package.json` -- Lit `^3.3.2`, Vitest configured

### Secondary (MEDIUM confidence)
- [VERIFIED: Codebase analysis via grep] - 5 views with inline ov-card CSS duplication: dashboard.ts, alerts.ts, instances-db.ts, reports.ts, schema-management.ts (+ overview-cards.ts uses global CSS)
- [VERIFIED: Codebase analysis via grep] - 4 emoji locations: query-analysis-tab.ts:191/227, instance-detail.ts:2191, event-management.ts:754
- [VERIFIED: Codebase analysis via grep] - ~32 files need import path updates
- [VERIFIED: Codebase analysis via grep] - `renderEmojiIcon` / `setEmojiIcon` are dead code (0 external importers)

### Tertiary (LOW confidence)
- None -- all findings verified against actual codebase source

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - verified against package.json and all source files
- Architecture: HIGH - each pattern verified against actual code
- Pitfalls: HIGH - identified from source analysis and understanding of the mechanical refactoring nature
- Icon mapping: MEDIUM - individual icon name collisions need human review (discretion area)

**Research date:** 2026-05-21
**Valid until:** Stable -- this is a source-level refactoring phase with no external version dependencies
