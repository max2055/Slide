# Phase 115: 去 OpenClaw 迁移后清理 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-02
**Phase:** 115-openclaw-todo-ci
**Areas discussed:** 工具 TODO 修复, 前端残留引用清理, 文档更新, CI 设置

---

## 工具 TODO 修复

| Option | Description | Selected |
|--------|-------------|----------|
| 修复全部 | 3 个 TODO + 2 个空壳工具全部本阶段修复 | ✓ |
| 只修复功能性 TODO | report-service + self-mgmt 空壳工具。D-08 延后 | |
| 只修复空壳工具 | 仅 fix check_status.ts 和 configure_llm.ts | |

**User's choice:** 修复全部
**Notes:** CLAUDE.md "self-mgmt 空壳工具" 实际已过时 — 两个工具都已完整实现。真正问题是 LLM 配置工具重复

---

## D-08 RBAC Scope 实现

| Option | Description | Selected |
|--------|-------------|----------|
| 基于当前用户过滤 | 从 request context 获取当前用户，按实例权限过滤 | ✓ |
| 移除 TODO 注释 | 标记 deferred，等实例级权限完整后加 scope | |
| 加 instance-level 过滤 | 读取 user_instance_permissions 表过滤 | |

**User's choice:** 基于当前用户过滤

---

## LLM Agent 工具去重

| Option | Description | Selected |
|--------|-------------|----------|
| 删除全部 Agent LLM 工具 | configure_llm.ts + llm-config/index.ts 都删除 | ✓ |
| 保留一套精简版 | 只保留 configure_llm.ts | |
| 两套都保留 | 不去重 | |

**User's choice:** 删除全部 Agent LLM 工具
**Notes:** 用户确认 LLM 配置统一走设置页 REST API，Agent 不需要通过对话管理配置。两套工具是 Agent 侧功能，和设置页功能重复

---

## 容量数据采集

| Option | Description | Selected |
|--------|-------------|----------|
| 实现真实采集 | database-service.ts 已有容量查询方法可复用 | ✓ |
| 改为显式空值 | 报表容量 section 标注"暂无数据" | |
| 延后处理 | 暂时不动 | |

**User's choice:** 实现真实采集

---

## 前端死代码清理

| Option | Description | Selected |
|--------|-------------|----------|
| 系统扫描+批量删除 | 扫描所有 import 已删除文件的代码，批量删除 | ✓ |
| 只清 routing 死代码 | 只删 routing 目录下 3-5 个文件 | |
| 暂时不动 | 保留现状 | |

**User's choice:** 系统扫描+批量删除
**Notes:** types.openclaw.ts 和 config/bindings.ts 已不存在，80+ 文件仍 import。routing 文件无其他文件 import — 确认为死代码链

---

## 注释和文本清理

| Option | Description | Selected |
|--------|-------------|----------|
| 清理全部注释和文本 | 注释、i18n、CLAUDE.md 等所有 OpenClaw 文本引用 | ✓ |
| 只清功能性残留 | 只删 i18n 和协议文档，注释不动 | |
| 暂时不动 | | |

**User's choice:** 清理全部注释和文本
**Notes:** openclaw → 中性别名（不用 slide），gateway → 保留（已是中性术语）

---

## 后端 Gateway 残留

| Option | Description | Selected |
|--------|-------------|----------|
| 清理 | server.ts gateway_version + package.json gateway 脚本 | ✓ |
| 延后 | | |

**User's choice:** 清理

---

## __openclaw Session Marker

| Option | Description | Selected |
|--------|-------------|----------|
| 检查后清理 | 确认 DirectAdapter 是否仍产生/消费此 marker | ✓ |
| 保留 | 作为向后兼容 | |

**User's choice:** 检查后清理

---

## Vite 别名

| Option | Description | Selected |
|--------|-------------|----------|
| 重命名为中性别名 | openclaw/plugin-sdk → 中性别名，同步更新 import | ✓ |
| 只清死代码，别名不动 | | |
| 删除 auto-reply 全部 | | |

**User's choice:** 重命名为中性别名
**Notes:** auto-reply 是运行时功能代码，保留。只改别名

---

## 杂项清理

| Option | Description | Selected |
|--------|-------------|----------|
| 全部清理 | server.ts 路由、direct-gateway.ts 重命名、注释更新 | ✓ |
| 只清路由和注释 | | |
| 不动杂项 | | |

**User's choice:** 全部清理

---

## 命名原则

**User's rule:** 命名/注释/代码中含 openclaw 的，替换为中性标识，不要使用 slide。gateway 命名可以保留，是中性命名。

---

## Gateway 术语重命名

| Option | Description | Selected |
|--------|-------------|----------|
| 重命名去 Gateway | GatewaySessionRow → SessionRow 等 | |
| 不动 | | ✓ (用户澄清: gateway 保留) |

**User's choice:** gateway 命名保留（中性术语）

---

## 文档更新

| Option | Description | Selected |
|--------|-------------|----------|
| 全面更新所有文档 | ARCHITECTURE.md 等 5 个文档 79 处引用 | |
| 只修复事实错误 | | |
| 延后 | 放到后续专门 phase | ✓ |

**User's choice:** 延后

---

## CI 范围

| Option | Description | Selected |
|--------|-------------|----------|
| CI 跑 lint+类型+测试 | PR 时运行完整检查 | ✓ |
| CI 只跑 lint+类型 | | |
| 只加 CI 配置，不修测试 | | |

**User's choice:** CI 跑 lint+类型+测试

---

## 失败测试处理

| Option | Description | Selected |
|--------|-------------|----------|
| 先修测试再启用 CI | 修复所有 118 个失败测试 | ✓ |
| skip 失败测试 | 加 .skip，issue 跟踪 | |
| 分步加 CI，测试允许失败 | | |

**User's choice:** 先修测试再启用 CI

---

## CI 结构

| Option | Description | Selected |
|--------|-------------|----------|
| 一个 workflow，两个 job | 前后端分开 job | ✓ |
| 分开两个 workflow | | |
| planner 决定 | | |

**User's choice:** 一个 workflow，两个 job

---

## Claude's Discretion

- 中性别名的具体命名（@agent/、@core/、@app/ 等）
- CI workflow 文件结构和 job 配置细节
- 118 个失败测试的修复顺序和策略
- database-service.ts 容量查询方法的复用方式

## Deferred Ideas

- 文档更新: docs/slide/ 下 5 个文档共 79 处 OpenClaw/Gateway 引用 → 延后到专门文档更新 phase
