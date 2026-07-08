---
phase: 120-ui
reviewed: 2026-06-18T12:00:00Z
depth: deep
files_reviewed: 40
files_reviewed_list:
  - frontend/src/app/styles/tokens.css
  - frontend/src/app/styles/utilities.css
  - frontend/src/app/styles.css
  - frontend/src/app/styles/base.css
  - frontend/src/app/styles/layout.css
  - frontend/src/app/styles/components.css
  - frontend/src/app/styles/shared-btn-styles.ts
  - frontend/src/app/ui/app-render.ts
  - frontend/src/app/main.ts
  - frontend/src/app/ui/components/app-dialog.ts
  - frontend/src/app/ui/components/app-toast-container.ts
  - frontend/src/app/ui/components/app-form-field.ts
  - frontend/src/app/ui/components/app-card.ts
  - frontend/src/app/ui/components/app-data-table.ts
  - frontend/src/app/ui/components/app-empty-state.ts
  - frontend/src/app/ui/components/app-badge.ts
  - frontend/src/app/ui/components/chat-message-list.ts
  - frontend/src/app/ui/components/chat-compose-area.ts
  - frontend/src/app/ui/components/chat-tool-result-card.ts
  - frontend/src/app/ui/components/alert-list.ts
  - frontend/src/app/ui/components/alert-detail-modal.ts
  - frontend/src/app/ui/components/alert-rule-editor.ts
  - frontend/src/app/ui/components/alert-analysis-viewer.ts
  - frontend/src/app/ui/components/instance-overview-tab.ts
  - frontend/src/app/ui/components/instance-metrics-tab.ts
  - frontend/src/app/ui/components/instance-diagnosis-modal.ts
  - frontend/src/app/ui/components/instance-trend-chart.ts
  - frontend/src/app/ui/views/alerts.ts
  - frontend/src/app/ui/views/instance-detail.ts
  - frontend/src/app/ui/views/chat.ts
  - frontend/src/app/ui/views/appearance-settings.ts
  - frontend/src/app/ui/views/sql-console.ts
  - frontend/src/app/ui/views/dashboard.ts
  - frontend/src/app/ui/app-settings.ts
  - frontend/src/app/ui/storage.ts
  - frontend/src/app/ui/btn-palette.ts
  - frontend/src/app/ui/views/health-score-tab.ts
  - frontend/src/app/ui/views/event-management.ts
  - frontend/src/app/ui/views/llm-config.ts
findings:
  critical: 7
  warning: 11
  info: 9
  total: 27
status: issues_found
---

# Phase 120: Code Review Report (Deep)

**Reviewed:** 2026-06-18T12:00:00Z
**Depth:** deep (cross-file analysis)
**Files Reviewed:** 40
**Status:** issues_found

## Summary

Phase 120 made sweeping UI improvements: CSS architecture reset, 7 new shared Lit components, 3 god component splits, and cross-view adoption. The overall architecture is sound and the Light DOM pattern with `app-` prefix is consistently applied. However, 7 BLOCKER-level issues were found, including non-functional form field accessibility, broken welcome suggestion buttons, silent purple-accent fallback overriding the new blue design tokens, unstyled form inputs in alert-rule-editor, and 6 remaining purple `#8b5cf6` hardcodes in chart palettes and views that contradict D-01's accent-color unification. 11 WARNING-level issues include remaining `console.warn`, missing `--info-subtle` token, and the redundant `try/catch customElements.define` anti-pattern.

---

## CRITICAL / BLOCKER

### CR-01: form-field `aria-invalid` management broken in Light DOM mode

**File:** `frontend/src/app/ui/components/app-form-field.ts:27-42`
**Issue:** The `_onSlotChange` method relies on `(slot as HTMLSlotElement).assignedElements()` to manage `aria-invalid` on slotted inputs. In Light DOM mode (`createRenderRoot() { return this; }`), `<slot>` elements have no projection behavior — `assignedElements()` returns an empty array because no shadow root exists to assign from. The `aria-invalid` attribute is never set on actual form inputs. This means:

1. Screen readers never receive `aria-invalid="true"` when a field has an error.
2. The global CSS selector `.field input[aria-invalid="true"]` (components.css:1000) that provides red error border never matches.
3. The `slotchange` event fires on initial render but `assignedElements()` returns `[]`.

