# Roadmap: Slide — AI 驱动的数据库运维平台

## Milestones

- ✅ **v1.1 RBAC + SQL Console + Dashboard** — Phases 84-89 (shipped 2026-05-13)
- ✅ **v1.2 UI + AI + Docs** — Phases 90-99 (shipped 2026-05-20)
- ✅ **v1.3 系统加固与体验优化** — Phases 100-107 (shipped 2026-05-22)
- ✅ **v1.4 Agent 解耦与替换** — Phases 108-118 (shipped 2026-06-08)
- ✅ **v1.5 打磨与优化** — Phases 119-120 (shipped 2026-06-20)

## Phases

<details>
<summary>✅ v1.1 RBAC + SQL Console + Dashboard (Phases 84-89) — SHIPPED 2026-05-13</summary>

- [x] Phase 84: RBAC Foundation (4/4 plans) — completed 2026-05-09
- [x] Phase 85: RBAC Frontend (2/2 plans) — completed 2026-05-10
- [x] Phase 86: SQL Console Upgrade (5/5 plans) — completed 2026-05-10
- [x] Phase 87: Approval Enhancement (4/4 plans) — completed 2026-05-11
- [x] Phase 88: Dashboard Upgrade (2/2 plans) — completed 2026-05-11
- [x] Phase 89: Gap Closure (5/5 plans) — completed 2026-05-13

</details>

<details>
<summary>✅ v1.2 UI + AI + Docs (Phases 90-99) — SHIPPED 2026-05-20</summary>

- [x] **Phase 90: OpenClaw Upstream Merge** — Merge upstream security fixes and gateway stability updates (deferred: risk too high, upstream diverged too far)
- [x] **Phase 91: UI Standardization** — Unify CSS variables, layout, and streamline navigation
- [x] **Phase 92: AI Analysis Visibility** — Display AI analysis results in alert list and instance details (completed 2026-05-14)
- [x] **Phase 93: AI Agent Ops Assistant** — Enhance Chat with database ops context (gap closure WIP) (completed 2026-05-15)
- [x] **Phase 94: Project Documentation** — Write architecture, operations, and user guide (completed 2026-05-17)
- [x] **Phase 95: Dameng Database Support** — Add Dameng (达梦) database management support (completed 2026-05-18)
- [x] **Phase 96: Oracle Database Support** — Add Oracle database management support (gap closure WIP)
- [x] **Phase 97: SQL History Persistence** — Persist SQL execution history to database (completed 2026-05-20)
- [x] **Phase 98: Chat Agent Selector UI** — Migrate Agent selector from latest OpenClaw to Slide Chat (completed 2026-05-16)
- [x] **Phase 99: db-connection-auto-recovery** — Auto-detect dead connections + reconnect on next query (completed 2026-05-19)

### Phase 90: OpenClaw Upstream Merge
**Goal**: Upstream security fixes and gateway stability merged into Slide without regression
**Depends on**: Nothing (foundation for v1.2)
**Requirements**: MISC-01
**Success Criteria** (what must be TRUE):
  1. upstream/main is merged into slide-custom with all conflicts resolved
  2. Gateway WebSocket connections establish and maintain stability
  3. Core features (chat, tools) function normally post-merge
  4. All tests pass with no regressions
**Plans**: 2 plans
Plans:
- [x] 91-01-PLAN.md -- Remove dead navigation entries, clean app-render.ts, delete orphaned view files
- [x] 91-02-PLAN.md -- Add unified CSS design tokens (--text-*, --space-*), apply to dashboard, approval, sql-console

### Phase 91: UI Standardization
**Goal**: Consistent, clean UI across all pages with streamlined navigation
**Depends on**: Phase 90
**Requirements**: UI-01, UI-02
**Success Criteria** (what must be TRUE):
  1. All pages use unified CSS variables (font-size, icon-size, spacing, radius)
  2. Tables, cards, buttons, badges have consistent styling
  3. Dark/light theme toggle works without visual glitches
  4. Irrelevant OpenClaw tabs (sessions, usage, skills, config, appearance, system) are removed
  5. No dead code remnants (types, paths, event listeners) from removed menu items
**Plans**: 2 plans
Plans:
- [x] 91-01-PLAN.md -- Remove dead navigation entries, clean app-render.ts, delete orphaned view files
- [x] 91-02-PLAN.md -- Add unified CSS design tokens (--text-*, --space-*), apply to dashboard, approval, sql-console
**UI hint**: yes

### Phase 92: AI Analysis Visibility
**Goal**: Users can see AI analysis results directly on alert list and instance detail pages
**Depends on**: Phase 90
**Requirements**: AI-01
**Success Criteria** (what must be TRUE):
  1. Alert list shows "analyzed" badge for alerts with AI analysis results
  2. Clicking an analyzed alert opens a view showing RCA/diagnosis results
  3. Instance detail page displays recent AI diagnosis summaries
  4. Analysis results are stored and displayed in a unified format across all analysis types
**Plans**: 5 plans
**UI hint**: yes
Plans:
**Wave 1**
- [x] 92-01-PLAN.md -- Backend tool rewrite (Markdown) + Agent skill files
- [x] 92-02-PLAN.md -- Frontend ai-analysis-result component refactor (data-driven)
- [x] 92-03-PLAN.md -- Backend config service + API routes (recent / config CRUD)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 92-04-PLAN.md -- Frontend alerts.ts (status badges, result modal, config panel)
- [x] 92-05-PLAN.md -- Frontend instance-detail.ts (diagnosis history section)

### Phase 93: AI Agent Ops Assistant
**Goal**: Chat AI can read and answer questions about database ops context, with configurable AI analysis settings
**Depends on**: Phase 90
**Requirements**: AI-02
**Success Criteria** (what must be TRUE):
  1. Chat AI can answer questions like "which instances have issues" with current health data
  2. Chat AI can retrieve and explain recent slow queries
  3. Chat AI can discuss active alerts and their status
  4. AI analysis configuration (master toggle, severity levels, instance whitelist, time window) is manageable from a dedicated settings page
  5. Chat streaming works without loading animation stalls when Gateway creates new sessions mid-run
  6. "/new" command switches chat session immediately without blank flash
