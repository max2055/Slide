---
phase: 136-resource-observability-truth
status: planned
priority: P1
depends_on:
  - 134-deterministic-schema-bootstrap
plans: 3
source: Phase 131 audit and mechanism review
---

# Phase 136：资源、能力与可观测性真实状态模型

## 目标

统一实例和服务器的资源引用、指标身份、采集能力、告警规则语义与健康状态。系统必须明确区分真实观测、过期数据、未知状态和平台控制面准备度。

## 覆盖发现

- HI-05：多数实例 critical 时健康中心错误全绿
- HI-06：实例/服务器告警评估语义分叉
- HI-07：服务器指标注册 ID 与采集名称不一致
- ME-03：每指标采集周期未生效
- ME-04：采集器失败计数/禁用机制失真
- DR-04：健康、可用性和一致性混成无权重百分比
- ME-06：支持类型声明与 adapter 能力不一致（公开兼容矩阵在 Phase 138）

## 锁定决策

1. 在领域/API 层统一 `ResourceRef { type, id }`，保留 `database_instances` 和 `servers` 子类型表，禁止构建包含所有可选字段的巨型 resources 表。
2. 增加 `resource_relations` 支持 `runs_on`、`hosts`、`replicates_to`、`depends_on`。关系必须有来源和有效期。
3. 指标身份固定为 `(resource_type, metric_id, dimensions)`；显示名称不是 key。磁盘挂载点等维度进入 dimensions。
4. Observation 包含 `observed_at`、`valid_until`、`source`、`quality` 和 `reason`。过期观测不能继续视为 available/healthy。
5. 采集调度粒度为 `(resource, provider, metric)`；只合并同一 tick 真正到期的指标。provider 成功重置连续失败计数，禁用状态只有 registry 一个事实源。
6. 规则先编译成共享 `CompiledAlertRule`，实例和服务器复用 operator、三级阈值、持续时间、恢复和去重语义。
7. 健康输出拆为 control-plane readiness、managed-resource availability、data freshness、workflow health 四个维度。任何关键 unknown/critical 都限制总体状态，禁止用普通检查数量稀释。
8. 能力状态持久化为 `declared | configured | verified | degraded | unsupported`，供 Phase 138 发布兼容矩阵。

## 非目标

- 不统一实例和服务器的物理指标存储表；通过 adapter/repository 提供规范化 Observation。
- 不在本 Phase 构建通用跨行业 Ontology。
- 不实现新数据库类型 adapter。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 136-01 | 1 | ResourceRef、关系、Observation、持久能力状态和查询 API |
| 136-02 | 2 | 规范指标 ID、采集调度、provider 状态和存量映射 |
| 136-03 | 3 | 共享告警评估器、健康/readiness 真相模型与前端呈现 |

## Phase 退出门禁

- 实例和服务器以相同 ResourceRef 查询健康、能力、指标和关系。
- registry 中每个已启用指标都有生产者，生产者输出也都有定义。
- 指标周期测试证明 30s/60s/300s 指标不会统一按最短周期采集。
- 实例和服务器同名指标规则得到一致阈值/持续时间结果。
- 4/5 目标 critical 的 fixture 不可能显示全部就绪或健康 100%。
- stale/unknown 在 API、UI、告警和报表中语义一致。
