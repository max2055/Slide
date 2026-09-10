# Agent Evidence, Platform Self-Observation, and Historical Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有数据库、服务器和网络设备运维能力之上，建立面向 Agent 的可验证证据层、Slide 自身观测、源码/部署证据和历史故障可执行回放，使系统能可靠完成“信号—证据—假设—决策—行动—验证—学习”闭环。

**Architecture:** 保留现有 `ResourceRef`、专用资源表和 DirectAdapter，新增版本化 `EvidenceContract` 作为跨资源事实交换格式。GitLab 是源码权威来源，但由 Slide 同步服务按部署绑定的 immutable commit 拉取、扫描、签名并生成只读快照；Agent 不直接访问 GitLab，只能通过带权限、时间窗和资源边界的查询工具读取快照。运行时证据、业务不变量、预期模型、源码快照和部署清单都进入同一证据索引；历史 PR 被转换为隔离、确定性的 replay fixture，由独立验收器评估 detected/localized/contained/recovered，不把 LLM 输出直接当作通过条件。

**Tech Stack:** TypeScript, Fastify, MySQL, Lit 3.3, DirectAdapter WebSocket, Vitest, Playwright, JSON Schema/Ajv（沿用现有 schema validator），Git commit/digest，Docker 或本地 fixture runner。

---

## 1. 时机判断与增量边界

现在是合适时机，但应先做“证据与回放基础设施”而不是立即开放全自动修复。原因是资源模型、观测服务、诊断上下文、操作服务和安全策略已经存在；缺口集中在证据真实性、时间有效性、因果上下文、平台自观测和可重复验证。若直接做自动修复，无法区分“没有观测到”与“系统健康”，也无法证明动作确实恢复业务。

本计划是 `docs/superpowers/plans/2026-08-25-infrastructure-ops-master.md` 的增量阶段，不重建数据库/服务器/网络设备基础设施，不改变现有 API 的兼容行为。

## 1.1 导航与信息架构冻结方案

以当前 `frontend/src/app/ui/navigation.ts` 为基线，保留四个主分组，不增加“数据库中心”或独立“Agent 中心”：

```text
工作台：对话、总览
资源管理：数据库实例、服务器、网络设备
运维中心：告警与事件、跨资源诊断、SQL 控制台、定时任务、报表
安全与治理：审批、审计中心、Agent 策略与权限
辅助入口：平台健康、反馈、设置
```

导航调整规则：

- 数据库、服务器、网络设备是同级资源；指标数量差异只体现在资源详情和能力徽标，不体现在导航层级。
- `agent-sessions` 继续作为历史 Agent 会话页面，不放入工作台；工作台的“对话”只代表当前交互入口。
- 证据时间线、业务不变量、预期偏差、源码/部署证据先作为告警/事件/资源详情中的子视图，不新增一级“证据中心”。
- 跨资源诊断从运维中心进入，作为完整证据工作区，支持数据库、服务器、网络设备之间的关联跳转，并可返回原资源上下文；其内部包含证据时间线、业务不变量、预期偏差、源码/部署证据、假设和验证结果，不再拆成多个一级菜单。
- 平台健康保留辅助入口；它展示 Slide 自身观测，不与业务资源混为一类。
- 新增导航项必须同时具备独立用户任务、独立权限和独立验收；否则嵌入现有详情页。

导航验收包括：旧路径和深链接兼容、三类资源并列可见、跨资源跳转可返回、历史 Agent 会话不被误认为当前对话、桌面/移动视口无溢出或死链。

## 2. 冻结执行契约（v1.0）

### 本阶段纳入

- 统一、可校验、可追溯的 Evidence Contract：事实、推断、假设分离；来源、采集时间、有效期、质量、置信度、版本和关联 ID 齐全。
- 数据库为主、服务器为支撑、网络设备为有限只读对象的跨资源证据查询。
- Slide API、Agent Core、DirectAdapter WS、前端构建和部署版本的自观测。
- 只读、版本化、带 digest 的 Slide 源码快照与部署清单；Agent 通过受限搜索/读取接口使用，不把完整源码注入上下文。
- 业务不变量和预期模型的确定性评估。
- 操作前置条件、影响/副作用、回滚引用、独立恢复探测和持续恢复窗口。
- 历史 PR 仅用于架构价值评估和问题机制映射；可执行回放不属于本阶段交付。