**Plans**: 6 plans
**UI hint**: yes
Plans:
**Wave 1**
- [x] 93-01-PLAN.md -- AI Settings configuration page (Settings tab, config form, save/persist)
- [x] 93-02-PLAN.md -- Chat state management port (dual run-id matching, /new local handling, deferred session reload)
- [x] 93-03-PLAN.md -- Ops context tools + intent classification (list_active_alerts, get_instance_summary, intent classifier, greeting)
- [x] 93-04-PLAN.md -- Chat back-links + cleanup (navigation links in tool results, heartbeat stripping, notification/guards verification)

**Wave 2** *(gap closure)*
- [x] 93-05-PLAN.md -- Gap: Slow query retrieval (replace stub with real metricsDatabaseService.getSlowQueries)
- [x] 93-06-PLAN.md -- Gap: Wire agent greeting (API endpoint + frontend display in welcome section)

### Phase 94: Project Documentation
**Goal**: Complete documentation covering architecture, operations, and user guide
**Depends on**: Phase 90, Phase 91, Phase 92, Phase 93 (should reflect final v1.2 feature set)
**Requirements**: DOC-01
**Success Criteria** (what must be TRUE):
  1. ARCHITECTURE.md documents system architecture, module relationships, and data flow
  2. OPERATIONS.md documents deployment, configuration, startup/shutdown procedures
  3. USER-GUIDE.md covers all feature modules with usage instructions
  4. docs/ directory has clear, navigable structure
**Plans**: 2 plans
Plans:
**Wave 1**
- [x] 94-01-PLAN.md -- File cleanup (delete 229 OpenClaw upstream docs, move root files per D-03) + ARCHITECTURE.md (system arch with Mermaid diagrams)
- [x] 94-02-PLAN.md -- OPERATIONS.md (full-stack ops: backend, Gateway, frontend, deps) + USER-GUIDE.md (v1.2 all modules, with FAQ and screenshot placeholders)

### Phase 95: Dameng Database Support
**Goal**: Add Dameng database management capability — connection, SQL console, metrics, slow queries
**Depends on**: Phase 90
**Requirements**: DB-01
**Success Criteria** (what must be TRUE):
  1. Instance management supports adding Dameng database instances
  2. SQL Console supports Dameng SQL dialect (syntax highlight, autocomplete, EXPLAIN)
  3. Metrics collection supports Dameng (connections, QPS, capacity, etc.)
  4. Instance detail page shows Dameng-specific info (tablespace, schema)
**Plans**: 2 plans
Plans:
**Wave 1**
- [x] 95-01-PLAN.md -- dmdb 驱动迁移 + 达梦专属会话/容量方法 + 分派器拆分 + 指标注册 + Agent 工具
- [x] 95-02-PLAN.md -- CodeMirror 达梦方言（前端 SQL 控制台）

### Phase 96: Oracle Database Support
**Goal**: Add Oracle database management capability — connection, SQL console, metrics
**Depends on**: Phase 90
**Requirements**: DB-02
**Success Criteria** (what must be TRUE):
  1. Instance management supports adding Oracle database instances
  2. SQL Console supports Oracle SQL dialect (PL/SQL highlight, autocomplete)
  3. Metrics collection supports Oracle (SGA/PGA, tablespace, sessions, etc.)
  4. Instance detail page shows Oracle-specific info
**Plans**: 3 plans
Plans:
**Wave 1**
- [x] 96-01-PLAN.md -- Backend: pool upgrade (D-14), TCPS (D-13), fetchAs (D-17), SGA/PGA size in metrics, 3 bug fixes, metric-registry Oracle registration (D-01/D-02), SID/Service Name + TCPS testConnection (D-12/D-13), agent tools extension (D-09) + 3 new tools (D-10)
- [x] 96-02-PLAN.md -- Frontend: OracleDialect PL/SQL highlighting (D-04/D-05/D-06), add-instance Oracle identifier field (D-12), overview tab Oracle cards (D-07/D-08)
- [x] 96-03-PLAN.md -- Gap closure: fix 4 verification bugs (CR-01 ASH param, CR-03 null crash, WR-01 commit statistic, WR-02 DBA fallback)

### Phase 97: SQL History Persistence
**Goal**: Persist SQL execution history to database for audit and review
**Depends on**: Phase 96
**Requirements**: MISC-02
**Success Criteria** (what must be TRUE):
  1. SQL execution history is persisted to database
  2. Users can view their SQL execution history
  3. History supports filtering by instance and time range
**Plans**: 1 plan
Plans:
- [x] 97-01-PLAN.md -- Persist SQL execution history to database

### Phase 98: Chat Agent Selector UI
**Goal**: Migrate latest OpenClaw's Agent selector dropdown to Slide Chat page
**Depends on**: Nothing (UI-only change, no backend dependency)
**Requirements**: None (standalone enhancement)
**Success Criteria** (what must be TRUE):
  1. Agent dropdown renders at top of Chat page (when multiple agents exist)
  2. Agent list comes from gateway `agentsList`
  3. Switching agent auto-navigates to that agent's main/recent session
  4. Existing Session/Model/Thinking selectors unchanged
**Plans**: 1 plan
Plans:
- [x] 98-01-PLAN.md -- Port agent selector from OpenClaw upstream and wire into Chat page

### Phase 99: db-connection-auto-recovery

**Goal:** 纳管数据库断开后自动检测并重连，实例状态随数据库状态实时同步
**Requirements**: BUG-01
**Depends on:** Phase 98
**Plans:** 2/2 plans complete

Plans:
**Wave 1**
- [x] 99-01-PLAN.md -- database-service.ts: connection health check, reconnect, auto-reconnect wrapper, mysql keepalive
**Wave 2** *(blocked on Wave 1)*
- [x] 99-02-PLAN.md -- monitor-collector.ts: recovery trigger on metrics collection failure

</details>

### ✅ v1.3 系统加固与体验优化 (Complete)

