---
gsd_state_version: 1.0
milestone: v0.9
milestone_name: 生产化与可信运维闭环
current_phase: 132
current_phase_name: 安全边界与统一身份上下文
status: planned
last_updated: "2026-07-17T00:00:00+08:00"
last_activity: 2026-07-17
last_activity_desc: Phase 131 audit complete; Phase 132-139 contexts and 19 implementation plans created
progress:
  total_phases: 9
  completed_phases: 1
  total_plans: 19
  completed_plans: 0
  percent: 0
---

## v0.9 生产化与可信运维闭环 — Planned

Phase 131 已完成系统审计并给出 NO-GO。Phase 132-139 的范围、依赖、退出门禁和 19 份执行计划已建立；尚未修改或修复业务代码。

| Phase | Plans | Status | Primary gate |
|---|---:|---|---|
| 131. 系统级代码审计 | audit docs | complete | 3 Critical / 13 High / 7 Medium / 1 Low 已确认，production ready=false |
| 132. 安全边界与统一身份上下文 | 0/2 | planned | ActorContext、Chat ACL、Tool Policy、secret/XSS/SSRF |
| 133. Operation 状态机与 SQL 安全 | 0/2 | planned | SQL 只读边界、原子审批、执行血缘 |
| 134. 确定性 Schema 与进程生命周期 | 0/2 | planned | 空库/升级、migration ledger、重复进程无副作用 |
| 135. Agent/WS 执行契约 | 0/2 | planned | WS v2、真实终态/取消/幂等、AnalysisEnvelope |
| 136. 资源与可观测性真相 | 0/3 | planned | ResourceRef、指标/调度、统一告警、四维健康 |
| 137. 持久事件与业务闭环 | 0/3 | planned | outbox/lease、RCA/调查包、报表/通知/验证 |
| 138. 能力/配置/类型化契约 | 0/2 | planned | adapter 矩阵、deferred UAT、配置发布/回滚 |
| 139. 生产发布资格验证 | 0/3 | planned | clean-room release workflow 与 GO/NO-GO |

## Current Position

- 下一执行入口：`132-01-PLAN.md` 与 `132-02-PLAN.md`；Phase 134 可作为并行基础工作流启动。
- Phase 133 依赖 132；Phase 136 依赖 134；Phase 135 依赖 132/133。
- Phase 137 依赖 133/135/136；Phase 138 依赖 132/136/137；Phase 139 依赖 132-138 全部 verification passed。
- 在 Phase 139 明确给出 GO 前，Slide 仅可用于受控开发/测试环境和非生产数据/凭据。

## Phase 131 Finding Allocation

| Scope | Owning phase |
|---|---|
| CR-01/02、HI-03/04/11/13 | Phase 132 |
| CR-03、HI-02、ME-07 | Phase 133 |
| HI-01/12、DR-03、TG-03 | Phase 134 |
| HI-10、ME-01/02/05 | Phase 135 |
| HI-05/06/07、ME-03/04、DR-04 | Phase 136 |
| HI-08/09/11、DR-01/02 | Phase 137 |
| ME-06、LO-01、OPT-03、deferred UAT | Phase 138 |
| TG-01/02/04/05/06 与全部 finding 复验 | Phase 139 |

## Deferred Item Disposition

Phase 131 已按当前代码和运行时重新核对旧 deferred items；不再保留模糊的 investigating/testing 状态。

| Previous item | Current evidence | Disposition |
|---|---|---|
| cron-jobs-all-disabled | 当前 3 enabled / 7 disabled，历史“全部禁用”已失效 | closed as stale；确定性任务机制转 Phase 137 |
| dashboard-capacity-and-alert-events | capacity 已有当前数据；健康聚合会掩盖资源 critical | application defect mapped to Phase 136 |
| null-metrics-database-instances | 4 个目标不可达且为 critical，环境问题与错误健康聚合并存 | environment tracked separately；truth model 转 Phase 136 |
| Phase 110 UAT (6 pending) | DirectAdapter 延期验证未完成 | Phase 138-01 必须执行或移出支持范围 |
| Phase 95 UAT (4 pending) | Dameng 延期验证未完成 | Phase 138-01 必须执行或降级能力状态 |
| Phase 84 UAT partial | RBAC 多主体矩阵不完整 | Phase 132 + Phase 138-01 清账 |
| cron-tasks-configurable-not-hardcoded | 仍有自由文本 LLM 调度确定性任务 | Phase 137-01 类型化 handler；Phase 138-02 版本化配置 |

## Preserved History

- v0.8 Phases 124-129 保持 shipped 历史，但其旧 verification 不构成 v0.9 发布证据。
- Phase 130：移除 metric_templates/instance_templates，简化为 metric registry + alert rule templates。
- Data Loom migration 024 的 cross-table IDs/execution status/structured output 将在 Phase 135/137 审计迁移为版本化契约，不直接视为完成集成。
