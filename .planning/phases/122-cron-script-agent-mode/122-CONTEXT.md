---
phase: 122-cron-script-agent-mode
created: 2026-06-26
status: discussed
---

# Phase 122: 定时任务 Script/Agent 双模式 — Context

## Objective

为定时任务系统增加 **script 模式**（通用 SQL 脚本执行引擎），与现有 **agent 模式**（AI Agent 自然语言驱动）并存。

## Domain Boundary

- **In scope**: script 模式后端实现、前端 UI、6 个预定义种子脚本、存量任务迁移
- **Out of scope**: Shell 脚本支持（未来扩展）、个人助手定时任务、脚本版本控制

## Locked Decisions

### D-01: Script 内容来源 — 混合方案
参考 Phase 112 旧 handler 逻辑，用当前服务重写。不直接恢复旧代码（表结构/接口已变）。

### D-02: Script 定位 — 通用 SQL 脚本引擎
不是 6 个预定义 handler，而是通用脚本执行能力：
- 当前：SQL 脚本 → 已纳管数据库实例
- 未来扩展：Shell 脚本 → 服务器/网络设备（本 phase 不做）

### D-03: 脚本存储 — 数据库表
新建 `cron_scripts` 表，字段：
- `id`, `name`, `description`, `script_type` ('sql' | 'shell'), `content` (TEXT), `target_db_type` (ENUM), `created_at`, `updated_at`

### D-04: 实例绑定 — 创建时下拉选择
用户创建 script 任务时，下拉选择目标实例（单选）。脚本执行时绑定到该实例。

### D-05: SQL 方言 — 按 db_type 分类
脚本按 `target_db_type` 分类（mysql/postgresql/oracle/dameng）。用户选择实例后，编辑器自动适配方言。

### D-06: 编辑器 — 类似 SQL 控制台
复用前端 SQL 控制台的编辑器组件（Monaco/CodeMirror），支持：
- SQL 语法高亮
- 测试执行（dry-run）
- 实例选择下拉框

### D-07: 版本控制 — 直接覆盖
脚本修改后直接覆盖，不保留历史版本。

### D-08: 读写权限 — 允许读写
Script 模式允许执行 DDL/DML（CREATE/ALTER/DROP/INSERT/UPDATE/DELETE），不限制只读。

### D-09: 预定义种子脚本 — 6 个
基于 Phase 112 旧 handler 逻辑重写：
1. `capacity_collection` — 容量数据采集
2. `schema_collection` — Schema 快照采集
3. `index_collection` — 索引信息采集
4. `baseline_cleanup` — 基线清理（30 天前）
5. `silence_cleanup` — 静默过期清理
6. `log_collection` — 数据库日志采集

### D-10: 存量任务迁移 — 自动标记
现有 6 个"应该用 script"的任务自动迁移为 script 模式：
- 容量数据采集、Schema 快照采集、索引信息采集、基线清理、静默过期清理、数据库日志采集

### D-11: 创建流程 UI — 两种入口
- **快速创建**：下拉选预定义脚本 → 自动填充 → 选实例 → 一键创建
- **自定义创建**：选 script 模式 → 写 SQL → 选实例 → 创建

### D-12: 结果格式 — 与 Agent 统一
Script 任务结果格式和 Agent 任务统一（`structured_result` JSON），前端复用现有日志查看器。

## Interfaces

### 新增 cron_scripts 表
```sql
CREATE TABLE `cron_scripts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT,
  `script_type` ENUM('sql', 'shell') NOT NULL DEFAULT 'sql',
  `content` TEXT NOT NULL,
  `target_db_type` ENUM('mysql', 'postgresql', 'oracle', 'dameng', 'mongodb', 'redis', 'elasticsearch') NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### cron_jobs 表变更
```sql
ALTER TABLE cron_jobs
  ADD COLUMN task_type ENUM('script', 'agent') NOT NULL DEFAULT 'agent' AFTER enabled,
  ADD COLUMN script_id INT UNSIGNED DEFAULT NULL AFTER task_type,
  ADD COLUMN target_instance_id INT UNSIGNED DEFAULT NULL AFTER script_id,
  ADD CONSTRAINT fk_cron_jobs_script FOREIGN KEY (script_id) REFERENCES cron_scripts(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_cron_jobs_instance FOREIGN KEY (target_instance_id) REFERENCES database_instances(id) ON DELETE SET NULL;
```

### 新增 API 端点
- `GET /api/cron/scripts` — 获取脚本列表
- `POST /api/cron/scripts` — 创建脚本
- `PUT /api/cron/scripts/:id` — 更新脚本
- `DELETE /api/cron/scripts/:id` — 删除脚本
- `POST /api/cron/scripts/:id/test` — 测试执行脚本

### 前端组件
- `<script-editor>` — SQL 编辑器（复用 SQL 控制台组件）
- `<instance-selector>` — 实例下拉选择器
- `<script-template-picker>` — 预定义脚本选择器（快速创建用）

## Success Criteria

1. `cron_scripts` 表创建，6 个种子脚本插入
2. `cron_jobs` 表新增 `task_type`、`script_id`、`target_instance_id` 字段
3. 后端 CronExecutor 分支：script 走 SQL 执行，agent 走 AgentRunner
4. 前端创建任务时可选 script/agent 模式
5. Script 模式显示 SQL 编辑器 + 实例选择器
6. 现有 6 个任务自动迁移为 script 模式
7. 手动触发 script 任务，结果正确写入日志
8. Build passes，无 TypeScript 错误

## Constraints

- 遵守 AGENTS.md 前端共享组件规则
- 不回滚用户已有改动
- Script 执行需要权限检查（`cron:manage`）
- SQL 执行使用参数化查询，防止注入

## Deferred Ideas

- Shell 脚本支持（服务器/网络设备管理）
- 脚本版本控制
- 个人助手定时任务（OpenClaw 集成）
- 脚本市场/共享（社区贡献脚本）

---

*Phase: 122-cron-script-agent-mode*
*Context created: 2026-06-26*
*Next step: /gsd:plan-phase 122 — 创建详细实施计划*