- [x] **Phase 100: 安全紧急修复** — 修复4个未受保护路由的auth中间件、登录页崩溃、重复告警、硬编码健康评分 (completed 2026-05-20)
- [x] **Phase 101: 认证权限** — JWT refresh token、前端401透明刷新、时效性授权、实例级访问控制、权限感知导航 (completed 2026-05-20)
- [x] **Phase 102: UI 统一** — 图标文件合并、33个缺失图标补充、命名规范统一、ov-card提为共享组件、替换emoji/内联SVG (completed 2026-05-21)
- [x] **Phase 103: 报表重构** — EJS模板提取、定时报表配置、报表类型命名统一、共享组件替换ov-card (completed 2026-05-21)
- [x] **Phase 104: 告警系统增强** — 阈值可编辑、启用/禁用开关、threshold_type持久化、事件聚合边界碰撞修复 (completed 2026-05-21)
- [x] **Phase 105: 数据质量** — 实例评分算法、评分趋势图表、采集能力检测、健康状态逐项详情 (completed 2026-05-21)
- [x] **Phase 106: 指标采集可配置化** — 打通指标定义与采集的断裂，支持自定义采集SQL、动态指标存储 (completed 2026-05-22)
- [x] **Phase 107: 实例详情页指标动态化** — 根据实例 db_type 动态读取指标定义，自动渲染概览卡片和趋势图，替代硬编码指标 (completed 2026-05-22)

## 📋 v1.4 Agent 解耦与替换 (In Progress)

- [x] **Phase 108: Agent 抽象层** — 定义 Slide 与 Agent 的接口契约，实现 OpenClaw 适配器，平台代码只依赖接口 (completed 2026-05-25)
- [x] **Phase 109: Agent 引擎补全 & DirectAdapter 接管** — 补全 agent-core (超时/Session/Context/Memory/Checkpoint/Subagent)，移除 Gateway，前端适配 (completed 2026-05-26)
- [x] **Phase 110: DirectAdapter 默认切换 & 端到端验证** — 将 DirectGatewayClient 设为默认连接，移除 feature flag，端到端验证 (completed 2026-05-26)
- [x] **Phase 111: Gateway 简化** — 清理 DirectAdapter 模式下已失效的 Gateway RPC controller、view 和 slash command (completed 2026-05-26)
- [x] **Phase 112: 前端清理 & 定时任务可配置化** — 清理 Gateway 移除后的前端 dead code，WebSocket 路径统一，定时任务从硬编码迁移到可配置系统 (completed 2026-05-27)
- [x] **Phase 113: AI Agent Cron** — 自然语言驱动定时任务，替代 13 个硬编码 handler (completed 2026-05-27)
- [x] **Phase 114: Verification 清账** — 执行 Phase 100/102/112 遗留的 12 项 human_needed 验证 (completed 2026-05-27)
- [x] **Phase 115: 去 OpenClaw 迁移后清理** — 清理迁移遗留事项：删除 Agent LLM 工具、修复 TODO、清理残留引用、添加 CI (completed 2026-06-02)
- [x] **Phase 116: 去 OpenClaw 运行时引用** — 替换运行时 CLI 名、环境变量、数据目录、Symbol 键、用户可见消息 (completed 2026-06-02)
- [x] **Phase 117: OpenClaw 收尾** — SlideConfig 重命名、branding 配置、死代码清理、tsc 0 error (completed 2026-06-03)
- 🚧 **Phase 118: Agent DB 连接 + 告警机制完善** — Agent 获取 DB 连接信息、修复告警误报/漏报 (planned 2026-06-08)

## Phase Details

### Phase 100: 安全紧急修复
**Goal**: 紧急修复生产环境安全漏洞（4个未受保护API路由）和运行时崩溃（缺失图标），消除重复告警和虚假健康评分
**Depends on**: Phase 99
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04
**Success Criteria** (what must be TRUE):
  1. Unauthenticated requests to GET /api/alerts, GET /api/metrics/:instanceId, GET /api/database/instances, GET /api/chat/history return 401 instead of data
  2. Login page renders without JavaScript runtime errors (eyeOff icon loads correctly)
  3. No duplicate alerts are created — all alerts originate from alert-engine, not monitor-collector
  4. Health reports show actual computed scores, not hardcoded 100
**Plans**: 2 plans
Plans:
- [x] 100-01-PLAN.md -- 为 4 个 GET 路由添加 auth 中间件 + 修复 eyeOff 图标渲染属性
- [x] 100-02-PLAN.md -- 移除 monitor-collector 重复 checkAlerts() + 修复 3 处硬编码 health_score

### Phase 101: 认证权限
**Goal**: 实现JWT refresh token机制和精细化权限管控，消除登录丢失问题
**Depends on**: Phase 100
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05
**Success Criteria** (what must be TRUE):
  1. User can stay logged in across browser sessions without re-entering credentials; JWT auto-refreshes transparently via refresh token rotation
  2. When JWT expires during active session, frontend ApiClient automatically retries the request after transparent token refresh — no user-visible error
  3. Temporary role grants with expiry are automatically revoked on expiration date; user loses associated permissions at midnight of expiry
  4. Instance-level permissions differentiate read-only, read-write, and admin access levels; users are restricted per instance accordingly
  5. Frontend navigation hides menu items the user does not have permission to access
**Plans**: 4 plans
Plans:
**Wave 1**
- [x] 101-01-PLAN.md -- Refresh Token 后端基础设施 + 时效性授权 (AUTH-01, AUTH-03)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 101-02-PLAN.md -- 实例级访问级别 + 用户权限 API (AUTH-04, AUTH-05 backend)
- [x] 101-03-PLAN.md -- 前端 ApiClient 401 拦截器和透明刷新 (AUTH-02)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 101-04-PLAN.md -- 前端权限感知导航隐藏 (AUTH-05 frontend)
**UI hint**: yes

### Phase 102: UI 统一
**Goal**: 统一前端图标系统和卡片组件，消除缺失图标导致的UI裂痕
**Depends on**: Phase 101
**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-05
**Success Criteria** (what must be TRUE):
  1. All icons are referenced from a single canonical icon file — no imports from the deprecated styles/icons.ts
  2. All 33 previously missing icons (including eyeOff, barChart, fileText, checkCircle) render correctly in their respective views
  3. Icon naming conventions are consistent across the entire codebase (no kebab-case vs camelCase mixing)
  4. 6 views previously using ov-card CSS now render stat cards via the shared <stat-card> Lit component with all color variants supported
  5. No emoji characters or inline SVG paths remain in views — all icons use shared icon calls from the canonical file
**Plans**: 3 plans
Plans:
**Wave 1**
- [x] 102-01-PLAN.md -- Create merged canonical icon file (icons.ts), update ~30 import paths, batch-rename ~100+ camelCase references to kebab-case, delete old icon files

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 102-02-PLAN.md -- Create shared <stat-card> LitElement component, migrate 6 views (dashboard, alerts, instances-db, reports, schema-management, overview-cards), delete ov-card CSS
- [x] 102-03-PLAN.md -- Replace 4 structural emoji with renderIcon() calls, human verification of all affected views
**UI hint**: yes

