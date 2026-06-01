# Slide 项目文档

## 项目概述

Slide 是一个 AI 原生的数据库运维管理平台，基于 OpenClaw Agent 框架构建。平台提供实时数据库监控、智能告警、性能分析、SQL 审核与执行、AI 辅助故障诊断等核心能力，将 DBA 从重复性运维工作中解放出来，实现数据库运维的智能化与自动化。

## 文档索引

| 文档 | 说明 |
|------|------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构文档 — 面向技术团队和架构师，包含技术栈总览、系统架构图、模块职责说明、核心数据流和外部依赖 |
| [OPERATIONS.md](./OPERATIONS.md) | 运维文档 — 面向运维人员，涵盖后端部署、Gateway 运行机制、前端构建部署、依赖服务配置和启停流程 |
| [USER-GUIDE.md](./USER-GUIDE.md) | 用户手册 — 面向 DBA 和运维用户，按功能模块提供分步骤操作说明 |
| [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) | 项目结构说明 — 项目目录树和各模块文件分布 |

## 快速入门

### 启动后端服务

```bash
cd apps/db-ops-api
npx tsx server.ts
```

后端服务运行在 `http://localhost:3000`。

### 启动前端开发服务器

```bash
cd frontend
npm run dev
```

前端开发服务器运行在 `http://localhost:5173`。

### 默认凭据

- 管理员账号：`admin`
- 默认密码：`Tpam1234`

## 文档维护

文档与代码同步维护（D-15 策略）：

- **功能变更时**：新增或修改功能后，同步更新对应文档的相关章节
- **PR review 中**：检查文档是否与代码变更保持一致
- **架构变更时**：更新 ARCHITECTURE.md 中的架构图和模块说明
- **运维流程变更时**：更新 OPERATIONS.md 中的相关配置和步骤

文档文件位于 `docs/slide/` 目录下，遵循 GitHub Markdown 格式。

---

*维护者：Slide 项目团队*
