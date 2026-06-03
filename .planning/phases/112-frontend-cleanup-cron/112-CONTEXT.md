# Phase 112: 前端清理 & 定时任务可配置化 - Context

**Gathered:** 2026-05-27
**Status:** Ready for planning

## Phase Boundary

两条并行轨道：

1. **前端清理** — 清理 Gateway 移除后的前端 dead code：重命名 openclaw/ → app/，删除 protocol/、app-gateway.ts、失效占位视图和导航入口，统一 i18n 翻译文件
2. **定时任务可配置化** — 将 server.ts 中 13 个硬编码 CronJob 迁移到数据库驱动，提供 Settings 前端管理页面

## Implementation Decisions

### 前端文件重组

- **D-01:** `frontend/src/openclaw/` → `frontend/src/app/`。所有 import 路径同步更新
- **D-02:** `openclaw/protocol/` 目录全部删除（7 个 Gateway schema 文件 + AGENTS.md + CLAUDE.md）
- **D-03:** views/ 目录不分 Slide/OpenClaw 子目录，保持扁平结构
- **D-04:** 删除 `app-gateway.ts`（292 行，旧 Gateway WebSocket 协议），重构调用方（app-lifecycle.ts, app.ts, app-settings.ts）移除对旧协议的依赖
- **D-05:** 保留 controllers/ 目录（sessions.ts, agents.ts, chat.ts — Phase 111 精简后的 3 个 controller）
- **D-06:** i18n 翻译文件（de.ts, fr.ts, tr.ts, pt-BR.ts）精确删除已失效 Gateway 功能的翻译 key，保留仍在用的
- **D-07:** import 路径更新时同步清理 unused imports
- **D-08:** chat/ 子目录保留不动，只删除 slash-commands 相关的死 import（Phase 111 已删 8 个命令的注册逻辑）

### Placeholder 视图处理

- **D-09:** 保留 sessions 和 agents 视图（仍有 REST API），其余占位页全部删除（cron, skills, usage, config, overview, exec-approval, llm-config 等）并移除对应导航入口
- **D-10:** agents 3 个子面板占位页（tools-skills, overview, status-files）全部保留
- **D-11:** 导航栏移除失效入口并重新排序
- **D-12:** 删除 unavailable-page.ts 通用占位模板

### 定时任务配置模型

- **D-13:** 三表设计：
  - `cron_jobs` — 任务配置（name, cron_expr, enabled, timezone, description, handler, last_run_at, next_run_at, last_result, timeout_seconds, retry_count, created_at, updated_at）
  - `cron_job_logs` — 执行历史（job_id, started_at, finished_at, status, result_summary, error_message）
  - `cron_job_params` — 任务特定参数（job_id, param_key, param_value）
- **D-14:** 迁移策略：直接替换。SQL migration 建表 + seed 13 条初始数据（cron 表达式和 handler 与现有一致），新 CronManager 启动时只读 DB 配置，硬编码代码删除
- **D-15:** 全部 13 个 CronJob 纳入可配置范围（TopSQL, RCA, 故障诊断, 容量采集, Schema 快照, 索引采集, 基线计算, 基线清理, 日志采集, 静默清理, 报表调度 + 2 个其他）
- **D-16:** handler 字段存储代码中的处理函数标识符，CronManager 通过 name→handler 映射表分发

### 定时任务管理 UI

- **D-17:** Settings 页面新增「定时任务」tab，与 AI 设置并列
- **D-18:** 支持操作：enabled 开关、cron 表达式编辑、手动触发执行、运行日志查看
- **D-19:** 表格形式展示任务列表
- **D-20:** 权限：admin + dba 角色可管理
- **D-21:** 每次 cron 触发写一条 log 记录（started_at, finished_at, status, result_summary, error_message）
- **D-22:** 手动触发：确认弹窗 + 异步执行 + 前端 polling 更新状态
- **D-23:** cron 表达式编辑：文本输入 + 实时预览下次 5 次执行时间 + 常用模板下拉（每分钟/每5分钟/每小时/每天）

### Folded Todos

- **「定时任务改为可配置，不要硬编码在 server.ts」** — 来自 `.planning/todos/pending/2026-05-09-cron-tasks-configurable-not-hardcoded.md`，score 0.6，直接纳入本 phase 范围