### Phase 103: 报表重构
**Goal**: 重构报表模板系统为EJS文件，新增定时报表配置，统一报表类型命名
**Depends on**: Phase 102 (共用 <stat-card> 组件)
**Requirements**: RPT-01, RPT-02, RPT-03, RPT-04
**Success Criteria** (what must be TRUE):
  1. Report HTML templates are loaded from EJS template files (new ejs@5.0.2 dependency), not inline HTML strings in report-service.ts
  2. Users can create report configs with cron schedules for automatic report generation via new report_configs table
  3. Report type names are consistent across all code paths — slow_query is the canonical name; existing slow-query data is migrated
  4. Report views use shared <stat-card> component instead of ov-card CSS classes (satisfied by Phase 102)
**Plans**: 3 plans

Plans:
**Wave 1**
- [x] 103-01-PLAN.md -- EJS Templates + Report Type Naming Backend (RPT-01, RPT-03)
- [x] 103-02-PLAN.md -- Report Configs Backend: DB + API + CronJob (RPT-02)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 103-03-PLAN.md -- Report Configs Frontend UI + Type Label Fix (RPT-02, RPT-03)
**UI hint**: yes

### Phase 104: 告警系统增强
**Goal**: 增强告警规则可编辑性，修复阈值持久化和事件聚合边界问题
**Depends on**: Phase 101
**Requirements**: ALERT-01, ALERT-02, ALERT-03, ALERT-04
**Success Criteria** (what must be TRUE):
  1. Users can edit 3-level thresholds (warning/error/critical) in alert rule editor and changes persist after save and page reload
  2. Users can toggle alert rules on/off via frontend switch; the enabled/disabled state persists across sessions
  3. threshold_type (static/dynamic) and silence_minutes configurations persist to database and survive save/reload cycle
  4. Related alerts within a 10-minute window are correctly grouped into one event — no split-incident due to 5-minute fixed bucket boundary
**Plans**: 3 plans

Plans:
**Wave 1**
- [x] 104-01-PLAN.md -- Backend CRUD: fix AlertRule interface, SELECT/INSERT/UPDATE for threshold_type, dynamic_config, silence_minutes; fix route handlers
- [x] 104-02-PLAN.md -- Backend: replace event-aggregator.ts FLOOR bucket with sliding 10-min window

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 104-03-PLAN.md -- Frontend: three-level threshold inputs, threshold_type toggle, silence_minutes, inline enable/disable toggle
**UI hint**: yes

### Phase 105: 数据质量
**Goal**: 实现实例多维度评分算法，展示评分趋势和采集能力详情
**Depends on**: Phase 104
**Requirements**: QUAL-01, QUAL-02, QUAL-03, QUAL-04
**Success Criteria** (what must be TRUE):
  1. Instance health reports show computed multi-dimension scores (availability 0.35, performance 0.35, capacity 0.20, security 0.10, weights configurable) instead of hardcoded 100
  2. Users can view score trend chart based on health_check_history data over a configurable time range
  3. Instance detail page shows per-metric collection capability status (green/grey badges) based on collection_capabilities JSON
  4. Health status display shows per-check-item detail breakdown with individual pass/fail status, not just total score
**Plans**: 2 plans
Plans:
**Wave 1**
- [x] 105-01-PLAN.md -- Backend: scoring algorithm, weight config service, collection capability tracker, API routes (QUAL-01, QUAL-03)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 105-02-PLAN.md -- Frontend: health score tab, trend chart, per-check details, collection badges, weight settings (QUAL-02, QUAL-04, QUAL-01)
**UI hint**: yes

### Phase 106: 指标采集可配置化
**Goal**: 打通 metric_definitions 定义层与 database-service 采集层的断裂，支持用户自定义指标的完整生命周期（定义 → 采集 → 存储 → 告警）
**Depends on**: Phase 105
**Requirements**: MET-01, MET-02, MET-03
**Success Criteria** (what must be TRUE):
  1. 用户在 metric-registry 页面新建指标后，该指标能被采集器自动发现并按配置的采集 SQL 执行
  2. metrics_history 支持存储动态指标数据（JSON 列或 EAV 模式），不依赖固定列
  3. 告警规则创建时验证 metric_name 必须存在于 metric_definitions 且 is_collected=true，引用无效指标时给出明确提示
**Background**: 2026-05-21 架构分析发现 metric_definitions（UI 可编辑）和实际采集代码（硬编码 SQL + 固定列）之间存在断裂。详见 `04-过程文档/20260521-指标采集体系架构分析.md`
**Plans**: 4 plans
Plans:
**Wave 1**
- [x] 106-01-PLAN.md -- Backend infrastructure: Registry<T>, SQL migration, SQL validator, MetricDatabaseService CRUD

**Wave 2** *(parallel after Wave 1)*
- [x] 106-02-PLAN.md -- Provider extraction + UnifiedCollector + MonitorCollector wiring
- [x] 106-03-PLAN.md -- Alert integration: JSON merge, rule validation, metric:write permission, delete ref check

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 106-04-PLAN.md -- AI SQL generation endpoint + frontend form update (new fields + AI button)
**UI hint**: yes

### Phase 107: 实例详情页指标动态化
**Goal**: 实例详情页根据 db_type 动态读取 metric_definitions 中 is_collected=true 的指标，自动渲染概览卡片和趋势图，替代当前8个硬编码指标
**Depends on**: Phase 106
**Requirements**: DYNMET-01
**Success Criteria** (what must be TRUE):
  1. 实例详情页的概览卡片从硬编码改为动态——读取该实例 db_type 对应的所有 is_collected=true 指标定义，自动生成卡片
  2. 趋势图区域动态渲染所有已采集指标的历史图表，不再局限于 cpu/memory/qps/connections
  3. 自定义指标（CustomSQLProvider 采集、存入 metrics_data JSON 列）也能在详情页展示
  4. 两者都支持"无数据"状态展示（新建指标尚未有历史数据时）
**Plans**: 2 plans
Plans:
**Wave 1**
- [x] 107-01-PLAN.md -- 后端 History 接口增强：支持 metrics 参数 + JSON_EXTRACT 动态指标
**Wave 2** *(blocked on Wave 1 completion)*
- [x] 107-02-PLAN.md -- 前端 instance-detail 重构：动态指标卡片 + category 分组渲染
**UI hint**: yes

