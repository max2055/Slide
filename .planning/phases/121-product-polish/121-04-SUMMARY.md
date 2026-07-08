---
phase: 121-product-polish
plan: 04
status: complete
tasks_completed: 1/1
started: 2026-06-24T16:30:00Z
completed: 2026-06-24T16:33:00Z
---

# 121-04 Summary: 首次启动检查与演示准备度

## What was done
增强 health-center-page 的 readiness 区域，为每个准备度检查项添加修复建议和"建议操作"引导面板。

### Changes to health-center.ts
- **`_readinessItems()`** — 返回 5 项 readiness 配置，每项包含 key, label, status, severity (critical/major/minor), 和中文修复建议
- **`_allReady()`** — 布尔 helper，检查是否所有 5 项就绪
- **帮助图标** — 未就绪项显示 `?` 图标（`.item-suggestion`），`title` 属性包含修复建议 tooltip
- **「建议操作」面板** — 当系统不完全就绪时显示，按优先级列出所有待修复项的修复步骤
- **CSS** — 新增 `.readiness-banner`, `.readiness-title`, `.item-suggestion`, `.next-steps` 样式

### Readiness items with suggestions
| Item | Severity | Suggestion |
|------|----------|------------|
| 主数据库连接 | critical | 检查 .env 数据库配置及 MySQL 服务 |
| 纳管实例可达 | major | 在数据库实例页面添加并测试连接 |
| LLM Provider | major | 在 LLM 配置页面添加 Provider 和 API Key |
| Cron 定时任务 | minor | 在定时任务页面启用至少一个任务 |
| Agent 引擎 | critical | 检查 AGENT_WS_URL 配置和服务运行状态 |

### Verification
- `_allReady` / `_readinessItems` — ✓
- `title=` tooltip attribute — ✓
- `cd frontend && npm run build` — passed (exit 0)

### Deviations
None.

## Self-Check: PASSED
