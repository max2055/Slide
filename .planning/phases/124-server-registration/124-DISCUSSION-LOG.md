# Phase 124: 服务器注册与凭据管理 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-07
**Phase:** 124-服务器注册与凭据管理
**Areas discussed:** 服务器表单设计, 凭据管理方式, 连接测试UX, 导航位置

---

## 服务器表单设计

| Option | Description | Selected |
|--------|-------------|----------|
| 简洁版：基础字段 | IP/主机名、SSH端口（默认22）、标签、OS类型 | ✓ |
| 详细版：更多元信息 | 额外增加描述备注、环境标签、分组等 | |
| 固定选项列表 | CentOS/Ubuntu/Debian/RHEL/Other | ✓ |
| 自由输入 | 自定义输入OS类型 | |
| 自动探测 | 采集时自动探测OS信息并回填 | |
| IP/主机名+可选别名 | IP/主机名作为默认显示名，可选填别名 | ✓ |
| 必填别名 | 必须填写display_name | |
| 仅显示IP | 只用IP显示 | |
| 添加即启用 | 添加后默认启用采集 | ✓ |
| 添加后暂停 | 添加后默认暂停采集 | |
| 单列表单 | 参考现有模式 | ✓ |
| 多标签页表单 | 基本信息一页、凭据一页 | |

**User's choice:** 简洁版基础字段 + 固定OS列表 + IP/主机名可选别名 + 添加即启用 + 单列布局

---

## 凭据管理方式

| Option | Description | Selected |
|--------|-------------|----------|
| 密码+私钥都支持 | 同时支持密码和私钥认证 | ✓ |
| 仅私钥认证 | 只支持私钥认证 | |
| 内嵌在服务器表单中 | 凭据直接写在服务器表单中 | ✓ |
| 独立凭据管理 | 凭据独立管理 | |
| 各自独立配置 | 每个服务器独立配置 | ✓ |
| 支持复用已有凭据 | 支持选择已有凭据 | |

**User's choice:** 密码+私钥都支持 + 内嵌在表单 + 各自独立 + AES-256-CBC加密

---

## 连接测试UX

| Option | Description | Selected |
|--------|-------------|----------|
| 简单版：成功/失败 | 仅显示连接成功/失败 | ✓ |
| 详细版：回显信息 | 显示OS类型、内核版本等 | |
| 表单底部（同现有模式） | 按钮放在提交按钮附近 | ✓ |
| 独立区域 | 在表单中独立区域 | |

**User's choice:** 简单版成功/失败 + 表单底部同现有模式

---

## 导航位置

| Option | Description | Selected |
|--------|-------------|----------|
| 一级导航 | 与实例/告警等平级 | |
| 二级导航 | 设置页子页 | |

**User's freeform response:** 调整一级菜单「数据库运维」→「运维」，增加「服务器管理」在「数据库管理」上方。

**Final structure:**
- 运维（原「数据库运维」）
  - 服务器管理（新增）
  - 数据库管理（原「实例管理」）
- 设置

---

## Deferred Ideas

None — discussion stayed within phase scope