### Claude's Discretion

- 表格列定义和具体 UI 样式（状态指示灯颜色、行展开样式）
- cron_job_logs 保留策略（默认建议保留 30 天）
- 手动触发的超时处理和错误反馈
- CronManager 的实现架构（类结构、handler 注册方式、错误处理策略）

## Canonical References

### 上游 Phase 产物（MUST READ）
- `.planning/phases/111-gateway-simplify/111-CONTEXT.md` — Phase 111 决定了哪些 controller/view 已删除，哪些 deferred 到 Phase 112
- `.planning/phases/109-nanobot/109-CONTEXT.md` — DirectAdapter 接管决策，WebSocket 协议简化
- `.planning/phases/108-agent/108-CONTEXT.md` — IAgentEngine 接口契约

### 前端代码（Phase 112 改动目标）
- `frontend/src/openclaw/ui/direct-gateway.ts` — DirectAdapter WebSocket 客户端（保留，是连接入口）
- `frontend/src/openclaw/ui/app-gateway.ts` — 旧 Gateway WebSocket 连接（待删除）
- `frontend/src/openclaw/ui/app.ts` — 主应用入口，导航/路由定义（需清理）
- `frontend/src/openclaw/ui/app-render.ts` — 视图渲染逻辑（需清理）
- `frontend/src/openclaw/ui/app-settings.ts` — 设置页入口（需添加定时任务 tab）
- `frontend/src/openclaw/ui/navigation.ts` — 导航定义（需移除失效条目）
- `frontend/src/openclaw/ui/app-lifecycle.ts` — 应用生命周期，引用 app-gateway（需重构）
- `frontend/src/openclaw/protocol/` — Gateway schema 文件（待全部删除）
- `frontend/src/openclaw/i18n/locales/` — 翻译文件（待清理失效 key）

### 后端代码
- `apps/db-ops-api/server.ts` — 13 个硬编码 CronJob（待提取到 DB + CronManager）

### 设计上下文
- `.planning/ROADMAP.md` — Phase 112 需求和 success criteria
- `frontend/src/openclaw/ui/controllers/` — 精简后的 3 个 controller（sessions.ts, agents.ts, chat.ts）
- `frontend/src/openclaw/ui/views/` — ~60 个 view 文件（待分类清理）

## Existing Code Insights

### Reusable Assets
- **DirectGatewayClient** (`direct-gateway.ts`): 前端 WebSocket 通信的唯一入口，需确保清理不破坏它
- **Lit 组件模式**: 所有 view 都是 LitElement，定时任务管理页遵循相同模式
- **Settings tab 模式**: `app-settings.ts` 已有多 tab 结构（AI 设置、LLM 配置），新增 tab 遵循现有模式
- **CronJob (cron 库)**: server.ts 已使用 `cron` npm 包，CronManager 可复用

### Established Patterns
- **Controller 模式**: 每个 controller 导出 async 函数，接收 client 参数
- **RBAC 中间件**: `requireRole` 模式用于 API 权限控制，定时任务 API 复用
- **Migration + Seed**: Phase 106 有 SQL migration + seed 的先例
- **REST API 模式**: Fastify route handler + 参数验证，定时任务 CRUD 遵循

### Integration Points
- `app.ts` → 导航路由，需移除失效条目
- `app-render.ts` → view 渲染，需移除已删除 view 的渲染分支
- `app-settings.ts` → Settings 页，需新增 tab
- `server.ts` → 启动入口，需用 CronManager 替换硬编码 CronJob
- 前端 WebSocket → port 28789 → DirectAdapter（保持不变）

## Deferred Ideas

- 为已删除的 Gateway 功能实现 REST API 替代 — 后续 milestone
- `openclaw/` 目录下的非 UI 文件（如 types, utils）重组 — Phase 112 只做目录重命名，不重构子结构
- 定时任务参数模板/预设 — Phase 112 只做 cron 表达式预览，不做参数模板
- 定时任务运行统计/仪表板 — 超出本 phase 范围

---

*Phase: 112-frontend-cleanup-cron*
*Context gathered: 2026-05-27*
