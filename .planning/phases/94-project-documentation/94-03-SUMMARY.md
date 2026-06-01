---
phase: 94-project-documentation
plan: 03
subsystem: docs-viewer
tags:
  - docs
  - frontend
  - backend
  - markdown
requires: []
provides:
  - GET /api/docs/list (backend endpoint)
  - GET /api/docs/content/:file (backend endpoint)
  - docs-viewer-page (frontend web component)
affects:
  - apps/db-ops-api/server.ts
  - frontend/src/openclaw/ui/navigation.ts
  - frontend/src/openclaw/ui/app-render.ts
  - frontend/src/openclaw/i18n/locales/zh-CN.ts
  - frontend/src/openclaw/ui/views/docs-viewer.ts
tech-stack:
  added: []
  patterns:
    - "Fastify GET route with path traversal validation"
    - "LitElement custom element for tab view"
    - "markdown-it + DOMPurify via toSanitizedMarkdownHtml"
key-files:
  created:
    - frontend/src/openclaw/ui/views/docs-viewer.ts
  modified:
    - apps/db-ops-api/server.ts
    - frontend/src/openclaw/ui/navigation.ts
    - frontend/src/openclaw/ui/app-render.ts
    - frontend/src/openclaw/i18n/locales/zh-CN.ts
decisions:
  - "use __dirname for docs directory resolution (tsx provides CJS compat in ESM)"
  - "tab named 'docs' in slide group, after 'events'"
  - "sidebar footer link changed from external anchor to internal dispatchEvent button"
  - "import cleanup: removed unused buildExternalLinkRel and EXTERNAL_LINK_TARGET"
metrics:
  duration: 10m
  completed: "2026-05-17"
---

# Phase 94 Plan 03: Docs Viewer Summary

构建前端文档查看器，通过左下角"文档"链接跳转到嵌入式文档浏览器（使用现有 markdown-it 渲染），并添加后端 API 端点来提供 docs/slide/ 中的 markdown 内容。

## Tasks Executed

### Task 1: Add backend API endpoints to serve docs

Added two GET endpoints to `apps/db-ops-api/server.ts`:
- `GET /api/docs/list` -- 返回 `docs/slide/` 目录下的 .md 文件列表
- `GET /api/docs/content/:file` -- 返回指定 .md 文件的原始内容，含路径遍历保护

**Commit:** `1c180219751`

### Task 2: Add "docs" tab to navigation system

Modified `frontend/src/openclaw/ui/navigation.ts`:
- Added `"docs"` to `Tab` type union
- Added `docs: "/docs"` to `TAB_PATHS`
- Added `case "docs": return "book"` to `iconForTab`
- Added `"docs"` to `TAB_GROUPS` slide group (after "events")

Modified `frontend/src/openclaw/i18n/locales/zh-CN.ts`:
- Added `tabs.docs: "文档"`
- Added `subtitles.docs: "项目文档"`

**Commit:** `bb6a18294a2`

### Task 3: Create docs viewer web component

Created `frontend/src/openclaw/ui/views/docs-viewer.ts`:
- Defines `<docs-viewer-page>` custom element (LitElement)
- Sidebar listing all docs from `/api/docs/list`
- Content area renders markdown via `toSanitizedMarkdownHtml` + `unsafeHTML`
- Handles loading / error / empty states

**Commit:** `1a1221f6ef2`

### Task 4: Wire up docs tab in app-render and change sidebar link

Modified `frontend/src/openclaw/ui/app-render.ts`:
- Added `import "./views/docs-viewer.ts"`
- Added docs tab rendering block after events tab
- Replaced sidebar external `<a>` link (pointing to `slide-ops.com/docs`) with an internal `<button>` dispatching `slide-navigate` custom event with `{ tab: "docs" }`
- Removed unused imports (`buildExternalLinkRel`, `EXTERNAL_LINK_TARGET`)
- **Associated cleanup commit:** `a23f0d3c375`

**Commit:** `a39379e1447`

## List of All Commits

| Hash | Message |
|------|---------|
| `1c180219751` | feat(94-03): add backend API endpoints for docs serving |
| `bb6a18294a2` | feat(94-03): add "docs" tab to navigation system and i18n |
| `1a1221f6ef2` | feat(94-03): create docs-viewer-page web component for in-app docs browsing |
| `a39379e1447` | feat(94-03): wire up docs viewer tab in app-render and sidebar |
| `a23f0d3c375` | chore(94-03): remove unused imports from app-render.ts |

## Verification

- `grep` confirmed all endpoints exist with path traversal protection and .md extension check
- `grep` confirmed "docs" in Tab type, TAB_PATHS, iconForTab, TAB_GROUPS
- `grep` confirmed i18n strings for tabs.docs and subtitles.docs
- File existence and content checks passed for docs-viewer.ts
- `grep` confirmed docs-viewer import, tab render block, and sidebar nav in app-render.ts
- External URL `slide-ops.com/docs` removed from app-render.ts

## Deviations from Plan

### Rule 2 - Auto-clean unused imports

When the sidebar external docs link was changed to internal navigation, `buildExternalLinkRel` and `EXTERNAL_LINK_TARGET` became unused in `app-render.ts`. Removed from imports in a follow-up commit.

### Threat Surface

Covered by plan's threat model:
- Path traversal: backing validating file param (blocks `..`, `/`, `\` and non-.md files)
- Frontend XSS: `toSanitizedMarkdownHtml` runs DOMPurify sanitization

No new threat surface introduced.

## Known Stubs

None.

## Success Criteria

- [x] Backend `/api/docs/list` and `/api/docs/content/:file` endpoints working
- [x] Path traversal attack blocked (returns 400)
- [x] Frontend `<docs-viewer-page>` component renders markdown
- [x] Sidebar "文档" link changed to internal navigation
- [x] All existing UI functionality unaffected