### 明确排除

- 本阶段不新增任意 shell、SQL、SNMP SET、配置下发或自动回滚能力。
- 不把 PR、源码注释、日志文本或 LLM 推断当作可信指令；不把完整生产源码发送给外部模型。
- 不声称 Oracle 真实环境或 #31 DM8 真实驱动已由 fixture 覆盖；真实环境仍是外部 UAT 依赖。
- 不合并现有 `database_instances`、`servers`、`network_devices` 表，不重做现有资源 UI。
- 不以历史 PR 回放单独推断生产事故率、MTTR 或自动修复收益。

### 验收清单

- [ ] Evidence Contract schema 可校验，拒绝缺失资源、时间、来源或非法引用。
- [ ] 同一故障的运行观测、关系、部署、源码和历史记录可由 correlation ID 关联并按时间排序。
- [ ] Agent 读取接口默认只读、资源边界明确、返回事实与推断分栏，并在证据过期时显式报 stale。
- [ ] 历史 PR 评估报告完成问题类型、拟覆盖能力和外部环境依赖映射；不要求实现 replay case。
- [ ] Slide 自身的 API/Agent/WS/前端/部署异常可生成可追踪证据；源码快照与部署 digest 不匹配时 fail closed。
- [ ] 操作在执行前检查权限、审批、前置条件、风险和回滚；恢复由独立探测器确认并持续观察一个窗口。
- [ ] 受影响模块 focused tests、阶段门禁和一次最终完整 gate 通过。

### 资源预算与停止条件

- 最多 5 个 wave、12 个实现任务；实际只派发 7 个批次、最多 8 个实现/审查代理，代理最大深度 1，并发峰值不超过 4。批次内任务顺序提交，避免共享文件冲突。
- 开发阶段只运行 focused checks；每个 wave 结束运行受影响模块测试；代码冻结后只运行一次完整 gate。
- 预算达到 50% 时汇报已用资源、剩余范围和风险；达到 80% 后不扩展范围；达到 100% 保存检查点并停止新增工作。
- 证据引用越权、凭据/源码泄露、schema 绕过、未授权动作或恢复误判为 P0，立即停止功能扩展。
- 与既有计划无直接验收关系的测试失败、通用重构和文档润色进入 backlog。

## 3. 目标文件结构

### 新建

- `apps/db-ops-api/src/evidence/evidence-contract.ts`：领域类型、事实/推断/假设、质量和引用校验。
- `apps/db-ops-api/src/evidence/evidence-store.ts`：按 correlation/resource/time 查询和持久化证据的端口及 fixture 实现。
- `apps/db-ops-api/sql/migrations/084_agent_evidence.sql`：证据、决策和学习记录表，含 tenant/resource/time 索引、保留字段和迁移检查。
- `apps/db-ops-api/src/evidence/evidence-api.ts`：Fastify 只读证据查询路由和响应脱敏。
- `apps/db-ops-api/src/evidence/invariant-engine.ts`：业务不变量定义、评估结果和缺口状态。
- `apps/db-ops-api/src/evidence/expectation-engine.ts`：基线/分布偏差计算。
- `apps/db-ops-api/src/platform/platform-observation-service.ts`：API、Agent、WS、前端、部署自观测。
- `apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts`：运行日志结构化、脱敏、聚合并转换为 Evidence Contract；审计日志保持独立权限边界。
- `apps/db-ops-api/src/platform/source-snapshot-service.ts`：源码快照 manifest、digest、版本绑定和受限读取。
- `apps/db-ops-api/src/platform/gitlab-source-connector.ts`：GitLab 项目/commit 只读同步、短期凭据、路径白名单、secret/PII 扫描和快照签名。
- `apps/db-ops-api/src/operations/operation-verifier.ts`：前置条件、回滚和独立恢复窗口验证。
- `tests/replay/replay-contract.ts`：回放 case、注入器、观测提供器、独立验收器接口。
- `tests/replay/cases/R01/{pre-state.json,fault.ts,evidence.jsonl,policy.json,verifier.ts,expected-result.json}`、`R02/{pre-state.json,fault.ts,evidence.jsonl,policy.json,verifier.ts,expected-result.json}`、`R06/{pre-state.json,fault.ts,evidence.jsonl,policy.json,verifier.ts,expected-result.json}`、`R08/{pre-state.json,fault.ts,evidence.jsonl,policy.json,verifier.ts,expected-result.json}`、`R10/{pre-state.json,fault.ts,evidence.jsonl,policy.json,verifier.ts,expected-result.json}`、`R12/{pre-state.json,fault.ts,evidence.jsonl,policy.json,verifier.ts,expected-result.json}`：首批回放场景。
- `tests/replay/replay-runner.ts`、`tests/replay/replay-runner.test.ts`：后续阶段可选的回放工具，不在本阶段创建。
- `tests/qualification/assert-evidence-contract.ts`、`assert-platform-self-observation.ts`、`assert-replay-regression.ts`：资格门禁脚本。
- `docs/slide/evidence-contract.md`、`docs/slide/replay-catalog.md`、`docs/slide/source-evidence-security.md`：面向架构师和实施者的契约文档。

