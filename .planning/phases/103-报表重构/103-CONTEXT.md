# Phase 103: 报表重构 - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning

## Phase Boundary

重构报表模板系统为 EJS 模板文件，新增定时报表配置能力，统一报表类型命名。

**Requirements:** RPT-01, RPT-02, RPT-03, RPT-04
**Depends on:** Phase 102 (共享 `<stat-card>` 组件)

## Implementation Decisions

### RPT-01: EJS 模板提取

- **D-01:** 模板目录 `apps/db-ops-api/src/templates/reports/`
- **D-02:** 架构：一个共享 `layout.ejs`（公共 HTML 结构 + 基础样式）+ 每个报表类型独立模板（`health.ejs`, `performance.ejs`, `slow-query.ejs`, `capacity.ejs`），各自只定义内容区域和差异化样式
- **D-03:** 统一 `ReportContext` TypeScript interface —— layout.ejs 消费公共字段（title, generatedAt, instanceName），各模板扩展自己的 data 字段
- **D-04:** 新增 npm 依赖 `ejs@^5.0.2`

### RPT-02: 定时报表配置

- **D-05:** 新增 `report_configs` 表，核心字段：`id`, `name`, `cron`（cron 表达式）, `type`（报表类型）, `instance_id`, `format`（输出格式）, `enabled`（启用开关）, `created_at`, `updated_at`
- **D-06:** 调度机制：新增一个 CronJob（每 60 秒扫 `report_configs WHERE enabled=1`），匹配当前分钟应触发的 config，调用 `reportService.generateReport()`。生成结果自动存入现有 `reports` 表
- **D-07:** API：新增 `/api/reports/configs` CRUD 路由（GET/POST/PUT/DELETE），权限复用现有 `report:create` / `report:view`
- **D-08:** 前端管理 UI：在现有 `reports.ts` 页面增加"定时报表配置"卡片区域，列表展示所有 config（实例名、报表类型、cron 表达式、下次执行时间、启用状态），支持新增/编辑/删除/启停

### RPT-03: 报表类型命名统一

- **D-09:** Canonical 名称统一为 `slow_query`（下划线）——与路由验证 validTypes、report-service.ts 实际写入、前端生成请求一致
- **D-10:** 执行 migration SQL 将 `reports` 表中 `slow-query` → `slow_query`，同步修正 `ReportType` 类型定义和前端标签映射
- **D-11:** 全面审查所有报表类型引用（health/performance/capacity），确保 URL query param、导出文件名等处无隐藏不一致

### RPT-04: stat-card 覆盖

- **D-12:** RPT-04 已满足 —— Phase 102 D-15 已将 reports.ts 迁移到 `<stat-card>`，当前 reports.ts 无 ov-card 引用
- **D-13:** 此 requirement 标记为 Phase 102 交叉验证通过，Phase 103 不再重复工作

### Claude's Discretion

- `report_configs` 表的具体 schema 设计和索引
- EJS layout.ejs 的 HTML 结构和 CSS 设计
- CronJob 扫表的去重逻辑（防止同分钟重复触发）
- 命名审查中发现的边缘不一致——自行判断修正

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 报表核心服务
- `apps/db-ops-api/src/report-service.ts` — 638 行，4 个私有方法内联完整 HTML 模板，是 RPT-01 提取目标
- `apps/db-ops-api/src/report-database-service.ts` — ReportType 类型定义（含 `slow-query` 命名问题），report CRUD
- `apps/db-ops-api/src/report-exporter.ts` — PDF/MD/HTML/JSON 导出服务

### 路由与 API
- `apps/db-ops-api/server.ts` §1410-1530 — 现有 `/api/reports/*` 路由，validTypes 使用 `slow_query`

### 前端
- `frontend/src/openclaw/ui/views/reports.ts` — 报表页面，已使用 `<stat-card>`，reportTypes 用 `slow_query`

### 现有调度模式（参考）
- `apps/db-ops-api/server.ts` §3240-3500 — 10 个现有 CronJob 实例（topsql/rca/capacity/baseline 等），参考启动模式和时区设置

### 需求与规划
- `.planning/REQUIREMENTS.md` — RPT-01~RPT-04 需求定义
- `.planning/ROADMAP.md` §266-278 — Phase 103 成功标准和依赖
- `.planning/phases/102-UI统一/102-CONTEXT.md` — stat-card 组件决策（D-09~D-15）

## Existing Code Insights

### Reusable Assets
- `reportService.generateReport(type, instanceId, options)` — 统一入口，新的 CronJob 直接调用此方法
- `reportDatabaseService` — report CRUD 已完备，定时报表生成结果直接入库
- `reportExporter` — PDF/MD/HTML/JSON 导出已就绪
- `CronJob` from `cron` npm 包 — 项目已有 10+ 实例，模式成熟
- `<stat-card>` Lit 组件 — Phase 102 已创建，reports.ts 已在用
- `authFetch` + `requirePermission('report:xxx')` — auth 模式一致

### Established Patterns
- 数据表 + CRUD API + 前端管理 UI + CronJob 消费 —— 与 `alert_rules` + `alert-engine` 完全一致
- Fastify route auth: `{ preHandler: [verifyToken, requirePermission('...')] }`
- CronJob 时区: `'Asia/Shanghai'`

### Integration Points
- `server.ts` §1410 — 新增 `/api/reports/configs` 路由，直接加到已有 reports API 区域
- `server.ts` §3461 附近 — 新增 `reportScheduleJob` CronJob，插入现有 CronJob 初始化块
- `frontend/src/openclaw/ui/views/reports.ts` — 新增定时配置 UI 区域，在现有生成卡片和历史列表之间
- `apps/db-ops-api/package.json` — 新增 `ejs` 依赖

## Specific Ideas

无特殊参考 —— 用户确认了实现方向。

## Deferred Ideas

None —— discussion stayed within phase scope.

---

*Phase: 103-报表重构*
*Context gathered: 2026-05-21*