### Phase 108: Agent 抽象层
**Goal**: 定义 Slide 平台与 Agent 引擎之间的接口契约（IAgentEngine），实现 OpenClaw 适配器。平台代码只依赖接口，不感知底层 Agent 实现。
**Depends on**: Phase 107
**Requirements**: MIG-01
**Success Criteria** (what must be TRUE):
  1. `IAgentEngine` 接口覆盖 Slide 实际使用的能力：.chat() 流式对话、.invoke() 任务派发、工具注册/调用
  2. OpenClaw 适配器实现 IAgentEngine，现有功能通过适配器调用无回归
  3. 平台代码（server.ts、Chat、AI 分析等）不再直接 import OpenClaw，改为通过接口调用
  4. 接口设计不猜测未来需求，只基于 Slide 当前实际调用模式
**Background**: Slide 当前深度耦合 OpenClaw：工具注册走 Gateway、Chat 走 WebSocket、AI 分析走 agent turn。换 Agent 引擎需改遍所有模块。引入抽象层后，切换 Agent 只需实现新适配器。
**Plans**: 3 plans
Plans:
**Wave 1** *(foundation)*
- [x] 108-01-PLAN.md -- IAgentEngine 接口 + DirectAdapter + AnthropicProvider + 死代码清理 + 共享层提取

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 108-02-PLAN.md -- OpenClawAdapter 实现 + gateway/ 文件迁移到 adapter/openclaw/

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 108-03-PLAN.md -- 平台代码切换到 IAgentEngine + feature flags + 双跑验证
**UI hint**: no

### Phase 109: Agent 引擎补全 & DirectAdapter 接管
**Goal**: 补全 @slide/agent-core（nanobot Agent 机制的 TypeScript 移植），超时分层、Session、Context、Memory、Checkpoint、Subagent。移除 OpenClaw Gateway 依赖，前端适配新 Agent 层。
**Depends on**: Phase 108
**Requirements**: MIG-02, MIG-03, MIG-04, MIG-05
**Success Criteria** (what must be TRUE):
  1. agent-core 包含完整的超时分层、Session 管理、Context 构建、Memory、Checkpoint 恢复
  2. DirectAdapter 独立运行（不依赖 OpenClaw Gateway），Chat + AI Analysis 正常工作
  3. Subagent 工具（spawn_subagent / access_subagent）已注册并可用
  4. Skills（.agents/skills/ 中 33 个）通过 ContextBuilder 注入 system prompt
  5. 前端 Chat 通过 DirectAdapter WebSocket 直接通信，不再经过 Gateway 协议
  6. gateway/ 和 openclaw/ 适配器目录可安全删除
**Plans**: 4 plans
Plans:
**Wave 1** *(parallel)*
- [x] 109-01-PLAN.md -- Agent-core Session 管理 + 超时分层 (MIG-02)

**Wave 2** *(blocked on Wave 1)*
- [x] 109-02-PLAN.md -- SkillsLoader + MemoryStore + ContextBuilder (MIG-02)

**Wave 3** *(blocked on Wave 2)*
- [x] 109-03-PLAN.md -- Checkpoint 恢复 + Subagent 集成 + DirectAdapter 接入 (MIG-02, MIG-03)

**Wave 4** *(blocked on Wave 3)*
- [x] 109-04-PLAN.md -- Gateway 协议移除 + 前端适配 (MIG-04, MIG-05)
**UI hint**: yes

### Phase 110: DirectAdapter 默认切换 & 端到端验证

**Goal:** 将 DirectGatewayClient 设为前端默认 WebSocket 连接，移除 `__SLIDE_USE_DIRECT_ADAPTER` feature flag，端到端验证 Chat + AI Analysis 全链路
**Requirements**: TBD
**Depends on:** Phase 109
**Plans:** 5/5 plans complete

Plans:
- [x] TBD (run /gsd-plan-phase 110 to break down) (completed 2026-05-26)

### Phase 111: Gateway 简化

**Goal:** 清理 DirectAdapter 模式下已失效的 Gateway RPC controller、view 和 slash command。纯删除和简化，不加新功能。
**Depends on:** Phase 110
**Requirements:** MIG-06
**Plans:** 4/4 plans complete

Plans:
**Wave 1** *(parallel)*
- [x] 111-01-PLAN.md -- 删除 9 个完全失效的 controller + 清理 app-settings.ts/app.ts/direct-gateway.ts
- [x] 111-02-PLAN.md -- 精简 3 个部分失效的 controller（sessions/agents/chat）+ sessions view 只读化
- [x] 111-03-PLAN.md -- 删除 8 个已断掉的 slash command（model/think/fast/verbose/compact/kill/redirect/stop）

**Wave 2** *(blocked on 111-01)*
- [x] 111-04-PLAN.md -- 修改 view 占位页 + 清理 app-render.ts/app-chat.ts 引用

### Phase 112: 前端清理 & 定时任务可配置化

**Goal:** 清理 Gateway 移除后的前端 dead code、占位页和弃用引用，统一 WebSocket 连接路径；将硬编码 CronJob 迁移到可配置系统，支持启停和间隔调整
**Depends on:** Phase 111
**Requirements:** TBD
**Success Criteria** (what must be TRUE):
  1. 前端不再引用任何已删除的 Gateway view/controller
  2. WebSocket 连接路径全部使用 DirectAdapter，无旧 Gateway 路径残留
  3. 定时任务从 server.ts 硬编码迁移到数据库配置模型
  4. 每个定时任务支持 enabled / interval / timezone 配置
  5. 前端提供定时任务管理页面（列表、启停、查看日志）
**Plans**: 3 plans
Plans:
**Wave 1** *(parallel)*
- [x] 112-01-PLAN.md -- 前端文件重组：openclaw/ → app/ 重命名 + 删除死代码/占位视图/协议文件 + 更新引用/导航/i18n
- [x] 112-02-PLAN.md -- CronJob 后端基础设施：SQL 迁移（3表+13条种子+权限）+ CronManager + CRUD API 路由

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 112-03-PLAN.md -- CronJob 管理前端 UI：<cron-jobs-settings> LitElement + Settings tab 集成 + i18n

### Phase 113: AI Agent Cron — 自然语言驱动定时任务

