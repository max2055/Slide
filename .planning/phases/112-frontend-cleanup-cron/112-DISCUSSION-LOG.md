# Phase 112: 前端清理 & 定时任务可配置化 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-27
**Phase:** 112-frontend-cleanup-cron
**Areas discussed:** 前端文件重组策略, Placeholder 视图处理, 定时任务配置模型, 定时任务管理 UI

---

## 前端文件重组策略

| Option | Description | Selected |
|--------|-------------|----------|
| app/ | 简洁通用，不暴露框架品牌 | ✓ |
| core/ | 暗示核心 UI 模块 | |
| ui/ | 最通用但可能路径冲突 | |

**User's choice:** `openclaw/` → `app/`

---

| Option | Description | Selected |
|--------|-------------|----------|
| 全部删除 | protocol/ 下所有文件 + AGENTS.md/CLAUDE.md | ✓ |
| 保留 schema.ts + index.ts | 保留可能被引用的类型 | |
| 整个不动 | 以后再清理 | |

**User's choice:** 全部删除 protocol/

---

| Option | Description | Selected |
|--------|-------------|----------|
| 不分子目录 | views/ 扁平结构，保持现有模式 | ✓ |
| views/slide/ + views/system/ | Slide 和系统 view 分离 | |
| Slide view 提升到 src/views/ | 业务 view 提升层级 | |

**User's choice:** 不分子目录

---

| Option | Description | Selected |
|--------|-------------|----------|
| 删除 app-gateway.ts | DirectAdapter 已接管，旧 Gateway 死代码 | ✓ |
| 保留但标记 deprecated | 不确定引用情况 | |

**User's choice:** 删除 app-gateway.ts + 重构调用方（app-lifecycle.ts, app.ts）

---

| Option | Description | Selected |
|--------|-------------|----------|
| 保留 controllers/ | sessions/agents/chat 仍在使用 | ✓ |
| 移到 services/ | 改名反映 REST-only | |
| 内联到调用方 | 代码量小，直接合并 | |

**User's choice:** 保留 controllers/ 目录

---

| Option | Description | Selected |
|--------|-------------|----------|
| 只删对应 key | 精确删除失效翻译 key | ✓ |
| 删除所有非中文 | 只保留中文 | |
| 整个 i18n/ 不动 | 以后再清理 | |

**User's choice:** 精确删除失效翻译 key

---

| Option | Description | Selected |
|--------|-------------|----------|
| 只改目录名 | openclaw → app 路径替换 | |
| 同时清理 unused imports | 路径替换 + ESLint clean | ✓ |

**User's choice:** 同时清理 unused imports

---

| Option | Description | Selected |
|--------|-------------|----------|
| 保留 chat/ 不动 | 还有核心消息逻辑 | ✓ |
| 合并到 controllers/ | 统一管理 | |

**User's choice:** chat/ 目录保留不动

---

## Placeholder 视图处理

| Option | Description | Selected |
|--------|-------------|----------|
| 全部删除 | 删所有占位页 + 导航入口 | |
| 保留核心，删其余 | 保留 sessions/agents（有 REST API），其他删除 | ✓ |
| 全部保留 | 以后实现 REST API 替代时用 | |

**User's choice:** 保留 sessions 和 agents 视图，其余占位页全部删除

---

| Option | Description | Selected |
|--------|-------------|----------|
| 删除子面板 | agents 详情页简化，删占位 tab | |
| 保留所有占位 | agents 全部 tab 保留 | ✓ |
| 保留 overview 删其余 | 折中方案 | |

**User's choice:** 保留所有子面板占位

---

| Option | Description | Selected |
|--------|-------------|----------|
| 移除失效导航 + 重排 | 删失效入口 + 逻辑排序 | ✓ |
| 只移除，不重排 | 保持原顺序 | |

**User's choice:** 移除失效导航入口并重新排序

---

| Option | Description | Selected |
|--------|-------------|----------|
| 保留 | sessions/agents 子面板还需占位 | |
| 删除 | 所有占位都不需要了 | ✓ |

**User's choice:** 删除 unavailable-page.ts

