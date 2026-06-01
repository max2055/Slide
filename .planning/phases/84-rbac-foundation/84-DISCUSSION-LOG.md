# Phase 84: RBAC Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-09
**Phase:** 84-rbac-foundation
**Areas discussed:** 迁移策略, 权限码设计, 中间件集成方式, 向后兼容策略

---

## 迁移策略

| Option | Description | Selected |
|--------|-------------|----------|
| Dual-write 渐进迁移 | 保留 users.role 列，新中间件读 user_roles，旧中间件继续用 ENUM，共存过渡 | |
| 直接替换 | 一次性迁移所有用户到 user_roles，立即替换所有中间件，删掉 role 列 | ✓ |

**User's choice:** 直接替换
**Notes:** 当前用户量少，直接替换风险可控

---

## 权限码设计

| Option | Description | Selected |
|--------|-------------|----------|
| resource:action 模式 | 如 instance:view, alert:manage, user:create | ✓ |
| 继承现有 tool policy 命名 | 从 role-permissions.ts 的 tool group 推断 | |

**User's choice:** resource:action 模式
**Notes:** 两层粒度（操作级 + 模块级），支持 wildcard 匹配

---

## 中间件集成方式

| Option | Description | Selected |
|--------|-------------|----------|
| 完全替换旧中间件 | requirePermission + requireInstanceAccess 替代 requireRole，旧代码删除 | ✓ |
| 新旧共存过渡 | 新的加进去，旧的 requireRole 保留为 fallback | |

**User's choice:** 完全替换
**Notes:** 与直接替换迁移策略一致

---

## 向后兼容策略

| Option | Description | Selected |
|--------|-------------|----------|
| 不保留兼容，前端同步升 | 用户管理 API 直接改，前端 Phase 85 做适配 | |
| 保留过渡期 + 新路径 | 新 API 用 /api/v1/rbac/*，旧 /api/users 保留到 Phase 85 完成 | ✓ |

**User's choice:** 保留过渡期 + 新路径
**Notes:** 给 Phase 85 前端迁移留缓冲期

---

## Claude's Discretion

- 权限码初始清单设计
- requirePermission 中间件缓存策略
- 迁移脚本事务边界
- 通配符匹配实现方式
