---
phase: 138-capability-config-contracts
status: planned
priority: P2
depends_on:
  - 132-security-boundaries
  - 136-resource-observability-truth
  - 137-durable-incident-closure
plans: 2
source: Phase 131 audit and deferred UAT review
---

# Phase 138：兼容能力、配置发布与类型化契约

## 目标

将数据库兼容性和功能可用性建立在可验证能力矩阵上；将告警、指标、Cron、报表和 Agent 策略配置改为可验证、可发布、可回滚的版本；统一前后端导航和 API 契约。

## 覆盖发现

- ME-05：Agent UI 暴露不支持功能
- ME-06：MongoDB/Redis/Elasticsearch 声明支持但没有 adapter
- LO-01：导航 payload 和 i18n 字符串契约漂移
- TG-05：Dameng、DirectAdapter、RBAC UAT 未完成
- OPT-03：REST DTO 和导航事件重复定义
- STATE deferred：Phase 84/95/110 UAT

## 锁定决策

1. 每个数据库 adapter 声明版本范围和能力：connect、query、explain、metrics、health、alerts、reports、write/approval。状态来自 Phase 136 的 `declared/configured/verified/degraded/unsupported`。
2. 生产文档和 UI 只展示 verified 能力。MongoDB、Redis、Elasticsearch 在完整 adapter/UAT 前从创建契约移除或明确标记 unsupported。
3. MySQL、PostgreSQL、Oracle、Dameng 分别运行容器/受控环境矩阵；某一能力失败只降级该能力，不伪装整个 adapter 可用。
4. 配置采用 `draft -> validated -> published -> superseded/rolled_back`。发布记录 schema version、author、diff、validation result 和 effective_at。
5. 高风险配置发布创建 Operation 并受 Phase 132 Policy 管理；user preferences 等低风险个性化配置不进入发布流程。
6. 首批纳入告警规则、指标采集、Cron、报表配置和 Agent tool policy。每类配置提供 dry-run/preview 和回滚。
7. 后端以 TypeBox/OpenAPI 作为 REST DTO 事实源，生成或共享前端类型；导航使用类型化 route helper，禁止自由字符串 payload。
8. DirectAdapter capability 与前端功能面共用同一契约，空回调和“可点击但不可用”入口视为测试失败。

## 非目标

- 不在本 Phase 实现 MongoDB/Redis/Elasticsearch adapter。
- 不重写 Lit 路由框架。
- 不将所有 system_config 键一次性迁入版本化配置。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 138-01 | 1 | adapter 能力矩阵、支持声明、兼容性 fixture 和 deferred UAT 清账 |
| 138-02 | 2 | 配置版本/发布/回滚、OpenAPI/TypeBox DTO、类型化导航和能力驱动 UI |

## Phase 退出门禁

- 创建、编辑、UI 和文档中的支持数据库列表完全一致。
- 每个 verified adapter 有连接、查询、指标、健康、失败恢复测试证据。
- 配置可预检、发布、查看 diff、回滚；失败发布不改变 effective version。
- 前端 API 类型和导航 route 由共享契约检查，缺失控件不能静默 skip。
- Phase 84、95、110 的剩余 UAT 已执行并关闭或明确移出支持范围。
