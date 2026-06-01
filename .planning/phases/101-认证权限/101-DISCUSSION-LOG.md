# Phase 101: 认证权限 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-20
**Phase:** 101-认证权限
**Areas discussed:** Refresh Token 策略, 实例访问级别粒度, 权限感知导航, 授权过期处理

---

## Refresh Token 策略

| Option | Description | Selected |
|--------|-------------|----------|
| 1 小时 | access token 1h，安全且体验好 | ✓ |
| 15 分钟 | 最高安全，刷新频率高 | |
| 24 小时 | 现状不改 | |

**User's choice:** access token 1h + refresh token 7d + token rotation
**Notes:** 用户明确理解了 token 泄露影响（1h 窗口，rotation 可检测重放）。refresh token 存 localStorage。

---

## 实例访问级别粒度

| Option | Description | Selected |
|--------|-------------|----------|
| 按操作类型分 | read-only=查看+SELECT, read-write=以上+修改, admin=全部+管理 | ✓ |
| 按模块分 | 每个模块独立控制 | |
| 简化两级 | 只需 read-only 和 admin | |

**User's choice:** 按操作类型分三级，read-only 可执行 SQL SELECT
**Notes:** 已有 require-instance-access.ts 中间件可扩展

---

## 权限感知导航

| Option | Description | Selected |
|--------|-------------|----------|
| 完全隐藏 | 侧边栏看不到无权限项 | ✓ |
| 灰显不可点击 | 可见但置灰 | |

**User's choice:** 完全隐藏 + 扩展现有 scopes 机制
**Notes:** hasOperatorReadAccess() 和 hello.auth.scopes 已有基础

---

## 授权过期处理

| Option | Description | Selected |
|--------|-------------|----------|
| 立即回收+静默降级 | 到期瞬间权限消失，不影响登录态 | ✓ |
| 立即回收+通知 | 同上但推送通知 | |
| 宽限期 24h | 保留 24h 只读缓冲 | |

**User's choice:** 立即回收 + 静默降级
**Notes:** 不做提前提醒和宽限期

## Claude's Discretion

- refresh token 表 schema 设计
- token rotation 重放检测阈值
- 实例访问级别的具体 API 路由映射
