# MAX-64 契约实施计划 v1

> **Execution:** 在任务既有授权内执行；只交付契约，不部署、不合并 PR、不改变旧运行时。

**Goal:** 冻结可执行的 Metric Architecture V2 类型、schema、语义规则和三类资源样例。

**Architecture:** 复用后端 Zod 4；严格 schema 推导 TypeScript 类型并导出 JSON Schema，跨记录约束由独立纯函数验证。CollectorPackage 同时承载 Monitoring Template。旧 MetricRegistry 暂不导入新契约。

**Tech Stack:** TypeScript、Zod、Vitest、JSON Schema 2020-12。

## 基线与边界

基线 main `2995227f4416460612e3434cfdee1d93dd24b2a4`，包含 MAX-63 PR #74。沿用 `../v1/` 的语义决定，冻结版本 `1.0.0`，不把候选或旧历史原地改成正式版本。

范围：指标定义、属性、能力、观测、采集包/策略/绑定、派生、聚合、告警、CoreProfile 及 API 契约。
排除：调度、采集、存储、查询服务、UI、旧数据迁移、生产发布与已有缺陷修复。
硬预算未设定；token/费用遥测不可用；主代理 1，子代理 0，深度 0，并发峰值 1。
停止条件：契约与样例检查通过，提交 PR 待验收；只有 main 合并后才可作为下游已完成依赖。若实质产品歧义或外部权限阻塞，则保存已验证结果并说明最小输入。

## 设计选择

- 仅 TypeScript 接口无法校验线上 JSON；独立手写 JSON Schema 容易漂移。选择 Zod 单源，JSON Schema 负责结构，纯函数负责单位/身份/DAG/血缘/兼容等跨记录语义。
- 不新建独立模板实体，不接入现有 Registry，避免让契约冻结变成运行时迁移。
- unknown 保留显式质量及 null 值；失败记录在 Attempt。配置、Capability、freshness、production、accuracy 各有独立类型。

## 顺序与验收

1. `apps/db-ops-api/src/contracts/metrics-v2/definitions.ts`：定义单位、kind/role、维度、Canonical/Extension、资源、聚合和 profile schema；不可将版本/型号纳入指标身份。
2. `observations.ts`：定义原始/规范化观测、精确整数、分布、质量、时间、来源版本、counter 证据、Attempt 与 Capability。
3. `configuration.ts`：定义 CollectorDefinition/Package、策略、两层绑定、Derived DAG、AlertPolicy、计划与统一查询 DTO。
4. `validation.ts`：校验单位/语义冲突、精度/维度/时间、版本、唯一来源、DAG、聚合与质量传播。相同 ID 的不兼容语义拒绝，历史 unknown 不可升级 good。
5. `fixtures.ts`、`contracts.test.ts`：三类合成样例，覆盖已知单位和非法单位、超时仍 supported、精确 derived、estimated gauge、64 位上界、循环/重复来源、未知质量、语义/版本冲突、禁止 avg(p95) 与缺失补零。
6. `schema.ts`、`schemas.json`：导出 schema；测试比较提交的产物，防止漂移。`README.md` 冻结状态迁移、API、身份、版本、迁移和下游集成义务。
7. focused：`pnpm --filter slide-api exec vitest run src/contracts/metrics-v2/contracts.test.ts`；阶段：后端 typecheck；最终：后端全量测试、`pnpm contracts:check`、MAX-63 fixture verifier、`git diff --check`。未触达前端，不启动服务或访问真实资源。
8. 记录当前提交对应的结果；提交本项文件、推送并创建 MAX-64 PR；Issue 交付 in_review，不代替人工合并。

回退：撤回新增契约目录；不涉及运行时数据或配置。
