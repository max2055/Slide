---
gsd_state_version: 1.0
milestone: v0.7
milestone_name: 打磨与优化
status: milestone_active
last_updated: 2026-07-01T09:00:00.000Z
last_activity: 2026-07-01 -- Phase 123 Plan 05 executed: AI 提示词优化 + invoke 流式hook
progress:
  total_phases: 23
  completed_phases: 23
  total_plans: 22
  completed_plans: 22
  percent: 100
stopped_at: Phase 123 fully complete — AI prompt optimization + invoke streaming hook
---

## Current Position

Phase: 123 (Plan 05 新增)
Status: ✅ Complete — AI 功能打磨 & 提示词优化
Last activity: 2026-07-01

## v0.7 验收状态

- 119: ✅ UAT 8/9 passed
- 120: ✅ Verified
- 121: ✅ Verified
- 122: ✅ UAT 10/10 passed
- 123: ✅ Complete (5 plans)

## Phase 123 Plan 05: AI 提示词优化工具

### Prompt 版本管理
- 创建 `src/prompts/prompt-manager.ts`，支持多版本加载、运行时切换、文件写回、热重载
- 创建 `src/prompts/versions/` 目录，每个类型 v1（原内容）+ v2（优化版）
- 支持 `PROMPT_VERSION` 环境变量和 `PROMPT_AB_TEST` A/B 测试模式

### API 端点
- `GET /api/ai/prompts` — 列出所有提示词类型和版本
- `GET /api/ai/prompts/:type` — 获取单个类型详情
- `POST /api/ai/prompts/:type/switch` — 切换活跃版本
- `PUT /api/ai/prompts/:type/versions/:version` — 编辑版本内容（写回文件）
- `POST /api/ai/prompts/:type/versions` — 创建新版本
- `POST /api/ai/prompts/:type/optimize` — AI 辅助优化（调用项目 Agent）

### 前端管理页
- 新增 "提示词管理" 页面（设置 → 提示词管理）
- 支持版本切换、内联编辑、AI 优化、新建版本

### SKILL.md 工具引用修复
- fault-diagnosis、alert-rca、topsql-analysis 中虚构的 `db_*` 工具引用 → 替换为实际工具
- check_health SKILL.md 和 tools.ts 描述重写（从"检查health的快速命令"到有意义的描述）

### invoke() 流式 hook
- 将 `NoopHook` 替换为自定义 hook，捕获 thinking 和工具调用
- 最终结果嵌入 `<think>` 标签，前端可渲染为折叠思考过程
- 修复 `hook.beforeIteration is not a function` 运行时错误

### 其他修复
- 定时任务页面 15s 自动刷新闪屏修复（拆分 loadCronJobs / refreshCronJobs）
