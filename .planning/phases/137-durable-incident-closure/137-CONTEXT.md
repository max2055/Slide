---
phase: 137-durable-incident-closure
status: planned
priority: P1
depends_on:
  - 133-operation-sql-safety
  - 135-agent-ws-contracts
  - 136-resource-observability-truth
plans: 3
source: Phase 131 audit, mechanism review, and Data Loom review
---

# Phase 137：持久工作流、事件调查与业务闭环

## 目标

以 MySQL outbox、持久 lease 和幂等 consumer 建立可靠工作流，将告警、事件、RCA、报表、通知、Operation 和结果验证连接成可恢复闭环；向 Data Loom 提供只读、版本化、可追溯的调查投影。

## 覆盖发现

- HI-08：服务器告警 RCA 无法创建或持久化
- HI-09：定时报表和服务器范围报表未闭环
- HI-11：通知 worker 禁用（安全边界由 Phase 132 修复）
- DR-01：确定性 Cron 任务依赖自由文本 LLM
- DR-02：worker 锁、去重和订阅仅在单进程内存
- ME-07：执行结果和事件缺少业务血缘
- Data Loom：事件调查、推理证据、审批执行、运营记忆建议

## 锁定决策

1. 使用 MySQL transactional outbox，不引入 Kafka。投递语义为 at-least-once，consumer 必须按 event id/idempotency key 去重。
2. worker 使用持久 lease、heartbeat、attempt、next_attempt_at 和 dead-letter 状态；进程崩溃后可被其他 worker 接管。
3. 容量、清理、报表、告警评估和通知等确定性任务使用类型化 handler。LLM 仅用于 RCA/摘要等边界清晰的分析步骤。
4. `alert_event_members` 是事件与告警关系的唯一事实源；不为 Data Loom 重复维护单一 `source_id`。
5. 事件生命周期固定为 `open -> investigating -> mitigated -> verifying -> resolved -> closed -> reviewed`，每次转换记录 actor、reason 和 Operation。
6. AIAnalysis 使用 Phase 136 ResourceRef，支持实例和服务器；事件通过显式 relation 关联分析，不再依赖解析 cache_key。
7. 提供版本化 `InvestigationPackage`：资源、事件、成员告警、主分析/相关分析、证据、建议、Operation、审批、执行、验证和 provenance。
8. Slide 是事实/控制面；Data Loom 只读消费 API/outbox，不直接依赖内部表。Data Loom 的质量评分不能成为 Slide 发布门禁。
9. 只有 closed/reviewed、结果经过验证且 provenance 完整的事件才能成为运营记忆候选。

## 非目标

- 不在 Slide 内实现通用跨领域图数据库。
- 不允许 Data Loom 直接写审批、Operation 或事件状态。
- 不承诺 exactly-once 外部投递。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 137-01 | 1 | outbox、lease、worker runtime、类型化 job handler 与 dead letter |
| 137-02 | 2 | 事件状态机、实例/服务器 RCA、InvestigationPackage 与 Data Loom 契约 |
| 137-03 | 3 | 定时报表、通知投递、事件 UI、结果验证与运营记忆候选闭环 |

## Phase 退出门禁

- worker 在重复投递、进程退出和 lease 过期后不丢事件且不重复业务副作用。
- 实例和服务器告警均可形成事件、RCA 和持久分析。
- 报表配置创建后，到期生成、持久化、下载和通知全链路通过。
- 通知失败具备重试、dead letter、脱敏审计和人工重放。
- InvestigationPackage 不依赖 cache_key 猜关系，并能追溯到 Slide 原始记录。
- 事件只有在恢复验证成功后才能关闭或进入记忆候选。