**Goal:** 将 Phase 112 的 DB 驱动调度器升级为 AI Agent 驱动的自然语言定时任务系统。用户用自然语言描述任务，Agent 自主调用 tools/skills 执行，替代现有的 13 个硬编码 TypeScript handler。
**Depends on:** Phase 112
**Requirements:** D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09
**Success Criteria** (what must be TRUE):
  1. cron_jobs 表使用 task_description（NL 文本）替代 handler，13 条种子数据包含 NL 任务描述
  2. CronExecutor 使用 @slide/agent-core AgentRunner.run() 执行 NL 任务（非 Gateway），每次执行创建唯一 session
  3. cron_job_logs 表存储完整 Agent 执行迹（tools_used, tool_events, usage, stop_reason, duration_ms）
  4. 13 个硬编码 handler 文件（cron-job-handlers.ts）已删除，不再被引用
  5. 前端定时任务管理页面支持创建/编辑 NL 任务、删除任务，handler 字段已替换为 task_description
  6. 5 分钟超时通过 llmTimeoutS 强制，超时时保存 partial_trace
  7. 所有 CRUD API 路由受 cron:view/cron:manage 权限保护
**Plans**: 4 plans
Plans:
**Wave 1** *(parallel)*
- [x] 113-01-PLAN.md -- Schema 迁移 + 类型定义 + 数据库服务层扩展
- [x] 113-02-PLAN.md -- CronExecutor + slide_complete_cron 工具 + 单元测试

**Wave 2** *(blocked on Wave 1)*
- [x] 113-03-PLAN.md -- CronManager 重写 + API 路由 + 删除旧 handler + 集成 eval 测试

**Wave 3** *(blocked on Wave 2)*
- [x] 113-04-PLAN.md -- 前端任务 builder 对话框 + 删除功能 + handler→task_description 接口迁移

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 84. RBAC Foundation | v1.1 | 4/4 | Complete | 2026-05-09 |
| 85. RBAC Frontend | v1.1 | 2/2 | Complete | 2026-05-10 |
| 86. SQL Console Upgrade | v1.1 | 5/5 | Complete | 2026-05-10 |
| 87. Approval Enhancement | v1.1 | 4/4 | Complete | 2026-05-11 |
| 88. Dashboard Upgrade | v1.1 | 2/2 | Complete | 2026-05-11 |
| 89. Gap Closure | v1.1 | 5/5 | Complete | 2026-05-13 |
| 90. OpenClaw Upstream Merge | v1.2 | 0/2 | Deferred | - |
| 91. UI Standardization | v1.2 | 2/2 | Complete | 2026-05-14 |
| 92. AI Analysis Visibility | v1.2 | 5/5 | Complete | 2026-05-14 |
| 93. AI Agent Ops Assistant | v1.2 | 6/6 | Complete | 2026-05-15 |
| 94. Project Documentation | v1.2 | 3/3 | Complete | 2026-05-17 |
| 95. Dameng Database Support | v1.2 | 2/2 | Complete | 2026-05-18 |
| 96. Oracle Database Support | v1.2 | 4/4 | Complete | 2026-05-19 |
| 97. SQL History Persistence | v1.2 | 1/1 | Complete | 2026-05-20 |
| 98. Chat Agent Selector UI | v1.2 | 1/1 | Complete | 2026-05-16 |
| 99. db-connection-auto-recovery | v1.2 | 2/2 | Complete | 2026-05-19 |
| 100. 安全紧急修复 | v1.3 | 2/2 | Complete    | 2026-05-20 |
| 101. 认证权限 | v1.3 | 4/4 | Complete    | 2026-05-20 |
| 102. UI 统一 | v1.3 | 3/3 | Complete    | 2026-05-21 |
| 103. 报表重构 | v1.3 | 3/3 | Complete   | 2026-05-21 |
| 104. 告警系统增强 | v1.3 | 3/3 | Complete    | 2026-05-21 |
| 105. 数据质量 | v1.3 | 2/2 | Complete    | 2026-05-21 |
| 106. 指标采集可配置化 | v1.3 | 4/4 | Complete | 2026-05-22 |
| 107. 实例详情页指标动态化 | v1.3 | 2/2 | Complete    | 2026-05-27 |
| 108. Agent 抽象层 | v1.4 | 3/3 | Complete    | 2026-05-25 |
| 109. Agent 引擎补全 | v1.4 | 4/4 | Complete    | 2026-05-26 |
| 110. 切换 & 验证 | v1.4 | 5/5 | Complete    | 2026-05-26 |
| 111. Gateway 简化 | v1.4 | 4/4 | Complete    | 2026-05-26 |
| 112. 前端清理 & 定时任务 | v1.4 | 3/3 | Complete    | 2026-05-27 |
| 113. AI Agent Cron | v1.4 | 4/4 | Complete    | 2026-05-27 |
| 114. Verification 清账 | v1.4 | 4/4 | Complete    | 2026-05-27 |
| 115. 去 OpenClaw 迁移后清理 | v1.4 | 5/5 | Complete    | 2026-06-02 |
| 116. 去 OpenClaw 运行时引用 | v1.4 | 4/4 | Complete    | 2026-06-02 |

### Phase 114: Verification 清账

**Goal:** 执行 Phase 100/102/112 遗留的 12 项 human_needed 验证，关闭所有 HUMAN-UAT pending 项，清空 verification debt
**Requirements:** VER-01
**Depends on:** Phase 113
**UI hint:** yes
**Plans:** 4/4 plans complete

Plans:
- [x] 114-01-PLAN.md -- Verify 12 human-needed items from Phases 100/102/112, update verification files

### Phase 115: 去 OpenClaw 迁移后清理：修复工具 TODO、清理前端残留引用、更新文档、添加 CI

**Goal:** 清理 v1.4 OpenClaw 迁移后的遗留事项 — 删除已替换的 Agent LLM 配置工具、修复 TODO 占位、清理前端残留引用和 OpenClaw 命名、添加 GitHub Actions CI pipeline
**Requirements**: D-01 through D-16 (from CONTEXT.md)
**Depends on:** Phase 114
**Plans:** 5/5 plans complete

Plans:
**Wave 1** *(parallel)*
- [x] 115-01-PLAN.md -- Delete Agent LLM config tools (configure_llm.ts, llm-config/) + update CLAUDE.md
- [x] 115-02-PLAN.md -- Delete dead routing files, fix config/types.ts import for 20+ auto-reply files, rename Vite alias

