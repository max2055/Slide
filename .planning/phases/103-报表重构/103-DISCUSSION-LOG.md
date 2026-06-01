# Phase 103: 报表重构 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-21
**Phase:** 103-报表重构
**Areas discussed:** EJS 模板组织, 定时报表调度, 报表类型命名统一, stat-card 覆盖验证

---

## EJS 模板组织

| Option | Description | Selected |
|--------|-------------|----------|
| `apps/db-ops-api/src/templates/reports/` | 与源码同目录，tsx 可直接解析 | ✓ |
| `apps/db-ops-api/templates/` | 项目根级别模板目录 | |
| `apps/db-ops-api/src/views/reports/` | 仿 MVC views 目录 | |

**User's choice:** `apps/db-ops-api/src/templates/reports/`

---

| Option | Description | Selected |
|--------|-------------|----------|
| 共享 layout + 各自样式 | layout.ejs 含公共结构+基础样式，各模板只定义内容和差异化样式 | ✓ |
| 各自独立模板，样式内联 | 4 个独立 .ejs，各自带完整 `<style>` | |
| 共享 CSS 文件 + 各自模板 | 提取 report-common.css | |

**User's choice:** 共享 layout.ejs + 各自模板

---

| Option | Description | Selected |
|--------|-------------|----------|
| 统一 ReportContext 接口 | TypeScript interface，layout 消费公共字段，各模板扩展 data | ✓ |
| 各模板独立参数 | 每个模板函数接受各自参数 | |
| 纯数据驱动 | 传完整 JSON，模板内条件判断 | |

**User's choice:** 统一 ReportContext 接口

---

## 定时报表调度

**User asked:** "能使用 OpenClaw 原生的定时任务机制吗"

**Clarification:** OpenClaw Gateway 的「定时任务」菜单管理的是 AI Agent 定时执行 prompt，不适用于后端数据库报表生成。后端调度使用 server.ts 已有的 `cron` npm 包模式。

**User's choice:** 确认使用 cron 包模式

---

| Option | Description | Selected |
|--------|-------------|----------|
| 新增扫表 CronJob | 每 60 秒轮询 report_configs，匹配触发 | ✓ |
| 每个 config 动态注册 CronJob | 增删 config 时动态注册/注销 | |

**Confirmed approach:** API CRUD + 前端管理 UI + 单个 CronJob 扫表调度

---

## 报表类型命名统一

| Option | Description | Selected |
|--------|-------------|----------|
| `slow_query` | 与路由验证 validTypes、report-service 实际写入一致 | ✓ |
| `slow-query` | 与 TypeScript 类型定义一致 | |
| `slowquery` | 无分隔符 | |

**User's choice:** `slow_query`

---

| Option | Description | Selected |
|--------|-------------|----------|
| Migration SQL + 代码修正 | 迁移 reports 表数据 + 修类型定义和前端 | ✓ |
| 代码层兼容，不迁移数据 | 兼容两种写法但统一输出 | |

**User's choice:** Migration SQL + 代码修正

---

| Option | Description | Selected |
|--------|-------------|----------|
| 全面审查所有报表类型引用 | 审查 health/performance/capacity 是否也有隐藏不一致 | ✓ |
| 仅 slow_query | 只修复 slow-query/slow_query | |

**User's choice:** 全面审查

---

## stat-card 覆盖验证

**Finding:** reports.ts 在 Phase 102 已完成 `<stat-card>` 迁移，无 ov-card 残留。

| Option | Description | Selected |
|--------|-------------|----------|
| RPT-04 已满足 | Phase 102 D-15 已覆盖，标记完成 | ✓ |
| 保留做交叉验证 | 执行时再确认一遍 | |

**User's choice:** RPT-04 标记完成

---

## Deferred Ideas

None
