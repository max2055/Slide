---
gsd_state_version: 1.0
milestone: v0.9
milestone_name: 生产化与可信运维闭环
current_phase: 139
current_phase_name: 生产发布资格验证
status: shipped
last_updated: "2026-07-23T09:00:00+08:00"
last_activity: 2026-07-23
last_activity_desc: Post-v0.9 roadmap closure locally requalified; hosted artifact/recovery proven; server 3 SSH credential re-entry remains operator-only
progress:
  total_phases: 9
  completed_phases: 9
  total_plans: 19
  completed_plans: 19
  percent: 100
---

## v0.9 生产化与可信运维闭环 — Shipped

Phase 131 的 NO-GO 审计基线已由 Phase 132-139 修复与资格验证闭环。`139-VERIFICATION.md` 在当前代码、51 migrations、恢复场景、安全矩阵、四数据库 adapter 矩阵和浏览器用户路径上给出权威 GO。

| Phase | Plans | Status | Primary gate |
|---|---:|---|---|
| 131. 系统级代码审计 | audit docs | complete | 3 Critical / 13 High / 7 Medium / 1 Low 已确认，production ready=false |
| 132. 安全边界与统一身份上下文 | 2/2 | complete | ActorContext、Chat ACL、Tool Policy、secret/XSS/SSRF |
| 133. Operation 状态机与 SQL 安全 | 2/2 | complete | SQL 只读边界、原子审批、执行血缘 |
| 134. 确定性 Schema 与进程生命周期 | 2/2 | complete | 空库/升级、migration ledger、重复进程无副作用 |
| 135. Agent/WS 执行契约 | 2/2 | complete | WS v2、真实终态/取消/幂等、AnalysisEnvelope |
| 136. 资源与可观测性真相 | 3/3 | complete | ResourceRef、指标/调度、统一告警、四维健康 |
| 137. 持久事件与业务闭环 | 3/3 | complete | outbox/lease、RCA/调查包、报表/通知/验证 |
| 138. 能力/配置/类型化契约 | 2/2 | complete | adapter 矩阵、deferred UAT、配置发布/回滚 |
| 139. 生产发布资格验证 | 3/3 | complete / GO | clean-room release workflow 与 GO/NO-GO |

## Current Position

- v0.9 已于 2026-07-20 达到 Phase 139 GO；权威证据为 `139-VERIFICATION.md` 与 `139-EVIDENCE-MATRIX.md`。
- Licensed Dameng 环境已通过 connection/health/query/metrics/disconnect/recovery 完整矩阵，TG-05 已关闭。
- Feishu 机器人真实投递已在 2026-07-22 成功并由运维方确认收到；SMTP 真实投递仍未声明。安全、失败和审计契约继续保持验证。
- 2026-07-21 发布后增量修复统一了仪表盘与实例管理的受管实例容量口径，并修复 MySQL/达梦“明细先舍入再求和”导致的容量漂移。主库主动采集后，实例合计与仪表盘均为 `2.71 GB`，`capacity_sum_match` 为 `pass`。
- 2026-07-23 最终本地批次已重跑 API 98 files/1001 tests、前端 23/188、Agent Core 7/69、三组 typecheck、production build、lint 0 errors/249 warnings、37/37 matrix、CI parity、生成契约漂移检查和懒加载/i18n 浏览器回归 2/2。历史托管浏览器 22/22 与取消/附件 2/2 仍为 Phase 139 全链路证据。
- Hosted CI、发布产物和回滚演练已在 PR #3 的 run `29939147753` 全绿；当前增量提交需以 PR 最新 head checks 为最终 hosted 状态。
- 当前存储凭据已验证 5/5 数据库实例、DeepSeek 和 Feishu；服务器 3 的旧 SSH 凭据无法解密，必须由运维方重新录入后才能关闭最后一个真实环境健康缺口。

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
