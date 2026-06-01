# Phase 100: 安全紧急修复 - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

## Phase Boundary

紧急修复 v1.3 的 4 个生产缺陷：4 个无认证 API 路由暴露数据、登录页 eyeOff 图标渲染异常、monitor-collector 与 alert-engine 重复产生告警、健康评分硬编码为 100。

This is a pure bugfix phase — no new features, no refactoring beyond what each fix requires.

## Implementation Decisions

### SEC-01: Auth 中间件（4 个未保护路由）
- **D-01:** 4 个 GET 路由统一加 `preHandler: [verifyToken]`，不引入新 permission code
  - `GET /api/alerts` (server.ts:532)
  - `GET /api/metrics/:instanceId` (server.ts:567)
  - `GET /api/database/instances` (server.ts:388)
  - `GET /api/chat/history` (server.ts:578)
- 理由：这些是只读数据，任意已登录用户均可访问。不需要 `requirePermission('alert:view')` 等新权限码。

### SEC-02: eyeOff 图标崩溃
- **D-02:** 给 `eyeOff` SVG 元素补充 `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` 属性
- eyeOff 图标已存在于 `frontend/src/openclaw/ui/icons.ts:439`，且已打入 dist bundle，不是缺失问题
- 根因推测是 SVG 缺少标准渲染属性导致不可见（其他 icons 也有相同问题，可一并修）

### SEC-03: 重复告警
- **D-03:** 完全移除 `monitor-collector.ts` 中的 `checkAlerts()` 方法及其两处调用（L190, L208），alert-engine 为唯一告警入口
- 不改为调 alert-engine、不加 source 标记区分
- alert-engine 已有完整告警生命周期（静默→聚合→升级→通知），monitor-collector 的简化版是早期原型遗留

### SEC-04: 硬编码健康评分
- **D-04:** 所有路径统一使用 `databaseService.checkHealth()` 获取实际评分
  - `report-service.ts:321` → 改为调用 `checkHealth()` 获取实际值
  - `monitor-collector.ts:200,228`（重连成功路径）→ 改为重连后重新 `checkHealth()` 再更新，不写死 100
- `checkHealth()` 已有现成计算逻辑，直接复用，不新建评分服务

### Claude's Discretion
- 是否在给 eyeOff 加属性的同时一并修复其他缺属性的图标 —— 评估改动量与风险自行决定

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Security Context
- `.planning/REQUIREMENTS.md` — SEC-01~SEC-04 需求定义及 v1.3 scope
- `.planning/ROADMAP.md` — Phase 100 成功标准和依赖关系
- `.planning/PROJECT.md` — Key Decisions 中的 RBAC/auth 决策背景

### No external specs for this phase — all requirements captured above.

## Existing Code Insights

### Reusable Assets
- `verifyToken` (server.ts:85) — JWT 验证中间件，已用于多个路由
- `requirePermission` (src/auth/require-permission.js) — 按需可加，本阶段暂不用
- `databaseService.checkHealth()` — 已有健康评分计算逻辑，`monitor-collector.ts:276` 已在用

### Established Patterns
- 路由 auth 模式：`{ preHandler: [verifyToken, requirePermission('xxx:yyy')] }` — D-01 只用 `[verifyToken]`
- alert-engine 是告警唯一正确入口 — cron → evaluate → createAlertFromRule → createAlert
- Health check: `checkHealth()` → `updateHealthStatus(score, status)` → `recordHealthCheck()`

### Integration Points
- `server.ts` — 4 个路由注册点：L388, L532, L567, L578
- `monitor-collector.ts:311-341` — `checkAlerts()` 待删除；L190, L208 两处调用点待移除
- `monitor-collector.ts:274-307` — `updateHealthStatusFromCheck()` 已正确使用 `checkHealth()`，无需改
- `report-service.ts:321` — `collectHealthMetrics()` 硬编码点
- `frontend/src/openclaw/ui/icons.ts:439` — eyeOff 图标定义

## Specific Ideas

无特殊参考 — 按标准方式修复。

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 100-安全紧急修复*
*Context gathered: 2026-05-20*