**Wave 2** *(blocked on Wave 1)*
- [x] 115-03-PLAN.md -- Fix 4 backend TODO stubs: RBAC scope (2 tools), capacity data (report-service), status check (check_status.ts)

**Wave 3** *(blocked on Wave 2)*
- [x] 115-04-PLAN.md -- Naming/text cleanup: remove all OpenClaw references from comments/i18n/server.ts/package.json/__openclaw markers/protocol docs

**Wave 4** *(blocked on Wave 3)*
- [x] 115-05-PLAN.md -- Create GitHub Actions CI workflow, install oxlint, add typecheck scripts, fix 88 failing tests

### Phase 116: 去 OpenClaw 运行时引用：CLI 名、环境变量、数据目录替换

**Goal:** 将前端 runtime 代码中所有功能性 OpenClaw 运行时引用（CLI 名、环境变量、Symbol 键、数据目录、用户可见文本、工具分组、HTTP User-Agent）替换为 Slide 自有标识。Phase 115 清理了注释/文本引用，Phase 116 处理剩下的功能性引用。
**Requirements**: D-01 through D-17 (from CONTEXT.md)
**Depends on:** Phase 115
**Plans:** 4/4 plans complete

Plans:
**Wave 1** *(foundation)*
- [x] 116-01-PLAN.md -- branding.ts 集中配置 + 死代码删除 + SQL/CSS 注释 + 外部 URL + vitest 别名

**Wave 2** *(parallel, independent)*
- [x] 116-02-PLAN.md -- 环境变量 + UI base path + Symbol 键 + 数据目录 + 插件格式 + HTTP User-Agent
- [x] 116-03-PLAN.md -- 用户可见文本 + CLI 显示 + 工具分组命名

**Wave 3** *(blocked on Wave 2)*
- [x] 116-04-PLAN.md -- 测试断言更新

### Phase 117: OpenClaw收尾

**Goal:** 1) OpenClawConfig 类型重命名为 SlideConfig（~97 文件）；2) docs/ 目录更新（推迟）；3) branding 配置加入系统 Settings 页面（运行时可配置）
**Requirements**: D-01 through D-10 (from CONTEXT.md)
**Depends on:** Phase 116
**Plans:** 3/3 plans complete

Plans:
**Wave 1** *(parallel)*
- [x] 117-01-PLAN.md -- OpenClawConfig → SlideConfig 类型重命名 + 死字段删除 + 8 个错误 import 修复
- [x] 117-02-PLAN.md -- Backend branding 配置服务 + GET/PUT /api/branding/config 路由

**Wave 2** *(blocked on Wave 1)*
- [x] 117-03-PLAN.md -- Frontend branding.ts getter/cache 重构 + branding-settings Lit 组件 + Settings shell 集成

### Phase 118: Agent DB 连接 + 告警机制完善

**Goal:** 1) Agent 可通过工具获取数据库实例连接信息进行分析；2) 彻底修复告警采集/触发机制（误报、漏报、阈值绕过、API 字段缺失）
**Requirements**: R1-R5 (from CONTEXT.md)
**Depends on:** Phase 117
**Plans:** 2/2 plans complete

Plans:
**Wave 1** *(parallel)*
- [x] 118-01-PLAN.md — 告警系统 Bug 修复（可用性误报、QPS 阈值绕过、API metric_name null）
- [x] 118-02-PLAN.md — Agent DB 连接工具（list_database_instances, get_instance_connection）

### Phase 119: 代码清理 — P0 Bug 修复 + ~9,600 行死代码移除 + 前后端路由修复

**Goal:** 根据 2026-06-10 代码审查报告，修复关键 Bug、移除死代码、统一设计模式、修复前后端路由不匹配
**Requirements**: P0-BUG-01, P1-ROUTE-01, P1-SEC-01
**Depends on:** Phase 118
**Plans:** 1/1 plan complete
**Completed:** 2026-06-10

Plans:
- [x] 119-01-PLAN.md — P0 Bug 修复（backfill 无限循环、db_version 列缺失、API_PORT 兼容）+ P1 修复（路由匹配、ENCRYPTION_KEY 安全、this 绑定、streamIdleTimeoutS、skills 路径）+ 死代码清理（-9,247 行）+ UAT（8/9 passed, sessions.patch 发现并修复）
**UI hint**: no

### Phase 120: 全面优化系统UI

**Goal:** 对 Slide 全系统 UI 进行 6 维度打磨：视觉一致性、响应式布局、组件标准化、主题系统完善、交互动效、可访问性基线。消除 CSS 碎片化，统一设计语言，提升专业感与操作效率。
**Depends on:** Phase 119
**Requirements**: UI-OPT-01
**Success Criteria** (what must be TRUE):
  1. 全站 20+ 页面 visual audit 通过，无不一致字体/颜色/间距/圆角
  2. 共享组件库完整（button, card, table, badge, modal, form, stat-card, tab, toast），所有视图统一引用
  3. 响应式布局覆盖 desktop/tablet/mobile 三端断点，无溢出/遮挡
  4. 全站统一浅色主题，无深色模式残留/半吊子样式，色彩体系一致
  5. 加载态、空态、错误态有统一设计模式，全站一致
  6. 核心交互有平滑 transition/animation（页面切换、面板展开、hover 反馈）
  7. 可访问性基线达标：键盘导航、focus 可见、语义化 heading 层级、表单 label 关联
  8. CSS 文件从当前碎片化状态收敛到 < 10 个结构化文件（design-tokens, layout, components, themes, utilities）
**Plans:** 8/8 plans complete

