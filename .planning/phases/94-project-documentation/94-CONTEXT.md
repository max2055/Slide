# Phase 94: Project Documentation - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning

## Phase Boundary

为 Slide 项目编写完整文档：ARCHITECTURE.md（架构文档）、OPERATIONS.md（运维文档）、USER-GUIDE.md（用户手册）。覆盖整个 Slide 项目——不仅是数据库运维后端，还包括 OpenClaw Gateway 运行机制和前端。清理现有 OpenClaw 上游文档，建立清晰的 docs/ 目录结构。

## Implementation Decisions

### 文档位置与清理
- **D-01:** 三大核心文档（ARCHITECTURE.md、OPERATIONS.md、USER-GUIDE.md）放在 `docs/slide/` 子目录
- **D-02:** 删除 `docs/` 中所有 OpenClaw 上游文档（gateway/、plugins/、channels/、providers/、concepts/ 等 70+ 文件），只保留 Slide 项目文档
- **D-03:** 根目录文件分类处理：
  - **保留在根目录**（运行时需要）：CLAUDE.md、AGENTS.md、SOUL.md、IDENTITY.md、HEARTBEAT.md
  - **移入 docs/slide/**：PROJECT_STRUCTURE.md
  - **移入 tmp/**（上游无用文件）：analysis_*.md、CONTRIBUTING.md、README.md、SECURITY.md、VISION.md、TOOLS.md、USER.md、SLIDE_FORK.md、SLIDE_REFACTOR_PLAN.md

### 语言与受众
- **D-04:** 全部文档使用中文
- **D-05:** 按文档区分目标受众：
  - ARCHITECTURE.md → 技术团队（开发者、架构师）
  - OPERATIONS.md → 运维人员
  - USER-GUIDE.md → DBA 和运维用户

### ARCHITECTURE.md
- **D-06:** 深度：高层概览 — 系统架构图 + 各模块职责概要 + 核心数据流
- **D-07:** 可视化：Mermaid/ASCII 图（GitHub 原生渲染，无需外部工具）
- **D-08:** 标准章节结构：技术栈总览、系统架构图、模块职责、核心数据流、外部依赖

### USER-GUIDE.md
- **D-09:** 按功能模块分章组织（非按角色或任务）
- **D-10:** 详细程度：截图 + 分步骤操作说明 + 常见问题 FAQ
- **D-11:** 覆盖 v1.2 全功能模块：实例管理、SQL 控制台、告警管理、AI 分析、Chat 助手、报表、审批、RBAC 权限、仪表盘、AI 设置
- **D-12:** 单文件 USER-GUIDE.md（不拆分多文件）

### OPERATIONS.md
- **D-13:** 全栈覆盖，不仅是数据库运维，包括：
  - db-ops-api 后端部署运维
  - OpenClaw Gateway 运行机制（WebSocket 连接、会话管理、Agent 调度、通道配置）
  - frontend 前端构建部署
  - 依赖服务（MySQL、Elasticsearch、MongoDB、Redis）配置维护
  - 启停流程、配置项说明

### 目录结构与维护
- **D-14:** docs/slide/ 目录结构：
  ```
  docs/slide/
  ├── README.md            # 索引导航
  ├── ARCHITECTURE.md      # 架构文档
  ├── OPERATIONS.md        # 运维文档
  ├── USER-GUIDE.md        # 用户手册
  ├── PROJECT_STRUCTURE.md # 项目结构（从 docs/ 移入）
  └── assets/
      └── screenshots/     # 用户手册截图
  ```
- **D-15:** 维护策略：代码同步维护 — 功能变更时同步更新对应文档，PR review 检查文档
- **D-16:** 截图存在仓库内 `docs/slide/assets/screenshots/`，版本同步

### Claude's Discretion
- ARCHITECTURE.md 的具体章节目录和 Mermaid 图设计
- 用户手册各功能模块的章节编排顺序
- OPERATIONS.md 的具体配置项列表和启停步骤
- README.md 索引导航的格式
- 截图的具体内容和数量

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Roadmap
- `.planning/REQUIREMENTS.md` §DOC-01 — 项目文档的验收标准
- `.planning/ROADMAP.md` §Phase 94 — 阶段目标与成功标准

### Project Context
- `.planning/PROJECT.md` — 项目架构概览、技术栈、关键决策记录

### Existing Slide Docs (reference for content)
- `docs/PROJECT_STRUCTURE.md` — 现有项目结构文档（将移入 docs/slide/）
- `CLAUDE.md` — 项目工作原则和常用命令
- `SOUL.md` — Slide 身份定义和核心定位

### Running System (for OPERATIONS.md content)
- `apps/db-ops-api/.env` — 后端配置项参考
- `apps/db-ops-api/server.ts` — 后端入口和启动流程
- `.openclaw-slide/` — Gateway 运行时状态目录

## Existing Code Insights

### Reusable Assets
- **PROJECT_STRUCTURE.md**: 包含完整的项目目录树和模块说明，可作为 ARCHITECTURE.md 模块职责章节的起点
- **CLAUDE.md**: 包含常用命令、端口号、凭证信息，可直接提取到 OPERATIONS.md

### Established Patterns
- 项目已使用 Mermaid 图（CLAUDE.md 中有架构图参考），ARCHITECTURE.md 沿用一致风格
- 现有文档全部中文，新文档保持一致

### Integration Points
- README.md 需更新为 Slide 项目内容（当前是 OpenClaw 上游），包含指向 docs/slide/ 的链接
- CLAUDE.md 可添加指向新文档的引用

## Specific Ideas

- 用户强调文档内容不要局限于数据库运维，应是整个 Slide 项目（包括 OpenClaw Gateway 智能机制）
- ARCHITECTURE.md 应体现"AI 原生数据库运维平台"的定位，突出 Agent 驱动的自动化运维能力
- OPERATIONS.md 应包含 Gateway 的 WebSocket 连接机制、会话生命周期、Agent 调度逻辑

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 94-project-documentation*
*Context gathered: 2026-05-16*