**Fix:** Replace the slot-based approach with direct DOM querying on the Light DOM render root. Query `this.querySelector('input, select, textarea')` in `updated()` when the `error` property changes.

```typescript
updated(changed: Map<string, unknown>): void {
  if (changed.has("error")) {
    const control = this.querySelector("input, select, textarea");
    if (control) {
      if (this.error) {
        control.setAttribute("aria-invalid", "true");
      } else {
        control.removeAttribute("aria-invalid");
      }
    }
  }
}
```

Remove the `_onSlotChange` method entirely; remove the `@slotchange` from the template.

---

### CR-02: Welcome suggestion buttons silently non-functional (`this` is undefined)

**File:** `frontend/src/app/ui/components/chat-message-list.ts:80-94`
**Issue:** `renderWelcomeState` is a module-level function (not a class method). Inside the arrow function `@click=${() => { this?.dispatchEvent?.(...) }}`, `this` is captured lexically from `renderWelcomeState`'s scope, which is `undefined` in strict-mode TypeScript modules. The `this?.dispatchEvent?.()` short-circuits silently — clicking any suggestion button ("查看实例运行状态", "列出活跃告警", etc.) dispatches no event and does nothing.

Even if the event were dispatched, `chat.ts:317-336` (the parent orchestrator) has no `@suggest` event listener on `<chat-message-list>` — so even with correct dispatching, the suggestions would be unhandled.

**Fix:** Two-part fix:

1. Fix the event dispatch to target the button element itself:
```typescript
@click=${(e: Event) => {
  (e.currentTarget as HTMLElement).dispatchEvent(
    new CustomEvent("suggest", { detail: { text }, bubbles: true, composed: true })
  );
}}
```

2. In `chat.ts`, add event listener on `<chat-message-list>`:
```typescript
@onSuggest=${(e: CustomEvent) => {
  props.onDraftChange?.(e.detail.text);
}}
```
And pass as a property: `.onSuggest=${(detail: { text: string }) => props.onDraftChange?.(detail.text)}`

---

### CR-03: Purple `#7c5cff` fallback in settings system silently overrides blue `#409eff` token

**File:** `frontend/src/app/ui/app-settings.ts:272`
**Issue:** `applyAccentColor()` is called with `host.settings.accentColor ?? "#7c5cff"`. When settings lack `accentColor` (new users, settings cleared, migration from older version), the default is the old purple `#7c5cff`. This overrides `--accent` and all related CSS custom properties, reverting the entire UI to purple despite tokens.css defining `#409eff` blue as the canonical accent. All shared components, token references, and visual polish decisions (D-01) are rendered moot.

Three related files also default to purple:
- `storage.ts:187`: `accentColor: "#7c5cff"`
- `btn-palette.ts:22`: `primaryBg: "#7c5cff"`
- `appearance-settings.ts:24,81,83,129,199,223`: multiple `#7c5cff` fallbacks and state initializers

**Fix:** Change all defaults to `#409eff`:

```typescript
// app-settings.ts:272
applyAccentColor(host.settings.accentColor ?? "#409eff");

// storage.ts:187
accentColor: "#409eff",

// btn-palette.ts:22,24,29
primaryBg: "#409eff",
primaryBorder: "#409eff",
ghostHoverColor: "#409eff",

// appearance-settings.ts:24
{ name: "Default Blue", hex: "#409eff" },

// appearance-settings.ts:81,83,129,199,223
// (all #7c5cff -> #409eff)
```

---

### CR-04: `form-input` CSS class undefined in alert-rule-editor Shadow DOM — inputs unstyled

