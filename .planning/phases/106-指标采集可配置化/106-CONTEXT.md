# Phase 106: 指标采集可配置化 - Context

**Gathered:** 2026-05-22
**Status:** Ready for planning

## Phase Boundary

打通 metric_definitions（UI 可编辑）与 database-service（硬编码采集）之间的断裂。重构采集架构为统一 Collector + 可插拔 Provider 模式，支持用户自定义指标从定义到采集到告警的完整生命周期。

## Design Principles (from 202605212150-AI自我扩展架构解耦分析.md)

1. **数据驱动 > 代码硬编码。** 指标定义、采集逻辑、存储都应该是配置，不是写死的代码。
2. **注册模式 > 导入链。** Provider 通过文件系统扫描自注册，不需要在中心文件加 import。
3. **单一真相源。** 类型定义、API 契约只存在一个地方。
4. **约定优于配置。** 符合约定的组件自动被发现。

**核心目标：AI agent 能独立扩展一个新指标——从定义到采集到告警——而不需要同时改 4 个文件。**

## Implementation Decisions

### 采集架构
- **D-01:** 统一 Collector 接口 + 可插拔 Provider。每个 DB 类型一个 Provider 类，通过文件系统扫描 `collectors/` 目录自注册到 CollectorRegistry。
- **D-02:** CollectorRegistry 设计为通用 `Registry<T>` 抽象（register/enable/disable/list/get），作为 Phase 107 ViewRegistry 和 Phase 108 Plugin 模式的架构基础。
- **D-03:** 现有 4 个 `getXxxMetrics()` 方法重构为 Provider，趁机优化查询。行为保持兼容。
- **D-04:** 分阶段部署——先上线 Provider 架构确保现有采集稳定，再开放自定义 SQL。

### 存储模型
- **D-05:** `metrics_history` 加 JSON 列存储动态指标数据，与现有固定列双轨并行。现有仪表盘和告警不受影响。
- **D-06:** 指标值类型支持 gauge/counter/histogram。自定义 SQL 必须返回单行单列标量值。

### 数据驱动配置
- **D-07:** `metric_definitions` 表是完整的指标定义源——包含采集 SQL、db_types、值类型、分类标签、采集间隔。Provider 从定义表读取配置执行采集。
- **D-08:** 前端 metric-registry 表单使用字段配置数组（`FIELD_CONFIG`）声明式渲染，加新字段只需在数组中加一项（不改 HTML 模板）。完整 schema-driven（从 DB 自动生成表单）留给 Phase 107/109。
- **D-09:** 指标定义变更记录审计（created_by/updated_by + 版本历史）。

### AI 辅助扩展
- **D-10:** 前端「新建指标」表单内嵌「AI 生成采集 SQL」按钮 + Chat 界面自然语言描述，两个入口都支持。复用系统已配置的 LLM。
- **D-11:** Provider 提供 `describeSchema()` 方法为 AI agent 提供目标数据库表结构上下文。

### 安全边界
- **D-12:** 用户自定义 SQL 白名单校验（禁止 DROP/ALTER/INSERT/DELETE/UPDATE）+ 数据库只读账号执行。
- **D-13:** 单个指标 SQL 失败独立隔离，不影响其他指标。连续失败标记 stale 并支持 Provider 级 enable/disable 快速止损。

### 告警集成
- **D-14:** 告警规则保存时前后端双重验证 `metric_name` 必须存在于 `metric_definitions` 且 `is_collected=true`。引用无效/未采集指标阻止保存。
- **D-15:** 告警引擎自动合并固定列 + JSON 列取值，动态指标可正常参与告警评估和健康评分。

### 权限
- **D-16:** 新增 `metric:write` 权限控制自定义指标的创建/编辑/删除。
- **D-17:** 删除指标时检查告警规则引用，有引用则阻止删除并提示用户先处理。

### 范围限定
- **D-18:** 自定义指标不支持跨实例聚合（留给后续 phase）。
- **D-19:** 一个完整 phase（不拆分 sub-phase）。

## Canonical References

- `04-过程文档/202605212150-指标采集体系架构分析.md` — 架构断裂分析（定义层 vs 采集层）
- `04-过程文档/202605212150-AI自我扩展架构解耦分析.md` — 设计原则和反模式
- `apps/db-ops-api/src/metric-registry.ts` — 当前指标注册表
- `apps/db-ops-api/src/database-service.ts` — 当前硬编码采集器（getMySQLMetrics 等）
- `apps/db-ops-api/src/monitor-collector.ts` — 采集调度器
- `apps/db-ops-api/src/metric-database-service.ts` — metric_definitions 表 CRUD
- `apps/db-ops-api/sql/schema.sql` — metrics_history 表结构
- `frontend/src/openclaw/ui/views/metric-registry.ts` — 当前指标注册页面

## Existing Code Insights

- `monitor-collector.ts` 的 10 秒心跳 + 调度模式可复用
- `metric_definitions` 表已有 `interval_seconds` 字段（未被使用）
- Phase 105 的 `collection-capabilities.ts` 提供了采集状态追踪的基础
- Phase 105 的 `scoring-config-service.ts` 提供了 system_config CRUD 模式参考

## Deferred Ideas

- 跨实例聚合指标 → Phase 109（API 契约生成后可做）
- AI agent 自动发现数据库新指标 → Phase 108+（Plugin 模式成熟后）
- 指标市场/模板库 → 后续 milestone

---

*Phase: 106-指标采集可配置化*
*Context gathered: 2026-05-22*
