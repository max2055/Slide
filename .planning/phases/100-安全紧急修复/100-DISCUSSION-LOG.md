# Phase 100: 安全紧急修复 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-20
**Phase:** 100-安全紧急修复
**Areas discussed:** Auth 权限级别, eyeOff 崩溃根因, 重复告警清理策略, 健康评分计算位置

---

## Auth 权限级别

| Option | Description | Selected |
|--------|-------------|----------|
| 仅 verifyToken | 所有登录用户均可读取只读数据，不引入新权限码 | ✓ |
| verifyToken + 具体 permission | 每个路由配对应权限码，需新增 alert:view、chat:view | |
| 按数据敏感度分级 | alerts/metrics 用 verifyToken，instances/chat 加 permission | |

**User's choice:** 仅 verifyToken（推荐）
**Notes:** 四个只读路由统一加 `preHandler: [verifyToken]`，不引入新权限码。

---

## eyeOff 崩溃根因

### 症状确认

| Option | Description | Selected |
|--------|-------------|----------|
| JS 运行时 404/undefined | icons.eyeOff 为 undefined，构建遗漏 | |
| 图标空白但不报错 | SVG 缺 stroke/fill 属性，不可见 | |
| 整页白屏/崩溃 | 其他错误导致登录页崩溃 | |
| 不确定症状 | 需进一步排查 | ✓ |

**User's choice:** 不确定具体症状

### 修复方向

| Option | Description | Selected |
|--------|-------------|----------|
| 补充 SVG 渲染属性 | 加 fill/stroke 标准属性，确保可见 | ✓ |
| 仅修 eyeOff | 不动其他图标 | |
| 需要更多排查 | 跑 dev server 查看具体报错 | |

**User's choice:** 补充 SVG 渲染属性（推荐）
**Notes:** eyeOff 已确认存在于源码（icons.ts:439）和 dist bundle 中。问题是渲染不可见，非文件缺失。

---

## 重复告警清理策略

| Option | Description | Selected |
|--------|-------------|----------|
| 完全移除 checkAlerts() | 删除 monitor-collector 中整个方法及调用点 | ✓ |
| 改为走 alert-engine | 保留实时检测但统一入口 | |
| 加 source 标记区分 | 保留两套路径，前端去重 | |

**User's choice:** 完全移除 checkAlerts()
**Notes:** 用户先询问了 checkAlerts() 是什么、与 alert-engine 的区别。确认 alert-engine 是更完整、更正确的告警入口（含静默/聚合/升级/通知），monitor-collector 的是早期原型遗留。

---

## 健康评分计算位置

| Option | Description | Selected |
|--------|-------------|----------|
| 统一用 checkHealth() | 所有路径调用 databaseService.checkHealth() 获取实际评分 | ✓ |
| 保持现状 + 最小修复 | 只修 report-service 硬编码，重连路径的 100 不改 | |
| 新建评分服务 | 提取独立 HealthScoreService | |

**User's choice:** 统一用 checkHealth()（推荐）
**Notes:** databaseService.checkHealth() 已有现成计算逻辑，直接复用。

---

## Claude's Discretion

- 给 eyeOff 加 SVG 属性的同时是否一并修复其他缺属性的图标

## Deferred Ideas

None.