**File:** `frontend/src/app/ui/components/alert-rule-editor.ts:41,115-225`
**Issue:** `alert-rule-editor` uses Shadow DOM (no `createRenderRoot` override). Nine form inputs/selects throughout the template use `class="form-input"` (lines 126, 130, 150, 157, 160, 183, 203, 207, 211). But `.form-input` is a CSS class defined only in:
- `alert-list.ts:79` (scoped to alert-list's Shadow DOM)
- Various view files' Shadow DOM (scoped)

The alert-rule-editor has no `.form-input` rule in its own `static styles`. The CSS class resolves to browser defaults — no border, background, padding, or font-size. Inputs render flat and unstyled against the themed dialog background.

**Fix:** Add `.form-input` styles to alert-rule-editor's `static styles`:

```css
.form-input {
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: var(--text-base);
  color: var(--text);
  background: var(--card);
  box-sizing: border-box;
  outline: none;
  transition: border-color var(--duration-fast) ease;
}
.form-input:focus {
  border-color: var(--ring);
  box-shadow: var(--focus-ring);
}
```

Or extract a shared `form-input-styles.ts` file that all Shadow DOM components can import.

---

### CR-05: Typo `btn--ghot` instead of `btn--ghost` in chat-tool-result-card

**File:** `frontend/src/app/ui/components/chat-tool-result-card.ts:32`
**Issue:** The collapse button uses `class="btn btn--ghot"` (missing `s`). The `btn--ghost` class from `sharedBtnStyles` does not match. The button renders without proper ghost button styling — it will lack the correct hover effects, border, and transition behavior.

```typescript
html`<button class="btn btn--ghot" ...>`  // should be "btn btn--ghost"
```

**Fix:** Change `btn--ghot` to `btn--ghost`.

---

### CR-06: Hardcoded purple `#b08df5` / `#8b5cf6` in alert-analysis-viewer and trend charts (contradicts D-01)

**File (alert-analysis-viewer):** `frontend/src/app/ui/components/alert-analysis-viewer.ts:54`
**Files (chart palettes):**
- `frontend/src/app/ui/components/instance-overview-tab.ts:159`
- `frontend/src/app/ui/components/instance-metrics-tab.ts:94`
- `frontend/src/app/ui/components/instance-trend-chart.ts:71,93`
- `frontend/src/app/ui/views/health-score-tab.ts:475`
- `frontend/src/app/ui/views/llm-config.ts:83-84`
- `frontend/src/app/ui/views/event-management.ts:671`
- `frontend/src/app/ui/views/instance-detail.ts:462`

**Issue:** Decision D-01 explicitly states `#7c5cff` purple accent is replaced with `#409eff` blue. However:

1. `alert-analysis-viewer.ts:54` renders the analysis-failed state with purple background `rgba(176,141,245,0.12)` and purple text `#b08df5`. This should use `--danger-subtle` and `--danger`.

2. `instance-trend-chart.ts:93` maps `critical` threshold color to hardcoded `#8b5cf6` (purple) instead of `var(--danger)`.

3. Three instance subcomponents share the same 8-color chart palette containing `#8b5cf6` (purple) — this is not the canonical blue `#409eff`.

4. Three views (`health-score-tab.ts`, `llm-config.ts`, `event-management.ts`) use `#8b5cf6` as brand/chart color — should use `var(--accent)` or `#409eff`.

**Fix:** Replace purple values:

```typescript
// alert-analysis-viewer.ts:54
background: var(--danger-subtle);
color: var(--danger);

// instance-trend-chart.ts:93
critical: "var(--danger)"

// Chart palettes: replace #8b5cf6 with #409eff
const palette = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#409eff', '#ec4899', '#14b8a6', '#f97316'];

// instance-detail.ts:462
color: "var(--accent)"

// health-score-tab.ts:475
color: "var(--accent)"
```

---

### CR-07: alert-list uses text "加载中..." instead of skeleton screens (contradicts D-16)

**File:** `frontend/src/app/ui/components/alert-list.ts:105-106`
**Issue:** Decision D-16 states all loading states should use skeleton screens instead of `"加载中..."` text. The alert-list component renders:

```typescript
if (this.loading) return html`<div class="loading">加载中...</div>`;
if (this.error) return html`<div class="loading" style="color:var(--destructive);">${this.error}</div>`;
```

No skeleton elements are rendered. With the table having 50+ alerts per page, the text flash is perceptible.

**Fix:** Render skeleton rows matching the table structure:

```typescript
if (this.loading) return html`
  <div style="padding:var(--space-lg);">
    ${[1,2,3,4,5].map(() => html`
      <div style="display:flex;gap:var(--space-md);padding:var(--space-md);border-bottom:1px solid var(--border);">
        <div class="skeleton skeleton-line skeleton-line--short"></div>
        <div class="skeleton skeleton-line skeleton-line--short"></div>
        <div class="skeleton skeleton-line skeleton-line--long"></div>
        <div class="skeleton skeleton-line skeleton-line--medium"></div>
      </div>
    `)}
  </div>`;
```

---

## WARNING

### WR-01: Three `console.warn` remain in alerts.ts orchestrator

**File:** `frontend/src/app/ui/views/alerts.ts:746,854,886`
**Issue:** Decision D-24 replaces `console.error/warn` with structured `showToast()`. The plan-08 summary says these 3 console.warn in alerts.ts are "kept for debug-only warnings." However, line 854 (`"确认告警失败:"`) and line 886 (`"_loadAnalysisHistory failed:"`) are runtime error paths where users would benefit from visual feedback. Silent console.warn in production is invisible to users.

**Fix:** Replace error-path console.warn with `showToast()`:

```typescript
// line 854
import { showToast } from "../components/app-toast-container.js";
// ...
catch (e) { showToast('Acknowledge alert failed', 'error'); }

// line 886
catch (err) { showToast('Failed to load analysis history', 'error'); }
```

---

### WR-02: `--info-subtle` token missing from tokens.css

**File:** `frontend/src/app/styles/tokens.css:73`
**File:** `frontend/src/app/ui/components/app-badge.ts:53`
**Issue:** `app-badge.ts` variant "info" uses `var(--info-subtle, rgba(37,99,235,0.12))`. But `--info-subtle` is never defined in tokens.css (only `--info` is). In dark mode, the fallback `rgba(37,99,235,0.12)` renders a light-mode blue background while the text color (`--info`, which resolves to `#60a5fa` in dark mode) is a different blue tone. The badge looks mismatched in dark mode.

All other semantic colors have `--*-subtle` tokens: `--ok-subtle`, `--warn-subtle`, `--danger-subtle`, `--accent-subtle`.

**Fix:** Add `--info-subtle` to both light and dark blocks in tokens.css:

```css
/* light */
--info-subtle: rgba(37, 99, 235, 0.08);
/* dark */
--info-subtle: rgba(96, 165, 250, 0.08);
```

---

### WR-03: Duplicate `customElements.define` — redundant try-catch block

**Files:**
- `frontend/src/app/ui/components/alert-list.ts:249`
- `frontend/src/app/ui/components/alert-detail-modal.ts:182`
- `frontend/src/app/ui/components/alert-rule-editor.ts:228`
- `frontend/src/app/ui/components/alert-analysis-viewer.ts:81`

**Issue:** All four alert subcomponents use both `@customElement("alert-*")` decorator (which calls `customElements.define`) AND a trailing `try { customElements.define(...) } catch` block. The explicit call always throws `DOMException` because the decorator already registered the element. The catch clause is always hit — this is dead code that wastes bytes and confuses readers.

Only alert subcomponents have this pattern; the 7 new shared components (`app-dialog`, `app-toast-container`, etc.) do not. The instance subcomponents use `if (!customElements.get(...)) { customElements.define(...) }` which is a cleaner pattern.

**Fix:** Remove the trailing `try/catch customElements.define` blocks from all four files. The `@customElement` decorator is sufficient.

---

### WR-04: `#8b5cf6` (purple) in chart color palettes across 3 instance subcomponents

**File:** `frontend/src/app/ui/components/instance-overview-tab.ts:159`
**File:** `frontend/src/app/ui/components/instance-metrics-tab.ts:94`
**File:** `frontend/src/app/ui/components/instance-trend-chart.ts:71`

**Issue:** Despite being new components created in Phase 120, each includes `#8b5cf6` in its 8-color chart palette array. While `#8b5cf6` is a standard chart color (not the accent color), the Phase explicitly commits to removing all purple references (D-01). Using purple as a chart series color visually conflicts with the blue accent system.

**Fix:** Replace `#8b5cf6` with a blue-toned alternative in each palette:
```
'#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#409eff', '#ec4899', '#14b8a6', '#f97316'
```

---

### WR-05: `#8b5cf6` (purple) used as brand/chart color in 4 existing views

**Files:**
- `frontend/src/app/ui/views/health-score-tab.ts:475`
- `frontend/src/app/ui/views/llm-config.ts:83-84`
- `frontend/src/app/ui/views/event-management.ts:671`
- `frontend/src/app/ui/views/instance-detail.ts:462`

**Issue:** Same purple `#8b5cf6` is used as a non-accent chart series color or brand color in these pre-existing views. These are not new in Phase 120, but Phase 120's mandate is to eliminate purple references across the system.

**Fix:** Replace with appropriate blue or semantic token:
- `health-score-tab.ts:475`: `"var(--accent)"` or `"#409eff"`
- `llm-config.ts:83-84`: use `"#409eff"` for moonshot/kimi provider colors
- `event-management.ts:671`: `"var(--danger)"` for critical severity
- `instance-detail.ts:462`: `"var(--accent)"` or `"#409eff"`

---

### WR-06: `#7c5cff` fallbacks in sql-console.ts inline styles

**File:** `frontend/src/app/ui/views/sql-console.ts:281-282,334,340,1413`
**Issue:** Four inline `style` attributes in the CSS template reference `#7c5cff` as fallback value (e.g., `var(--accent, #7c5cff)`). These are CSS-in-JS fallbacks for the `--accent` custom property — if the token is somehow undefined, the old purple shows up. These should fall back to `#409eff`.

**Fix:**
```typescript
// line 281
color: var(--accent, #409eff);
// line 282
border-color: var(--accent, #409eff);
// line 334
color: var(--accent, #409eff);
// line 340
border-color: var(--accent, #409eff);
// line 1413
color: var(--accent, #409eff);
```

---

### WR-07: dashboard.ts line 561 uses hardcoded `#7c5cff` for chart line color

**File:** `frontend/src/app/ui/views/dashboard.ts:561`
**Issue:** `lineStyle: { width: 2, color: "#7c5cff" }` — a purple chart line color in a Phase-120-modified file.

**Fix:** Change to `color: "#409eff"` or `color: "var(--accent)"` if the chart library supports CSS variable resolution.

---

### WR-08: `app-empty-state` icon slot/description slot vs prop ambiguity

**File:** `frontend/src/app/ui/components/app-empty-state.ts:72-78`
**Issue:** When both `description` prop and a `<slot>` (default unnamed) child exist, the template renders description text above the slotted content. This is unexpected — if someone passes both a description prop AND slotted content, they appear simultaneously rather than the slot replacing the description. The icon rendering similarly has a bug: if `icon` prop is set AND `<slot name="icon">` is used, the prop takes precedence (no conditional).

```typescript
${this.icon
  ? html`<div class="empty-state-icon">${this._renderIcon()}</div>`
  : html`<slot name="icon"></slot>`}
```

This means the icon slot is never functional if the `icon` prop is empty string (falsy). A user providing only `<span slot="icon">...</span>` with no `icon` prop would see the icon slot rendered. But the description slot is always rendered as a sibling to the title if the description prop is set, even if the user intended to provide custom content in the default slot.

**Fix:** Make description mutually exclusive with default slot:
```typescript
${this.description
  ? html`<div class="empty-state-description">${this.description}</div>`
  : this.title ? "" : html`<slot></slot>`}
```

---

### WR-09: `app-data-table` default array reference shared across instances

**File:** `frontend/src/app/ui/components/app-data-table.ts:23-24`
**Issue:** Lit `@property({ type: Array })` defaults `columns` and `rows` to `[]`. All component instances share the same default array reference. If any code path mutates these arrays (e.g., pushes to `columns`), it corrupts the default for all instances.

**Fix:** Use factory functions:
```typescript
@property({ type: Array }) columns: Column[] = [];
@property({ type: Array }) rows: Record<string, unknown>[] = [];
```

These defaults are fine if properties are always replaced wholesale (which they are in practice), but defensive coding would use `undefined` as default and check in the template.

---

### WR-10: `instance-detail.ts` missing error handler for `_loadTrendData`

**File:** `frontend/src/app/ui/views/instance-detail.ts` (unseen portion)
**Issue:** The plan summary mentions that trend data errors are handled "silent catch with loading state." If the `_loadTrendData` network request fails, the catch does `this.trendLoading = false` but provides no user feedback. The trend chart shows an empty state with no indication that the data failed to load rather than simply not existing.

**Fix:** Set an error state property that the trend chart can display:
```typescript
catch {
  this.trendLoading = false;
  this.trendError = 'Failed to load trend data';
}
```

---

### WR-11: `alert-rule-editor` CSS uses `active` class without definition

**File:** `frontend/src/app/ui/components/alert-rule-editor.ts:170-171`
**Issue:** The threshold-type toggle buttons use `class="${f.threshold_type === 'static' ? 'active' : ''}"` but there is no `.active` class defined in the component's Shadow DOM styles. The `active` class from global CSS (`.btn.active` in components.css:703) does not penetrate Shadow DOM. The buttons will not show the active/highlighted state.

```html
<button class="${f.threshold_type === 'static' ? 'active' : ''}" ...>
```

**Fix:** Add inline style or define `.active` in the component's styles:
```css
.active {
  background: var(--accent) !important;
  color: var(--accent-foreground) !important;
}
```

---

## INFO

### IN-01: alert-analysis-viewer and alert-rule-editor define `Alert` interface redundantly

**Files:** `alert-analysis-viewer.ts:16-25`, `alert-detail-modal.ts:18-33`, `alert-rule-editor.ts:16-31`, `alert-list.ts:22-37`

**Issue:** The `Alert` interface is defined in 4 separate files with near-identical shape. If the alert schema changes (e.g., new field added), each interface must be updated individually. Should be extracted to a shared type file.

---

### IN-02: `app-data-table` sort indicator uses unicode arrows instead of SVG icons

**File:** `frontend/src/app/ui/components/app-data-table.ts:147`
**Issue:** `"${this._sortDir === "asc" ? "▲" : "▼"}"` — unicode characters render inconsistently across platforms and don't support the project's SVG icon system.

---

### IN-03: `app-card` uses inline `<style>` tag instead of `static styles`

**File:** `frontend/src/app/ui/components/app-card.ts:39-69`
**Issue:** The entire card CSS is injected as an inline `<style>` tag inside the `render()` template. This means every render re-processes the style tag. For Light DOM, this is functional but wasteful. The `static styles` field (which Lit handles efficiently via adoptedStyleSheets or single <style> injection) would be preferable, but would require moving from inline `<style>` to `static styles = css` pattern.

---

### IN-04: `app-empty-state` also uses inline `<style>` tag

**File:** `frontend/src/app/ui/components/app-empty-state.ts:30-68`
**Issue:** Same pattern as IN-03. Inline `<style>` in render template instead of `static styles`.

---

### IN-05: Chat compose `handleFileSelect` missing error handling

**File:** `frontend/src/app/ui/components/chat-compose-area.ts:106-111`
**Issue:** `FileReader.onerror` is unhandled. If reading a pasted/dropped image fails (e.g., corrupted file, out of memory), the `pending` counter is never decremented and `onAttachmentsChange` is never called. The file is silently dropped with no user feedback.

**Fix:** Add error handler:
```typescript
r.addEventListener("error", () => {
  pending--;
  if (pending === 0 && additions.length > 0) {
    this.onAttachmentsChange?.([...current, ...additions]);
  }
});
```

---

### IN-06: `instance-overview-tab` missing `static styles` for app-card

**File:** `frontend/src/app/ui/components/instance-overview-tab.ts:165-176`
**Issue:** The component renders `<app-card>` with inline SVG icons in the header slot. The `app-card` component uses Light DOM with inline `<style>` tags (see IN-03). When using `<app-card>` inside an element that also uses Light DOM, the `<style>` tag from `app-card` is injected into the shared render root. This is not a bug per se, but it creates a pattern where each `app-card` instance adds its `<style>` tag to the Light DOM, potentially creating duplicate style blocks for each card in a list.

---

### IN-07: `chat-compose-area.ts` Map-based input histories not cleaned up

**File:** `frontend/src/app/ui/components/chat-compose-area.ts:16-17`
**Issue:** `inputHistories` is a module-level `Map<string, InputHistory>()` that grows indefinitely with each unique `sessionKey`. When sessions are deleted or cycled, their input histories remain in memory. No cleanup mechanism exists.

---

### IN-08: `chat.ts` module-level maps grow unbounded

**File:** `frontend/src/app/ui/views/chat.ts:108-113`
**Issue:** Five module-level `Map` instances (`pinnedMessagesMap`, `deletedMessagesMap`, `expandedToolCardsBySession`, `initializedToolCardsBySession`, `lastAutoExpandPrefBySession`) accumulate per-session state with no eviction. Over long-running sessions, memory grows with each unique session key.

---

### IN-09: `_renderBackLinks` regex uses while-loop without lastIndex reset

**File:** `frontend/src/app/ui/components/chat-message-list.ts:70-71`
**Issue:** The regex `/实例\s*[#:：]?\s*(\d+)/g` and `/告警\s*[#:：]?\s*(\d+)/g` are created fresh each call (inside `renderBackLinks`), so `lastIndex` starts at 0 each time. This is correct — no bug here. Flagging as info since the `while` + `exec` pattern is correct but could use `String.matchAll()` for clarity.

---

_Reviewed: 2026-06-18T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