Plans:
**Wave 1 (CSS Foundation)**
- [x] 120-01-PLAN.md — CSS Architecture Reset: delete old CSS, create tokens.css (blue #409eff), fix double load, z-index layers, <7 files

**Wave 2 (Build Shared Components, parallel)**
- [x] 120-02-PLAN.md — Component Suite A: app-toast-container, app-dialog (4 sizes), app-form-field
- [x] 120-03-PLAN.md — Component Suite B: app-card, app-data-table, app-empty-state, app-badge


**Wave 3 (God Component Splits, parallel)**
- [x] 120-04-PLAN.md — Split alerts.ts into 4 subcomponents (alert-list, alert-detail-modal, alert-rule-editor, alert-analysis-viewer)
- [x] 120-05-PLAN.md — Split instance-detail.ts into 4 subcomponents (overview-tab, metrics-tab, diagnosis-modal, trend-chart)

**Wave 4 (Chat Split + Badge Rename)**
- [x] 120-06-PLAN.md — Split chat.ts into 3 subcomponents + rename status-badge to app-badge across all views

**Wave 5 (Component Adoption)**
- [x] 120-07-PLAN.md — Adopt shared components in 12 remaining views (replace hand-rolled dialogs/forms/cards/tables/toast/badges)

**Wave 6 (Final Polish)**
- [x] 120-08-PLAN.md — Interaction states + skeleton screens + px->token migration + console->logger replacement
**UI hint**: yes

### Phase 120 后续打磨 (2026-06-20 ~ 2026-06-24)

Phase 120 的 8 个 plans 于 2026-06-20 完成并标记 shipped。之后进行了多轮 UI 审计和修复，解决了拆分和组件化过程中遗留的问题：

**添加数据库实例弹窗** (3 commits):
- 必填项星号间距 2→4px + vertical-align
- Hint 文字颜色 #999 + 间距加大，区分于 placeholder
- 表单栅格：全宽字段用 grid-column: 1/-1 统一包裹
- 底部按钮：测试连接移入 footer，space-between 布局
- Autofill 蓝色背景覆盖（:-webkit-autofill）
- Textarea resize: none（防止破坏弹窗布局）
- form-select box-sizing: border-box（修复列宽不对齐）

**测试连接弹窗** (1 commit):
- 成功提示去重（隐藏冗余状态行）
- 只读字段背景色区分（var(--bg-app)）
- Emoji 图标替换为 SVG（check-circle/x-circle/loader）
- 单按钮居中，双按钮 space-between

**Dashboard** (2 commits):
- KPI 卡片间距收紧（gap 6→4px, padding 16→14px）
- 活跃告警卡片去掉橙色左边框（统一外观）
- 饼图 legend 竖→横放底部，radius 70→75%
- 筛选控件间距加大
- Y 轴文字对比度 #999→#777
- "当前总量" 改为 accent 色 badge
- 告警时间列固定宽度 + 右对齐
- 告警行高压缩（padding 10→8px）
- 告警区域统一为 chart-card 容器

**实例详情页** (8 commits):
- 诊断历史空态完全隐藏（Progressive Disclosure）
- 概览页 Bento Grid 布局（Hero KPIs → 实例信息 → mini-charts）
- 实时监控 4→3 列，按 category 分组间距加大
- Header 按钮 emoji→SVG icons（chevron-left/refresh/activity/loader）
- Mini-charts 加标题 + compact 模式（metric-chart 新增 compact 属性）
- 恢复历史版本丢失的设计细节：
  - app-card 微阴影（0 1px 3px rgba(0,0,0,0.04)）
  - overview-item hover 效果
  - metric-card 分类色顶边（performance/resource/storage/availability/security）
  - 趋势页从 inline style div 改回 app-card
- **关键修复**：app-card 恢复结构化标题栏（bg-elevated 背景 + 独立 padding）
- **关键修复**：子组件 Light DOM + static styles 样式静默失效 → 改为 inline `<style>` 注入
- **关键修复**：趋势页 `percentage=${expr}` 属性绑定 boolean 陷阱 → `.percentage=${expr}` property binding
- **关键修复**：metric-chart 在隐藏容器中初始化 0×0 canvas → ResizeObserver 等待可见
- X 轴标签重叠修复（interval: auto + rotate 30°）

**app-card 组件** (3 commits):
- Light DOM → Shadow DOM（slot 投影需要 shadow root）
- 简化 slot 可见性逻辑（默认显示，slotchange 切换 .empty class）
- 恢复结构化标题栏（bg-elevated + overflow:hidden）

**metric-chart 组件** (2 commits):
- 新增 compact 模式（更小的 header padding + 12px 标题）
- ResizeObserver 等待容器可见再初始化 ECharts

**ROADMAP 更新**:
- v1.5 里程碑标记为 shipped (2026-06-20)

**全局样式统一** (3 commits):
- Primary 按钮全局统一：class="btn primary" → class="btn-primary"（11 文件 ~40 处替换）
- 删除 sql-audit-tab/schema-management 中的自定义 .btn.primary 样式块
- 12 视图 .page padding 统一为 0（消除页面到导航栏间距不一致）
- metric-registry/metric-templates toolbar 添加 border-radius: var(--radius-md)
- 移除 content-header 中的 page-title/page-sub（面包屑既是导航也是标题）

**CLAUDE.md** (1 commit):
- 新增共享组件规则清单（10 类元素的 do/don't 对照表）
- "第一次出现用自定义，第二次出现必须提取为共享组件"规则
- 样式变量规范、Lit 组件规范、代码审查 checklist
- Boolean 属性绑定必须用 . 前缀（attribute binding 陷阱）

**UI hint**: yes


| 117. OpenClaw收尾 | v1.4 | 3/3 | Complete    | 2026-06-02 |
| 118. Agent DB 连接 + 告警完善 | v1.4 | 2/2 | Complete    | 2026-06-08 |
| 119. 代码清理 (P0 Bug + 死代码) | v1.5 | 1/1 | Complete    | 2026-06-10 |
| 120. 全面优化系统 UI | v1.5 | 8/8 | Complete    | 2026-06-24 |
| 121. 前端元素样式统一 | v1.5 | 0/4 | In Progress | 2026-06-24 |

### Phase 121: 前端元素样式统一

**Goal:** 将 Phase 120 遗留的手写样式（弹窗/卡片/徽章/表单）统一替换为共享组件，并建立 CLAUDE.md 规则确保后续开发遵循统一标准
**Depends on:** Phase 120
**Requirements**: UI-OPT-01
**Plans:** 4 plans

Plans:
- [x] 121-01-PLAN.md — 弹窗/模态框统一：rbac-page 手写 .modal-overlay → <app-dialog> ✅
- [ ] 121-02-PLAN.md — 徽章/标签统一：metric-templates/event-management/schema-management/sql-audit-tab → <app-badge>
- [ ] 121-03-PLAN.md — 卡片容器统一：appearance-settings/ai-analysis-result/rbac-page/sql-audit-tab/approval-dashboard → <app-card>
- [ ] 121-04-PLAN.md — 表单输入统一 + button 残留清理
**UI hint**: yes
