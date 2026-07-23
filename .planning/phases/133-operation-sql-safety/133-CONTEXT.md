---
phase: 133-operation-sql-safety
status: planned
priority: P0
depends_on:
  - 132-security-boundaries
plans: 2
source: Phase 131 system-level audit and mechanism review
---

# Phase 133：Operation 状态机与 SQL 安全

## 目标

建立统一、持久、可取消、可审计的 Operation 原语，并将 SQL 查询、审批、执行和验证纳入同一状态机。任何写操作都不能绕过策略或审批，同一审批最多产生一次目标副作用。

## 覆盖发现

- CR-03：直接 SQL 接口绕过 DML/DDL 审批
- HI-02：审批并发竞态导致重复执行
- ME-07：审批、SQL 历史、审计和回滚关联未贯通
- TG-02：缺少并发审批和直接 DML 拒绝测试
- Data Loom：审批与执行结果闭环建议

## 锁定决策

1. 新增 `operations` 和 `operation_events`，状态固定为 `queued | waiting_approval | claimed | running | succeeded | failed | cancelled | unknown`。
2. 每个 Operation 记录 actor、origin、resource ref、command type、risk、idempotency key、approval id、attempt、lease、result、error 和 correlation id。
3. SQL `/execute` 只允许单条、只读语句；DML、DDL、事务控制、多语句和不确定分类全部转到审批提交或拒绝。
4. SQL 分类必须按 MySQL/PostgreSQL/Oracle/Dameng 方言测试；禁止仅用字符串前缀或正则判断。
5. 审批执行采用 compare-and-swap 原子认领：只有 `pending -> claimed` 成功的请求可以执行。外部数据库副作用通过持久幂等键和 lease 恢复，而不是宣称分布式 exactly-once。
6. `approval_request_id`、`operation_id` 和 `correlation_id` 必须贯穿审批事件、SQL 历史和用户审计。
7. 通用自动回滚不作为承诺。仅当计划包含已验证补偿命令时才显示“可回滚”，否则显示人工恢复说明。
8. 前端提供 Operation 状态与事件时间线，取消/重试按钮由状态机和权限决定，不通过修改本地状态模拟完成。

## 非目标

- 不在此 Phase 把所有 Cron/报表/通知迁入 Operation；Phase 137 在同一原语上接入。
- 不提供数据库级分布式事务。
- 不自动生成或执行未经验证的逆向 SQL。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 133-01 | 1 | Operation schema/service、SQL 方言分类器、只读执行边界 |
| 133-02 | 2 | 原子审批认领、审计血缘、补偿信息、Operation UI 与并发验证 |

## Phase 退出门禁

- 所有公开 SQL 路径对 DML/DDL/事务控制/多语句采用一致策略。
- 20 个并发审批请求只产生一次目标执行和一条成功终态。
- 每条获批 SQL 历史可追溯到 actor、Operation、审批和策略决策。
- claimed/running 进程崩溃后可恢复为重试或 unknown，不能静默成功。
- Operation 刷新页面后状态、时间线、错误和可用动作保持一致。
