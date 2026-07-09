---
phase: 129-unified-observability
created: 2026-07-09
status: decisions_captured
---

## Domain

将 Phase 125-128 交付的服务器观测后端能力（指标采集、告警评估、报告生成、AI 工具）统一整合到 Slide 现有的前端平台基础设施中。Slide 的核心设计理念是**统一观测平台**：指标定义、告警规则、告警中心、报告中心、模板系统对所有对象类型（数据库实例、服务器、未来扩展类型）一视同仁，共享同一套管道。

## Canonical Refs

- `.planning/ROADMAP.md` — Phase 129 goal and success criteria
- `.planning/REQUIREMENTS.md` — UNI-01 through UNI-06
- `apps/db-ops-api/sql/migrations/021_add_server_alert_fields.sql` — target_type/server_id on alert tables
- `apps/db-ops-api/src/server-report-service.ts` — existing server report generation (not persisted)
- `apps/db-ops-api/src/server-alert-evaluator.ts` — server alert evaluation logic
- `apps/db-ops-api/src/alert-database-service.ts` — alert CRUD with server_id support
- `apps/db-ops-api/src/metric-registry.ts` — metric definitions (instance-only currently)
- `apps/db-ops-api/src/template-database-service.ts` — template system (instance FK only)
- `frontend/src/app/ui/views/alerts.ts` — alert center (6 tabs)
- `frontend/src/app/ui/views/reports.ts` — report center
- `frontend/src/app/ui/components/alert-rule-editor.ts` — rule editor form
- `frontend/src/app/ui/views/server-detail.ts` — server detail page

## Decisions (from discussion + research)

### Architecture

1. **复用现有管道，不新建系统** — metric_definitions、alert_rules、alerts、reports 表通过加列（target_type/server_id）而非新建表来支持服务器。前端告警中心/报告中心/规则编辑器通过加选择器来支持 target_type 切换。

2. **target_type 分流模式** — 在 alarm 管道关键节点使用 `target_type ENUM('instance','server')` 做分流：
   - metric_definitions: 加 `target_type` 列
   - alert_rules: 已有 target_type（migration 021）✓
   - alert_rule_templates: 新建表，包含 target_type
   - reports: 加 `server_id` 列
   - report_configs: 加 `server_id` 列

3. **指标定义复用** — cpu_usage/memory_usage/disk_usage 等指标名称在 server 和 instance 上下文中语义不同（OS 级 vs DB 级），但 metric_name 可共用，通过 target_type + db_types 区分。

### Frontend

4. **告警规则编辑器** — 加 target_type 下拉（实例/服务器），选择"服务器"时显示 server 下拉。server 模式下隐藏 db_types 和 instance_ids。

5. **告警中心** — 告警列表加 target_type 和 server_name 列。筛选栏加 target_type 和 server 下拉。6 个 tab（alerts/rules/escalation/maintenance/silence/baselines）中 rules 和 alerts tab 需要 target_type 感知。

6. **报告中心** — 加"服务器巡检"类型卡片。目标选择器扩展为"数据库实例 / 服务器"切换。历史列表显示 server_name。

7. **服务器详情页** — 加"一键巡检"按钮（触发 POST /api/servers/:id/collect 并跳转报告）和"查看告警"按钮（跳转告警中心并自动筛选该服务器）。

### Backend

8. **server-report 持久化** — server-report-service 生成的报告写入 reports 表（加 server_id）。支持历史查看、下载、定时调度。

9. **告警模板** — 新建 alert_rule_templates 表，支持 target_type=server 的预置模板（CPU 过高/内存过高/磁盘过高/负载过高/不可达）。

## Code Context (reusable assets)

- AlertRule interface (`alert-database-service.ts:31-53`) — includes target_type, server_id
- createAlert / findActiveServerAlert — already server-aware
- ServerReportService (`server-report-service.ts`) — generates HTML/MD, needs persistence
- ReportDatabaseService (`report-database-service.ts`) — CRUD for reports table
- Alert center (frontend alerts.ts) — 1849 lines, 6 tabs, extensible
- Report center (frontend reports.ts) — health/performance/slow_query/capacity types
- Alert rule editor component — form with metric_name, operator, threshold, db_types, instance_ids fields

## Plan Structure

Plan 01: Backend — metric_definitions target_type, server metrics registration, alert templates
Plan 02: Frontend — alert center, rule editor, report center, server detail actions
Plan 03: Report persistence — server reports → reports table, scheduling
