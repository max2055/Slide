---
gsd_state_version: 1.0
milestone: v0.8
milestone_name: 服务器纳管
status: roadmap_defined
last_updated: "2026-07-07T08:46:24.171Z"
last_activity: 2026-07-07
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

## Current Position

Phase: 124 — 服务器注册与凭据管理 (planning)
Plan: —
Status: Roadmap defined, awaiting /gsd-plan-phase 124
Last activity: 2026-07-07 — v0.8 roadmap created (Phases 124-128)

## v0.7 验收状态

- 119: ✅ Verified (UAT 9/9 passed, P0/P1 all fixed)
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

## Quick Tasks Completed

| Date | Task | Status |
|------|------|--------|
| 2026-07-07 | Button style consistency check | ✅ Complete (analysis only) |
| 2026-07-07 | Remove sidebar version display | ✅ Complete (committed efa10a7) |

## v0.8 Phase Structure

| Phase | Goal | Requirements | Status |
|-------|------|--------------|--------|
| 124. 服务器注册与凭据管理 | 用户可以纳管服务器并配置 SSH 凭据，查看服务器列表 | SRV-01, SRV-02, SRV-03, SRV-04, SRV-06, UI-01, UI-05 | Planning |
| 125. SSH 指标采集与监控视图 | 系统通过 SSH 定时采集服务器核心指标，用户在详情页以趋势图形式可视化 | COL-01~08, SRV-05, UI-02, UI-03 | Not started |
| 126. 服务器告警规则 | 用户可为服务器设置告警规则，系统在指标越界或服务器不可达时触发告警 | ALR-01~04, UI-04 | Not started |
| 127. 定时自动化巡检 | 系统定期生成服务器健康巡检报告，管理员可配置报告周期和通知方式 | RPT-01~04 | Not started |
| 128. AI 服务器分析 | Agent 可以通过工具查询服务器数据，在对话中回答问题，并集成到现有 AI 分析流程 | AI-01~04 | Not started |

## Deferred Items

Items acknowledged and deferred at v0.7 milestone close on 2026-07-07:

| Category | Item | Status |
|----------|------|--------|
| debug | cron-jobs-all-disabled | investigating |
| debug | dashboard-capacity-and-alert-events | investigating |
| debug | null-metrics-database-instances | investigating |
| debug | rbac-403-forbidden-RESOLVED | investigated |
| debug | rbac-403-forbidden | investigated |
| uat_gaps | Phase 110 | testing (6 pending) |
| uat_gaps | Phase 95 | testing (4 pending) |
| uat_gaps | Phase 109 | passed |
| uat_gaps | Phase 84 | partial |
| uat_gaps | Phase 94 | passed |
| verification_gaps | Phase 94 | gaps_found |
| todos | cron-tasks-configurable-not-hardcoded | backend |
