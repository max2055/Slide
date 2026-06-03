# Phase 104: 告警系统增强 - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning

## Phase Boundary

增强告警规则的可编辑性：三级阈值独立编辑、规则列表内联启用/禁用开关、threshold_type 和 silence_minutes 完整持久化、事件聚合从固定 5 分钟桶改为滑动窗口。

## Implementation Decisions

### 阈值编辑
- **D-01:** 替换单阈值数字输入为三档独立输入框 (warning/error/critical)，threshold_template JSON 改为扁平字段。
- **D-02:** 阈值验证：warning < error < critical，空值允许（表示该级别不触发）。

### 启用/禁用开关
- **D-03:** 告警规则列表每行加 inline switch 开关，点击即切换，乐观 UI 更新，失败时回滚。

### threshold_type 动态阈值
- **D-04:** 完整激活：前后端都修。前端加 static/dynamic 切换，dynamic 模式下隐藏手动阈值输入；后端 SELECT/INSERT/UPDATE 补齐 threshold_type、silence_minutes、dynamic_config 三个列的读写。
- **D-05:** silence_minutes 在规则编辑器中暴露为数字输入（默认 5），与 threshold_type 同批修复。

### 事件聚合修复
- **D-06:** 废弃 FLOOR(UNIX_TIMESTAMP/300) 固定桶边界。改为实际时间差比较：新告警与前一条已聚合告警的 created_at 差值 ≤10 分钟则归入同一事件，不依赖桶边界。

### Claude's Discretion
- 前端 UI 布局、表单字段顺序由 Agent 自行决定，遵循现有 aler.ts 的设计模式。

## Canonical References

### 告警系统
- `apps/db-ops-api/sql/schema.sql` §alert_rules — 表结构定义（含 ALTER TABLE 追加的 threshold_type/silence_minutes/dynamic_config）
- `apps/db-ops-api/src/alert-database-service.ts` — AlertRule 接口和 CRUD 方法（当前缺少新列的读写）
- `apps/db-ops-api/src/event-aggregator.ts` — 事件聚合逻辑（5 分钟 FLOOR 桶）
- `apps/db-ops-api/src/alert-evaluator.ts:126` — resolveDynamicThreshold（当前因 threshold_type 未读取而永远回退到静态）
- `apps/db-ops-api/server.ts` §alert-rules — PUT/POST/GET 路由

### 前端
- `frontend/src/openclaw/ui/views/alerts.ts` — 告警页面（规则列表、编辑器弹窗、启用开关未实现）

## Existing Code Insights

### Reusable Assets
- `frontend/src/components/stat-card.ts` — 共享组件，可用于告警统计区域
- `frontend/src/openclaw/api/index.js` — authFetch 封装，前端 API 调用统一入口

### Established Patterns
- 规则 CRUD 使用弹窗表单模式（alerts.ts `_openRuleModal`）
- 乐观 UI 更新模式可参考 reports.ts 的 toggle 实现
- 后端 CRUD 路由模式：Fastify handler + preHandler auth

### Integration Points
- 告警引擎 (`alert-engine.ts`) 评估规则时读取 threshold_type 决定是否走动态阈值路径
- 事件聚合器 (`event-aggregator.ts`) 在每次引擎评估周期中被调用
- 前端 alerts.ts 的 `_loadAlertRules()` 和 `_saveRule()` 是主要修改点

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 104-告警系统增强*
*Context gathered: 2026-05-21*