### 修改

- `apps/db-ops-api/src/resources/types.ts`：补充 evidence ID、source version、quality metadata 的兼容字段，并明确 `network_device`。
- `apps/db-ops-api/src/resources/observation-service.ts`、`resource-diagnostic-service.ts`、`instance-diagnostic-context-service.ts`：产出 Evidence Contract 并保留现有调用适配。
- `apps/db-ops-api/src/analysis/analysis-envelope.ts`、`ai-analysis-database-service.ts`、`fault-diagnosis-service.ts`：校验 evidenceRefs，区分 facts/inferences/hypotheses，并允许 `network_device`。
- `apps/db-ops-api/src/operations/operation-service.ts`、`adapter/agent-run-service.ts`、`security/agent-security-policy-service.ts`：接入操作验证和权限审计。
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/resource_tools.ts`：在现有资源工具上增量加入证据/源码查询，保持既有工具兼容。
- `apps/db-ops-api/src/adapter/get-agent-engine.ts`、`apps/db-ops-api/src/tools/catalog.ts`：在真实工具注册链路中加载新工具。
- `apps/db-ops-api/server.ts`：注册证据和平台观测路由，绑定 JWT、ActorContext 和租户过滤。
- `scripts/release/build-artifact.sh` 及 release workflow：生成、签名并校验 source manifest 和 releaseId。
- `deploy/source-snapshot-readonly.yaml`：以只读方式挂载已校验快照，禁止容器运行 Git 命令。
- `tests/qualification/coverage-matrix.ts`、`security-gate.ts`：加入证据和回放门禁索引。
- `frontend/src/app/ui/views/alerts.ts` 及相关诊断视图：显示证据时间线、质量、缺口和验证结果，复用现有共享组件。

## 4. 分阶段实施任务

### Wave 0：冻结契约与样本（无生产代码行为变化）

#### Task 0.1：建立 Evidence Contract

**Files:** 新建 `evidence-contract.ts`、`docs/slide/evidence-contract.md`；测试 `evidence-contract.test.ts`。

- [ ] 定义并导出以下类型：

```ts
type EvidenceKind = 'observation' | 'invariant' | 'expectation' | 'deployment' | 'source' | 'history';
type EpistemicStatus = 'fact' | 'inference' | 'hypothesis';
interface EvidenceItem {
  id: string; kind: EvidenceKind; status: EpistemicStatus;
  subject: { resource: ResourceRef } | { component: string };
  metricId?: string; value?: unknown;
  quality: 'good'|'degraded'|'invalid'|'unknown';
  observedAt: string; validUntil: string; source: string; sourceVersion?: string;
  confidence?: number; correlationId: string; provenance: string;
  supersedes?: string[]; redactions?: string[];
}
interface EvidenceBundle { id: string; correlationId: string; generatedAt: string; items: EvidenceItem[]; gaps: string[]; }
```

- [ ] 使用现有 TypeBox/Ajv validator 约束 ID、ISO 时间、置信度 `[0,1]`、资源类型和最大 payload；禁止未知敏感字段。
- [ ] 为缺失来源/subject、过期证据、越权资源和引用不存在的 evidence ID 写失败测试；排序固定为 `observedAt ASC, status(fact/inference/hypothesis) ASC, id ASC`，运行 `pnpm --filter slide-api exec vitest run src/evidence/evidence-contract.test.ts`，预期全部 PASS。

#### Task 0.2：定义回放契约和评分

**Files:** 新建 `tests/replay/replay-contract.ts`、`tests/replay/replay-runner.test.ts`、`docs/slide/replay-catalog.md`。

- [ ] 导出 `ReplayCase`、`ReplayContext`、`ReplayResult`；每个 case 必须包含 `preState`、`injectFault`、`visibleEvidence`、`allowedActions`、`forbiddenActions`、`independentVerifier`。
- [ ] 评分器固定输出 `detected`、`localized`、`contained`、`recovered`、`regressed`、`evidenceComplete` 和 `failureReasons`，并区分 deterministic 与 LLM-assisted 两种模式。
- [ ] 用一个最小假故障验证：没有独立验收证据时 `recovered=false`，运行 `pnpm --filter slide-api exec vitest run ../../tests/replay/replay-runner.test.ts`，预期 PASS。

### Wave 1：证据索引与 Agent 读取接口

#### Task 1.1：把现有观测适配为证据

**Files:** 修改 `resources/types.ts`、`observation-service.ts`、`resource-diagnostic-service.ts`、`instance-diagnostic-context-service.ts`；新建 `evidence-store.ts` 及测试、`apps/db-ops-api/sql/migrations/084_agent_evidence.sql`。

- [ ] 保持现有 `Observation` API，新增确定性 `evidenceId = sha256(correlationId + resourceKey + metricId + observedAt + source)`，记录 `validUntil` 和 `reason`。
- [ ] 实现 `EvidenceStore.put(bundle)`、`getById(id)`、`query({resource, correlationId, from, to, kinds})`，查询结果按 `observedAt` 升序、事实优先排序。
- [ ] 对不存在资源、跨租户资源和超出时间窗的查询返回结构化 gap，不返回猜测值；排序固定为 `observedAt ASC, status(fact/inference/hypothesis) ASC, id ASC`；运行 evidence store focused tests，并重启 fixture 验证迁移后的证据仍可读。

### 源码存放与分析方法（强制实现约束）

源码不在生产数据库中动态编辑，也不在每次请求时整体注入 Agent。来源分三类：

1. **权威来源**：GitLab 项目中的 immutable commit。平台配置 `gitlabProjectId`、`repositoryUrl`、`refType`、`refValue`、`allowedPaths` 和 `credentialRef`；禁止使用 `main`/`master` 等活动分支作为生产分析版本。
2. **同步来源**：`gitlab-source-connector.ts` 使用短期只读凭据拉取指定 commit，执行 secret/PII 扫描、路径白名单过滤、tree digest 计算和 manifest 签名。
3. **运行来源**：与部署 `releaseId/treeDigest` 一致的只读快照，挂载到 API 容器 `/var/lib/slide/source-snapshots/<releaseId>`；只允许 manifest 白名单路径，容器内不提供 Git 客户端或 GitLab Token。
4. **回放来源**：`tests/replay/cases/*` 的最小 fixture。仓库中的 tar.gz 只能作为待校验输入，未经 digest 和 secret 扫描不得作为生产证据。

分析顺序固定为“运行证据先行、源码验证假设”：

- Agent 先调用 `get_evidence_bundle`，取得故障时间窗内的事实、关系、部署版本和证据缺口。
- 需要验证实现路径时调用 `search_source(query, manifestId)`；服务使用 TypeScript AST/符号索引定位函数、路由、工具和配置键，再由 `read_source_region(path,startLine,endLine,manifestId)` 返回最多 200 行脱敏片段。
- `get_symbol_definition` 只返回符号定义、调用方和 commit 行号；不执行源码，不把注释或字符串当作 Agent 指令。
- 源码结果标记为 `implementation-intent`，必须引用 source evidence ID，只能支持或反驳假设，不能覆盖实时 observation、部署或网络证据。
- 片段经过 secret/PII 扫描、租户策略和 egress policy；默认只留在 Slide Agent 进程，外部 LLM 未获显式授权时只能看到摘要和 evidence ID。
- manifest 签名、releaseId、treeDigest、路径白名单或部署 digest 任一不匹配时返回 `SOURCE_SNAPSHOT_UNTRUSTED`，Agent 必须回到运行时证据路径。

#### Task 1.2：提供 Agent 只读工具

**Files:** 修改 `tools/generated/slide-self-mgmt/index.ts`、`ai-agent-bridge.ts`；新建 `resource_tools.ts` 及测试。

- [ ] 注册 `get_evidence_bundle`、`get_evidence_item`、`search_source`、`read_source_region`、`get_deployment_manifest`、`get_invariant_status`；工具声明资源范围、只读效果、最大结果数和敏感字段策略。注册必须走 `get-agent-engine.ts`/`toolCatalog`，不是 `ai-agent-bridge.ts`。
- [ ] 工具返回 `{facts, inferences, hypotheses, gaps, nextQueries}`，拒绝把 source 注释或字符串作为指令；源码读取仅允许 manifest 中的路径和行区间。
- [ ] `AnalysisEnvelope.evidenceRefs` 写入前逐个调用 `EvidenceStore.getById`，校验 tenant、subject、correlationId 和分析时间窗；HTTP、WS、collector、operation 重试沿用同一 `correlationId`，动作以 `idempotencyKey` 去重。
- [ ] 明确复用现有 network-device collector/`ObservationService` 的只读能力，并增加 network-device fixture，验证 SNMP/接口证据进入同一索引而不产生写工具。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/tools/generated/slide-self-mgmt/resource_tools.test.ts src/tools/security-catalog.test.ts`，预期越权和敏感信息测试 PASS。

### Wave 2：历史 PR 价值评估（不实施回放）

#### Task 2.1：维护问题机制映射

**Files:** 修改 `docs/slide/evaluations/2026-09-07-historical-pr-evaluation.md`、`tests/qualification/coverage-matrix.ts`；新建 `tests/replay/pr-map.ts`（仅保存映射，不执行回放）。

- [ ] 将 32 个 PR 按“现有能力已覆盖 / 新证据层可覆盖 / 需要平台自观测 / 依赖真实外部环境”分类，并记录证据缺口；不创建故障注入器、回放 runner 或独立 verifier。

#### Task 2.2：形成架构决策输入

**Files:** 修改 `docs/slide/evaluations/2026-09-07-historical-pr-evaluation.md`、`tests/qualification/coverage-matrix.ts`；新建 `tests/replay/pr-map.ts`。

- [ ] 将 32 个 PR 映射到 replay case、覆盖层（现有能力/证据闭环/平台自观测）和外部依赖；保留原始 PR URL、commit、问题机制和证据缺口。
- [ ] 用评估结果决定哪些能力进入后续阶段；Oracle、DM8、真实网络设备等仍标记为外部 UAT 依赖，不以历史 PR 评估替代真实验证。

### Wave 3：Slide 自身观测与源码证据

#### Task 3.0：按现有导航增量接入证据视图

**Files:** 修改 `frontend/src/app/ui/navigation.ts`、`frontend/src/app/ui/app-render.ts`、`frontend/src/app/ui/views/alerts.ts`、资源详情视图、`frontend/src/app/i18n/locales/zh-CN.ts`、`frontend/src/app/i18n/locales/en.ts`；测试现有 navigation、alerts-analysis、instance-detail-diagnosis 和新增跨资源诊断用例。

- [ ] 保留工作台、资源管理、运维中心、安全与治理四组；仅将告警/诊断入口补入运维中心，三类资源继续并列。
- [ ] `agent-sessions` 保持历史会话路由，不加入工作台；证据时间线、不变量、预期偏差和源码证据作为告警/事件/资源详情子视图。
- [ ] 用 `<app-card>`、`<app-data-table>`、`<app-badge>`、`<app-empty-state>` 和现有按钮 token 实现状态、证据缺口和跳转，不创建重复卡片/表格样式。
- [ ] 运行 `cd frontend && pnpm exec vitest run src/app/ui/navigation.test.ts src/app/ui/views/alerts-analysis.test.ts src/app/ui/views/instance-detail-diagnosis.test.ts`，并运行对应 Playwright 深链接用例。

#### Task 3.1：平台自观测

**Files:** 新建 `platform-observation-service.ts`、`structured-log-evidence-adapter.ts` 及测试；修改 `apps/db-ops-api/server.ts`、health routes、`agent-run-service.ts`、DirectAdapter WS 适配、现有结构化日志入口、`frontend/vite.config.*`、前端诊断视图。

- [ ] 暴露 API latency/error、Agent run 状态、WS reconnect/duplicate、采集器/队列/外部依赖状态、由 `VITE_SLIDE_RELEASE_ID` 注入的前端 build/version、数据库 migration/schema version 和部署 digest，并在 `server.ts` 注册 `/api/platform/observations`。
- [ ] 将 API、Agent、WS、采集任务、队列和外部依赖的运行日志转换为结构化日志证据；每条至少包含 `timestamp`、`level`、`component`、`eventType`、`correlationId`、`traceId`、`releaseId`、`status`、`durationMs` 和 `errorCode`。
- [ ] 运行日志与登录、权限、审批、工具调用、源码读取和操作结果等审计日志分开存储、分开授权；凭据、Token、SQL 参数和个人信息先脱敏，Agent 只能按租户、组件和时间窗查询聚合结果，不读取无限量原始日志。
- [ ] 日志采集失败输出 `unknown`/evidence gap；验证日志 freshness、保留期限、数量上限和敏感字段扫描，运行 `structured-log-evidence-adapter.test.ts` 与安全测试。
- [ ] 每条平台观测带 component、version、releaseId、observedAt、validUntil、quality；探针失败输出 `unknown`/gap，不输出 healthy。
- [ ] 运行 `pnpm --filter slide-api exec vitest run src/platform/platform-observation-service.test.ts src/health-routes.test.ts`，并用 Playwright 验证 UI 显示 stale/unknown。

#### Task 3.2：源码快照和部署清单

**Files:** 新建 `source-snapshot-service.ts` 及测试、`docs/slide/source-evidence-security.md`；修改 `scripts/release/build-artifact.sh`、release workflow、部署清单和健康路由。

- [ ] 构建阶段生成并签名 `source-manifest.json`：`commitSha`、`treeDigest`、文件路径白名单、生成时间、部署 `releaseId`；CI 执行 secret/PII 扫描，运行时只读挂载匹配 digest 的源码快照。
- [ ] GitLab connector 只接受 commit SHA 或不可变 tag，使用短期只读凭据；同步失败、扫描命中或 commit 与部署 manifest 不一致时不生成可用快照，并写入结构化 gap。
- [ ] 实现 `searchSource(query, manifestId)`、`readSourceRegion(path,startLine,endLine,manifestId)`、`getDeploymentManifest(releaseId)`；拒绝路径穿越、未白名单路径、超行数和 digest 不匹配。
- [ ] 源码内容进入 `EvidenceItem(kind='source', status='fact')`，并标注“实现意图证据”，不能覆盖运行时事实；单次最多返回 200 行脱敏片段，默认禁止向外部 LLM egress，只有租户策略显式允许才可转发；运行 source snapshot security tests。

### Wave 4：不变量、预期、操作验证与学习记录

#### Task 4.1：业务不变量和预期模型

**Files:** 新建 `invariant-engine.ts`、`expectation-engine.ts` 及测试；修改 `fault-diagnosis-service.ts`。

- [ ] 支持数据库主从延迟阈值、采集 freshness、凭据与资源绑定、网络接口错误率等确定性规则；结果为 `pass/fail/unknown`，unknown 不降级为 pass。
- [ ] 基于现有 baseline/calculator 输出窗口、样本数、偏差方向和阈值版本；小样本时返回 insufficient-data gap。
- [ ] 诊断 envelope 只引用已存证据 ID，并在事实、推断、假设三栏返回；运行不变量和诊断 focused tests。

#### Task 4.2：操作前置条件和独立恢复验证

**Files:** 新建 `operation-verifier.ts` 及测试；修改 `operation-service.ts`、`security/agent-security-policy-service.ts`、`adapter/agent-run-service.ts`。

- [ ] 定义 `OperationPlan`：target、effect、requiredCapability、approvalId、`correlationId`、`idempotencyKey`、preconditions、rollbackRef、risk、costEstimate、verificationPlan；只门控现有操作能力，不新增写操作。
- [ ] 执行前验证资源边界、权限、审批未过期且未复用、前置不变量和成本上限；任何失败返回拒绝证据，不执行动作。
- [ ] 执行后由独立探测器在 `verificationPlan.windowSeconds` 内连续确认目标指标恢复；记录 `verifiedBy`、采样证据和回滚建议。
- [ ] 运行操作安全测试和 R01/R06/R10 replay，预期未授权、重复和未恢复动作均 fail closed。

#### Task 4.3：决策和经验沉淀

**Files:** 新建 `decision-record-service.ts`、`learning-record-service.ts` 及测试；修改 `feedback-service.ts`。

- [ ] 通过 `084_agent_evidence.sql` 的 decision/learning 表持久化输入证据 ID、假设、选择动作、被拒绝动作、结果、人工反馈和版本，带 tenant、retention_until 和唯一 `correlationId`；事实与 Agent 推断分开存储。
- [ ] 仅从已验证恢复的 replay/生产事件生成可复用故障模式，带适用资源类型、置信度和失效时间；未经验证的经验不可进入自动策略。

## 5. 回放案例契约

如果后续决定建设回放，每个回放（例如 `tests/replay/cases/R01/`）必须具备如下目录结构并可独立运行；本阶段只记录该契约，不实现这些文件：

```text
case/
  pre-state.json          # 故障前资源、关系、版本和基线
  fault.ts                # 可逆故障注入器
  evidence.jsonl          # Agent 可见证据，含故障前后时间线
  policy.json             # allowedActions / forbiddenActions
  verifier.ts             # 与 Agent 分离的验收器
  expected-result.json    # 结果字段和失败原因
```

回放生命周期固定为：加载 pre-state → 注入故障 → 采集证据 → Agent 查询/提出动作 → 策略拦截 →（若允许）执行 → 独立验证 → 写入决策记录。`recovered` 只有在独立验证窗口内满足规则才为 true；`evidenceComplete=false` 时不得自动修复。

历史 PR 作为“故障机制回归集”是合理的，因为它能验证过去真实缺陷是否被新契约暴露和拦截；但它不是生产效果证明。正式评估还需故障注入、留出 PR 集、独立恢复验证、重复运行稳定性和旧/新架构 A/B 对照。

## 6. 分层验证与最终 gate

### 开发 focused checks

```bash
pnpm --filter slide-api exec vitest run src/evidence src/platform src/operations/operation-verifier.test.ts
pnpm --filter slide-api typecheck
```

### Wave 边界 checks

```bash
pnpm --filter slide-api test
pnpm --filter slide-api schema:check
pnpm --filter slide-api exec tsx ../../tests/qualification/assert-evidence-contract.ts
```

### 最终完整 gate（代码冻结后仅运行一次）

```bash
pnpm --filter slide-api test:all
pnpm --filter slide-api typecheck
pnpm --filter slide-api exec tsx ../../tests/qualification/assert-platform-self-observation.ts
pnpm security:test
pnpm security:scan
pnpm --filter slide-frontend test
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
cd frontend && pnpm smoke --grep R12
cd .. && pnpm contracts:check
```

最终产物：`docs/slide/evaluations/<date>-evidence-replay-report.md`、六个 replay JSON 报告、schema 校验日志、security gate 日志和部署/source manifest。只有全部 gate 通过，才进入下一阶段“受控自动修复”评审；本计划完成时不自动开启写操作。

## 7. 执行交接

计划完成后可选择：

1. **Subagent-Driven（推荐）**：按任务派发新代理，每个任务完成后做两阶段审查。
2. **Inline Execution**：在当前会话使用 executing-plans 分批执行，并在每个 wave 设置检查点。

执行前不得改写本冻结契约；若需扩大范围，必须记录旧范围、原因和累计资源用量。