---

## 定时任务配置模型

| Option | Description | Selected |
|--------|-------------|----------|
| 单表 cron_jobs | 简单直接 | |
| 双表 + logs | 日志独立方便审计 | |
| 三表 + params | 参数独立存储，更灵活 | ✓ |

**User's choice:** 三表设计：cron_jobs + cron_job_logs + cron_job_params

---

| Option | Description | Selected |
|--------|-------------|----------|
| Seed 迁移 + 双跑切换 | DB seed 初始数据，新旧并行 | |
| 硬编码保留 + 新增 DB 层 | feature flag 渐进切换 | |
| 直接替换 | 删硬编码，seed migration 一步到位 | ✓ |

**User's choice:** 直接替换

---

| Option | Description | Selected |
|--------|-------------|----------|
| 全部 13 个可配置 | 所有任务进 DB | ✓ |
| 业务类可配置，系统类保留 | 防止误关关键任务 | |
| 只配置 TopSQL 和 RCA | 最小化 | |

**User's choice:** 全部 13 个任务可配置

---

| Option | Description | Selected |
|--------|-------------|----------|
| 基础字段 | name, cron_expr, enabled, timezone | |
| 基础 + 元数据 | + description, handler, last/next run | |
| 全部字段 | + last_result, timeout_seconds, retry_count, timestamps | ✓ |

**User's choice:** 全字段设计

---

## 定时任务管理 UI

| Option | Description | Selected |
|--------|-------------|----------|
| Settings 下新 tab | 与 AI 设置并列 | ✓ |
| 独立顶级导航 | 一级页面 | |
| Dashboard 内嵌 | 卡片形式 | |

**User's choice:** Settings 下新 tab「定时任务」

---

| Option | Description | Selected |
|--------|-------------|----------|
| 只启停 | 简单 toggle | |
| 启停 + 编辑 | + cron 表达式编辑 | |
| 启停 + 编辑 + 触发 + 日志 | 全功能 | ✓ |

**User's choice:** 全功能（启停、编辑 cron、手动触发、运行日志）

---

| Option | Description | Selected |
|--------|-------------|----------|
| 卡片网格 | 状态指示灯，一目了然 | |
| 表格 | 传统表格，适合扩展 | ✓ |
| 卡片列表 | 横向卡片 | |

**User's choice:** 表格形式

---

| Option | Description | Selected |
|--------|-------------|----------|
| admin only | 只 admin 可见 | |
| admin + dba | 两个管理角色可管理 | ✓ |
| 无需权限 | 所有用户 | |

**User's choice:** admin + dba 可管理

---

| Option | Description | Selected |
|--------|-------------|----------|
| 每次运行一条记录 | 全量记录 | ✓ |
| 只记录失败 | 节省存储 | |
| 每次运行 + 保留 7 天 | 全量 + 自动清理 | |

**User's choice:** 每次运行一条 log 记录

---

| Option | Description | Selected |
|--------|-------------|----------|
| 确认弹窗 + 异步执行 | 确认 → 触发 → polling | ✓ |
| 直接触发 + Toast | 无确认，toast 提示 | |
| 确认 + 等待结果 | 同步等待 | |

**User's choice:** 确认弹窗 + 异步执行 + polling 状态

---

| Option | Description | Selected |
|--------|-------------|----------|
| 文本输入 + 预览 | cron 字符串 + 预览 + 模板 | ✓ |
| 纯文本输入 | 无辅助 | |
| 可视化编辑器 | 选择器替代原始输入 | |

**User's choice:** 文本输入 + 实时预览 + 常用模板下拉

---

## Claude's Discretion

- 表格列定义和 UI 样式细节
- cron_job_logs 保留策略（默认 30 天）
- 手动触发的超时处理
- CronManager 实现架构

## Deferred Ideas

- 为已删除的 Gateway 功能实现 REST API 替代 — 后续 milestone
- openclaw/ 子目录结构重构 — 本 phase 只做重命名
- 定时任务参数模板/预设 — 超出本 phase 范围
- 定时任务运行统计仪表板 — 超出本 phase 范围
