---
phase: 121-product-polish
plan: 03
status: complete
tasks_completed: 2/2
started: 2026-06-24T15:35:36Z
completed: 2026-06-24T16:26:00Z
---

# 121-03 Summary: 设置页/管理页模板化验证

## What was done
对 8 个设置/管理页面执行了 grep guardrail 扫描，修复了所有发现的违规模式。

### Violations found and fixed

**rbac-page.ts (10 fixes):**
- `<div class="card">` → `<app-card>` — 用户实例权限区域
- 7 处 `<div class="empty">` → `<app-empty-state>`（角色/权限/用户/实例的空态）
- 2 处 `<span class="count-badge">` → `<app-badge variant="muted">`

**users-management.ts (2 fixes):**
- 2 处 `<span class="role-badge">` → `<app-badge variant="muted">`

**cron-jobs-settings.ts (1 fix):**
- `<div class="loading">暂无定时任务</div>` → `<app-empty-state>`

### Template compliance

| Page | Template | max-width 800px | app-card | sharedBtnStyles | Status |
|------|----------|-----------------|----------|-----------------|--------|
| ai-settings.ts | A | ✓ | ✓ | ✓ | PASS |
| llm-config.ts | A (modified) | N/A (2-col) | N/A | ✓ | PASS |
| scoring-settings.ts | A | ✓ | ✓ | ✓ | PASS |
| appearance-settings.ts | A | ✓ | ✓ | ✓ | PASS |
| branding-settings.ts | A | ✓ | ✓ | ✓ | PASS |
| users-management.ts | B | N/A | ✓ | ✓ | PASS |
| rbac-page.ts | B | N/A | ✓ | ✓ | PASS |
| cron-jobs-settings.ts | B | N/A | ✓ | ✓ | PASS |

Notes:
- llm-config.ts uses a two-column layout (provider list + detail panel), which deviates from Template A's single-column design. This is an intentional UX choice, not a bug.
- `ai-settings.ts:265,269` — `cfg-tags`/`cfg-tag` CSS classes are layout containers for tag chips, not semantic badge components. Soft violation, accepted.

### Verification
- `grep 'class="card"\|class="btn primary"\|modal-overlay'` → 0 lines (hard violations cleared)
- `cd frontend && npm run build` → passed (exit 0)

### Deviations
None.

## Self-Check: PASSED
