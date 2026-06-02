---
phase: 115
slug: openclaw-todo-ci
status: draft
shadcn_initialized: false
preset: none
created: 2026-06-02
---

# Phase 115 — UI Design Contract

> Visual and interaction contract for Phase 115: cleanup phase — no new UI components, no visual changes, no user-facing interaction changes. All tasks are backend/frontend cleanup, documentation updates, and CI setup.

---

## Design System

| Property | Status | Notes |
|----------|--------|-------|
| Tool | none (Lit + Vite Web Components) | shadcn/tailwind not used in this project |
| Preset | not applicable | — |
| Component library | none — custom Lit elements | Existing: `<stat-card>`, `<cron-jobs-settings>`, native Lit elements |
| Icon library | Canonical icon file (`icons.ts`) | Consolidated in Phase 102 |
| Font | Inter (body), JetBrains Mono (mono) | Defined in `global.css` |

**Phase 115 introduces no new UI components, icons, or font changes.** All work is dead code removal, import path fixes, alias renaming, and naming cleanup.

---

## Spacing Scale

**No changes — cleanup phase only.** The existing spacing tokens from `global.css` remain in effect:

| Token | Value | Usage |
|-------|-------|-------|
| `--shell-pad` | 16px | Page padding |
| — | 8px | Compact gaps (via Lit element inline styles) |
| — | 4px | Icon gaps |
| — | 24px | Section spacing |
| — | 32px | Layout gaps |

Exceptions: none in this phase.

The only potential spacing impact is D-13: renaming `direct-gateway.ts` file. This is a filename change with zero visual impact.

---

## Typography

**No changes — cleanup phase only.** Existing typography from `global.css` remains in effect:

| Role | Size | Weight | Line Height | Font |
|------|------|--------|-------------|------|
| Body | 14px (responsive to 15px at 1600px+) | 400 | 1.55 | `var(--font-body)` (Inter) |
| Headings (h1) | 2em | 600 | 1.25 | `var(--font-body)` |
| Headings (h2) | 1.5em | 600 | 1.25 | `var(--font-body)` |
| Headings (h3) | 1.25em | 600 | 1.25 | `var(--font-body)` |
| Headings (h4) | 1em | 600 | 1.25 | `var(--font-body)` |
| Mono | inherit | 400 | 1.55 | `var(--mono)` (JetBrains Mono) |

No typography changes in this phase.

---

## Color

**No changes — cleanup phase only.** Existing color system from `global.css` (light + dark themes) remains in effect:

| Role | Light Value | Dark Value | Existing Usage |
|------|-------------|------------|----------------|
| Background (`--bg`) | #f8f9fa | #0f0f12 | Page surfaces |
| Card (`--card`) | #ffffff | #18181b | Cards, elevated surfaces |
| Text (`--text`) | #3c3c43 | #a1a1aa | Body text |
| Accent (`--accent`) | #409eff | #60a5fa | Links, interactive elements |
| Destructive (`--destructive`) | #dc2626 | #f87171 | Delete/destructive actions |
| Semantic ok/warn/info | Multiple | Multiple | Status indicators |

No color changes in this phase.

---

## Copywriting Contract

**No new user-facing copy in this phase.** This phase does not introduce:

- No new CTA buttons or labels
- No new empty states
- No new error states
- No destructive action dialogs

Existing copy changes (D-08): Update i18n file `frontend/src/app/ui/__/zh-CN.ts` to replace "OpenClaw 菜单组" with neutral text. This is a text replacement, not a new copywriting element.

Refer to Phase 102-107 UI-SPECs for the established copywriting patterns that remain unchanged.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| N/A — no shadcn | none | not applicable |

No shadcn or third-party component registries in this project.

---

## Phase-Specific Visual Notes

### D-06: Dead code removal
Files to delete (no visual impact):
- `routing/bindings.ts` — dead import file
- `resolve-route.ts` — dead code
- `bound-account-read.ts` — dead code
- `protocol/CLAUDE.md` — outdated docs

### D-07 through D-13: Renaming and cleanup
- `openclaw`/`OpenClaw` naming → neutral aliases (rename in imports, comments, i18n)
- `gateway`/`Gateway` → retained (neutral term, not renamed)
- `openclaw/plugin-sdk/reply-payload` alias → renamed to neutral alias
- `direct-gateway.ts` → renamed (filename only, no visual change)
- `__openclaw` session marker → removed from chat.ts and direct-gateway.ts
- server.ts health endpoint gateway_version field → removed
- package.json gateway scripts → removed

**Visual impact: absolute zero** — these are all import paths, comments, type references, and build config.

### D-14 through D-16: CI setup
GitHub Actions workflow. No visual impact. Frontend job includes `npm run lint` and `vitest run`.

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: N/A — no new UI copy in this phase
- [ ] Dimension 2 Visuals: N/A — no visual changes in this phase
- [ ] Dimension 3 Color: N/A — no color changes in this phase
- [ ] Dimension 4 Typography: N/A — no typography changes in this phase
- [ ] Dimension 5 Spacing: N/A — no spacing changes in this phase
- [ ] Dimension 6 Registry Safety: N/A — no registry components used

**Approval:** pending

---

## Sources

| Source | Decisions Used |
|--------|----------------|
| CONTEXT.md (115-CONTEXT.md) | 16 decisions (D-01 through D-16) |
| global.css | Existing color/typography/spacing tokens documented for reference |
| vite.config.js | openclaw alias to be renamed per D-09 |
