# Phase 94: Project Documentation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-16
**Phase:** 94-project-documentation
**Areas discussed:** 文档位置与组织, 语言与受众, 架构文档深度, 用户手册组织方式, 已有文档迁移, 导航与目录结构, 文档维护策略, 截图与图片管理

---

## 文档位置与组织

| Option | Description | Selected |
|--------|-------------|----------|
| docs/slide/ 子目录 | Slide 专属文档集中管理，与上游文档共存但不混淆 | ✓ |
| docs/ 根目录 | 直接放 docs/ 根目录 | |
| 项目根目录 | 与 CLAUDE.md 同级 | |

**User's choice:** docs/slide/ 子目录

### OpenClaw 上游文档处理

| Option | Description | Selected |
|--------|-------------|----------|
| 确认删除 | 删除 docs/ 中所有 OpenClaw 上游文档 | ✓ |
| 保留 gateway 文档 | 删除大部分但保留 gateway/ | |

**User's choice:** 确认删除 — 用户认为这些文档对 Slide 开发无用

### 根目录 .md 文件处理

| Option | Description | Selected |
|--------|-------------|----------|
| 保留 Slide 核心文件 | CLAUDE.md/AGENTS.md/SOUL.md 留根目录，无用的移入 tmp/ | ✓ |
| 全部移入 docs/slide/ | 所有文件移入 docs/slide/ | |
| 除 CLAUDE/AGENTS 外全部移动 | | |

**User's choice:** 保留 Slide 核心文件（运行时配置），上游文件移入 tmp/

---

## 语言与受众

### 文档语言

| Option | Description | Selected |
|--------|-------------|----------|
| 全部中文 | 面向中国 DBA/运维团队，维护成本最低 | ✓ |
| 中英双语 | 便于国际用户，维护成本翻倍 | |
| 全部英文 | | |

**User's choice:** 全部中文

### 目标受众

| Option | Description | Selected |
|--------|-------------|----------|
| 按文档区分受众 | ARCHITECTURE→技术团队, OPERATIONS→运维, USER-GUIDE→DBA/用户 | ✓ |
| 专业 DBA/运维 | 统一面向有经验的专业人员 | |
| 混合受众 | 包含新人入门内容 | |

**User's choice:** 按文档区分受众

---

## 架构文档深度

### 文档深度

| Option | Description | Selected |
|--------|-------------|----------|
| 高层概览 | 系统架构图 + 模块职责概要 + 核心数据流 | ✓ |
| 详细模块说明 | 深入每个模块 API/类/表结构 | |
| 极简架构图 | 一张图 + 少量文字 | |

**User's choice:** 高层概览

### 可视化方式

| Option | Description | Selected |
|--------|-------------|----------|
| Mermaid/ASCII 图 | GitHub 原生渲染，无需外部工具 | ✓ |
| 纯文字描述 | | |
| 专业架构图（图片） | 需要专门工具画图 | |

**User's choice:** Mermaid/ASCII 图

### 章节结构

| Option | Description | Selected |
|--------|-------------|----------|
| 标准结构 | 技术栈总览、系统架构图、模块职责、核心数据流、外部依赖 | ✓ |
| 扩展结构 | 标准结构 + 数据库表关系 + API 设计 + 安全模型 | |
| 你决定 | Claude 自行设计 | |

**User's choice:** 标准结构

---

## 用户手册组织方式

### 内容组织

| Option | Description | Selected |
|--------|-------------|----------|
| 按功能模块 | 实例管理、SQL控制台、告警管理、AI分析等分章 | ✓ |
| 按操作任务 | 日常巡检、故障排查、性能调优等 | |
| 按用户角色 | 管理员、DBA、普通用户 | |

**User's choice:** 按功能模块

### 详细程度

| Option | Description | Selected |
|--------|-------------|----------|
| 截图+步骤+FAQ | 每个功能配截图 + 分步骤 + 常见问题 | ✓ |
| 纯文字功能说明 | 不做截图 | |
| 简要功能列表 | | |

**User's choice:** 截图+步骤+FAQ

### 覆盖范围

| Option | Description | Selected |
|--------|-------------|----------|
| 全功能覆盖 | v1.2 所有模块 | ✓ |
| 核心功能为主 | 高频功能详细，其他简要 | |
| 你决定 | Claude 自行决定详略 | |

**User's choice:** 全功能覆盖 v1.2

### 文件格式

| Option | Description | Selected |
|--------|-------------|----------|
| 单文件 USER-GUIDE.md | 一个文件包含全部内容 | ✓ |
| 多文件目录结构 | 每个模块独立 .md | |
| README 内嵌 | | |

**User's choice:** 单文件 USER-GUIDE.md

### OPERATIONS.md 范围

| Option | Description | Selected |
|--------|-------------|----------|
| 全栈覆盖 | db-ops-api + frontend + OpenClaw Gateway + 依赖服务 | ✓ (user expanded from "部署+配置+启停") |

**User's choice:** 全栈覆盖 — 不仅数据库运维，还要包括 OpenClaw Gateway 运行机制（WebSocket、会话管理、Agent 调度）

---

## 已有文档迁移

### 迁移策略

| Option | Description | Selected |
|--------|-------------|----------|
| 按需迁移 | 运行时配置留根目录，文档移入 docs/slide/，上游文件移入 tmp/ | ✓ |
| 全部迁移 | | |
| 仅新增不改动 | | |

**User's choice:** 按需迁移。最终确认分类：
- 留在根目录：CLAUDE.md、AGENTS.md、SOUL.md、IDENTITY.md、HEARTBEAT.md
- 移入 docs/slide/：PROJECT_STRUCTURE.md
- 移入 tmp/：analysis_*.md、CONTRIBUTING.md、README.md、SECURITY.md、VISION.md、TOOLS.md、USER.md、SLIDE_FORK.md、SLIDE_REFACTOR_PLAN.md

---

## 导航与目录结构

| Option | Description | Selected |
|--------|-------------|----------|
| 简洁结构 | README.md 导航 + assets/ 截图 + 三个核心文档平铺 | ✓ |
| 分组子目录 | architecture/、operations/、user-guide/ | |
| 你决定 | | |

**User's choice:** 简洁结构

---

## 文档维护策略

| Option | Description | Selected |
|--------|-------------|----------|
| 代码同步维护 | 功能变更时同步更新文档，PR review 检查 | ✓ |
| 里程碑批量更新 | 每个 milestone 结束时统一更新 | |
| 按需更新 | 重大变更时手动更新 | |

**User's choice:** 代码同步维护

---

## 截图与图片管理

| Option | Description | Selected |
|--------|-------------|----------|
| 仓库内 assets | 存在 docs/slide/assets/screenshots/，版本同步 | ✓ |
| 外部图床链接 | 仓库体积小，离线不可看 | |
| 你决定 | | |

**User's choice:** 仓库内 assets

---

## Claude's Discretion

- ARCHITECTURE.md 的具体章节目录和 Mermaid 图设计
- 用户手册各功能模块的章节编排顺序
- OPERATIONS.md 的具体配置项列表和启停步骤
- README.md 索引导航的格式
- 截图的具体内容和数量

## Deferred Ideas

None — discussion stayed within phase scope.
