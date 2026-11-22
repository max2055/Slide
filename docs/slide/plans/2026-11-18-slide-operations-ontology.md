# Slide Operations Ontology 建设方案

**评审建议：做一个事件证据交接试点，不立项建设独立 Ontology 平台。** 先让值班 DBA 从一个 MySQL 模板事件回答：“当时是哪台实例、哪条规则、哪次采样触发的？同窗的哪些观测只是背景？”答案要能带进现有 AI 工作台，不能因为换了页面、改了模板或重新提问而换了对象。若现有页面已能同样快且准确地回答，就停止建设。

| 负责人需要决定 | 建议 |
|---|---|
| 现在批准什么 | 先批准基线测量；若确有交接损失，再批准一个只读视图和一个就近入口。复用既有草案保存，不默认启动模型。 |
| 现在不批准什么 | 不建全局对象目录、知识图谱服务、数据副本、DSL、事件总线或新菜单；不把数据库故障归因于同主机，不新增写工具、审批或自动恢复。 |
| 主要风险 | 把“同一窗口”误作“参与判定”；把历史证据当成当前健康；把能看资源误作能看事件或调查。任何一项出错，宁可只呈现原页面。 |
| 怎样决定追加投入 | 用同一组问题、同一权限和同一批事件比较现状、仅改导航、再加证据匹配三种方式。安全与引用准确性是硬门，减少步骤或耗时才是收益。门槛见 §7。 |

## 1. 调研基线与证据边界

- **检查日期：2026-11-18；交付前于 2026-11-19 00:03（Asia/Shanghai）复核远端，提交未变。** 调研开始时，本地工作树 `main` 为 `92aa557b887729e19ce2aa4a9e8a957d4e2935ac`，本地缓存的 `origin/main` 为 `451ab8c9969f18d94f17392a74301294de82b5e1`，两者都不是分析基线。以 `git ls-remote` 核对远端 `refs/heads/main`，在隔离目录读取 [主线快照 `0f95335499d97dbfada5995f5804fce0d4b70be6`](https://github.com/max2055/Slide/tree/0f95335499d97dbfada5995f5804fce0d4b70be6)（11 月 18 日 17:04:07 +0800 合并 #1010）。下文路径和符号均指该提交，不指未合并分支、也不等于某套部署的运行版本。
- 遵守根 `AGENTS.md`、`frontend/AGENTS.md`、[当前产品范围](https://github.com/max2055/Slide/blob/0f95335499d97dbfada5995f5804fce0d4b70be6/docs/slide/requirements/current-version-scope.md)及 `docs/slide/development/quality-gates.md`。入口仅为现有事件中心和 `/workbench` 调查页签；行动计划沿用同工作台。桌面中文浅色，采集仍为无目标侧 Agent 的已注册能力。
- **证据记号：** **C**＝该提交可追到实现和调用；**T**＝有具名测试及相应断言，不表示今日跑过；**R**＝仓库保存的指定旧候选/真实环境验证记录，注明范围；**D**＝规划、Issue 或范围决定；**P**＝本文推断、待测假设或提议。本次只读源码、历史报告和公开方法；没有连接业务库、启停服务、执行采集、调用模型、发送通知、执行动作或重跑测试。未得到生产样本、用户耗时或新链路实测。

**几个容易把方案做大的误读：**

1. `docs/slide/ARCHITECTURE.md` 总图仍写 OpenClaw Gateway，并列多种数据层。当前 `apps/db-ops-api/src/adapter/direct-adapter.ts`、`packages/agent-core` 和根规则对应内置运行时、自管 WebSocket；平台业务持久化以 MySQL 为主，Session/Checkpoint 另有文件路径。不能由依赖清单推出“须在外部 Gateway 上部署图服务”。
2. `docs/slide/development/MAX-239/opening-evidence.md` 是纯迁移函数阶段的“未挂载”记录；现在 `metrics/triggers/runtime.ts → alertEventService.persistTemplateTransition → metrics/triggers/routes.ts` 有实际写读链。相反，数据库真实只读采集的验收**也不能**证明新证据交接已实现或生产默认开启。
3. T10 计划提出告警进入调查；V2/V3 计划提出关系、行动、验证。下表按代码逐项确认，不按计划批量认定。GitHub [#581](https://github.com/max2055/Slide/issues/581) 本次回读仍为 OPEN，但 `frontend/src/app/ui/workbench-routing.ts#canonicalWorkspaceUrl` 已将旧调查/行动入口导向 `/workbench`，旧 `/attention` 导向 `/events?view=aggregate&eventList=active`。**Issue 开着不等于入口没实现；入口合并不等于整单验收通过。**

**评审者可先核对的四处代码：** [事件/告警/episode 如何同事务创建，opening 究竟写了什么](https://github.com/max2055/Slide/blob/0f95335499d97dbfada5995f5804fce0d4b70be6/apps/db-ops-api/src/alert-event-service.ts#L31-L84) → [事件草案按钮为什么丢失指标与维度](https://github.com/max2055/Slide/blob/0f95335499d97dbfada5995f5804fce0d4b70be6/frontend/src/app/ui/components/semantic-metrics.ts#L506) → [现有入口验证了哪些关联，实际返回哪些 facts](https://github.com/max2055/Slide/blob/0f95335499d97dbfada5995f5804fce0d4b70be6/apps/db-ops-api/src/investigations/entry-routes.ts#L18-L77) → [后续复测如何按原规则和维度读取，何时拒绝判断恢复](https://github.com/max2055/Slide/blob/0f95335499d97dbfada5995f5804fce0d4b70be6/apps/db-ops-api/src/investigations/workflow.ts#L124-L158)。第三处是首期应扩展的位置，第四处是应复用而不应重写的能力。

### 1.1 现状与差距表

为便于核查，表内 **S** 表示 `apps/db-ops-api/src/`，**U** 表示 `frontend/src/app/ui/`；文件名后的符号可在上述固定快照中查找。最后一列指业务事实所有者，而非建议再建的表。

| 能力 | 当前实现与证据 | 真实缺口 | 可复用部分 | 建议变化 | 权威数据来源 |
|---|---|---|---|---|---|
| 资源身份与名称 | **C** `S/resources/{types,resource-subject}.ts`：`ResourceRef`、`resourceKey` 是 type + 正整数 id；`S/tools/resource-resolver.ts#resolveToolResource` 对实例配置更新有归一化名称、可写范围及歧义处理。`S/resources/identity-read-access.ts` 在返回前再验权。**T** `tools/resource-resolver.test.ts`。 | 暴露形式有 `instance_id`、`resourceId`、字符串形式的指标资源 ID 等；实例写工具的名称规则不是三类资产通用解析器。 | 已授权资产选择、类型化主键、原资源 ACL | 只在边界做严格、无损转换；不造全局 UUID 或按 IP 合并资产。 | `database_instances`、`servers`、`network_devices`；名称、地址仅属性。 |
| 资源拓扑、影响 | **C** `S/resources/instance-host-service.ts` 维护实例宿主映射；`S/operations/relations/{store,service}.ts` 将旧 `hosts` 反向投影为 `runs_on`，v0 为 suggested/unverified。`RelationService.graph` 默认只读事实、最多 2 跳/100 边，按两端授权、证据和当前有效期过滤。`attention/correlator.ts` 明示 `correlationIsCausation:false`、`impactStatus:'unknown'`。**T** `operations/relations/store.test.ts`。 | 当前时间的可见边不等于故障时刻的依赖；边缺失或只给部分图均不能算“无影响”。现场已确认覆盖率未知。 | 两端授权、证据引用、版本、失效和有限遍历 | 首期不取拓扑、不增加边；第二场景仅作后续候选。 | `resource_relations` 和 `resource_relation_revisions`，端点主档仍归资源模块。 |
| 采集与指标语义 | **C** `S/metrics/{packages/builtins,database/collector,scheduler/store,observation}.ts`：已注册采集/定义、`writeTemplateResults`、归一化；`contracts/metrics/{definitions,observations}.ts` 定义版本、维度、单位、质量、来源。模板选择不等于采集已成功。**T/R** 见下述 MAX-239。 | `last` 的判定值、历史桶、正规化样本和采集尝试不是同一种对象；仅有数值不说明具体输入。 | 包/模板/配置版本、观测 ID、attempt、质量及现有采样机制 | 复用正式序列；不创建新指标名、不复制 collector 或生成“Ontology 指标”。 | 有效配置/固定模板及 capability registry；观测值以被正式接纳的 publication 为准。 |
| 时序和历史窗口 | **C** `S/metrics/rollout/formal-store.ts#historySelection` 联结 publication、观测、代次/修订接纳，拒绝影子样本；`MetricConsumerService.observations` 以精确序列读 `[from,to)`，返回总数、页、来源及游标；`consumers/history-query.ts#aggregateHistory` 不把跨修订桶混成一个值。**T** `metrics/rollout/observation-page.mysql.test.ts`。 | “窗口里存在”并不表示“被该次触发引用”；当前配置变更、保留期、截页可造成同窗读与快照不同。 | `/api/metrics/observations`、历史 `query`、原 ID 和采样策略 | 与冻结的 opening 成员做有界核对，不再开发时序引擎。 | `metric_publications` × `metric_observations`，以及 `metric_rollout` / `metric_source_acceptance`。 |
| 事件与触发证据 | **C** `S/metrics/triggers/runtime.ts#evaluateTemplateSamples` → `S/alert-event-service.ts#persistTemplateTransition` 同事务写 `event_id`、`alert_id`、episode、配置快照和 `opening`；恢复写 `trigger_recovered` 日志。`U/components/template-event-evidence.ts` 已展示发生值、源样本/尝试、旧规则、未知段，另链当前资源配置。**T** `metrics/templates/trigger-flow.mysql.test.ts`。 | `alerts.id`、事件 API 数字 id、`alert_events.event_id` 的 UUID、`episode_id` 不能互换。发生时证据已有，缺的是与草案读数的明确绑定。 | `GET /api/metrics/template-events/:eventId`、事件/日志读及原快照 | 只投影所选 episode 的 opening，不另写事件，不把“最新值”当发生值。 | `alert_events.id`（事件路由键）、`alerts.id`、`metric_trigger_episodes.{payload,snapshot}`、`alert_event_logs`。 |
| 调查、证据与结论 | **C** `S/investigations/entry-{contracts,routes}.ts` 已有 typed context、预览、幂等草案、回读；`checkEntryEvents` 查资源/事件可见性；有 metric 读正式原始明细（最多 200 条/页），否则读 core 历史。`evidence-store.ts` 把证据绑定 investigation/request/run，脱敏、有到期；`result-schema.ts#authorizedBindings` 拒绝跨绑定引用，结果有版本。另有 `S/evidence/evidence-contract.ts` 内容哈希标识的资源 EvidenceItem（fact/inference/hypothesis）。**T** `investigations/{entry-races.mysql,result-schema}.test.ts`。 | 入口验证同一资源，不等于验证事件规则与所选序列/窗口相符；入口预览不是某 Run 的证据，资源证据哈希也不是调查证据 UUID。 | 原调查会话、入口上下文、证据库、结果校验与到期策略 | **只增加证据来源对照**；不合并两套证据 ID，不在打开页面时生成 Run 或结果。 | `investigation_create_keys` 的原始上下文、`investigations`、`investigation_evidence`、`investigation_results` 各管自己的事实。 |
| 行动、审批、执行、核验与审计 | **C** `S/operations/actions/{plan-service,approval-binding,executor,verification-service}.ts`：不可变内容版本/hash、独立审批人、once 授权、派发前再核对、未知回执核对、另行观察验证；`operations/contracts.ts` 有独立枚举。`S/investigations/workflow.ts#retest` 已按原事件快照复测；`alert-event-service.ts#verifyRecovery` 是人工确认。**T** `operations/actions/{plan-service,execution,verification}.mysql.test.ts`。 | 同一句“已恢复”可能指规则恢复、人工确认、调查复测或行动效果；批准和执行成功都不是其证据。 | 原审批队列、版本、执行回执、验证报告、事件日志与调查记录 | 只标所有者及时间；不建统一状态或新执行器，不为数据库生成重启按钮。 | 原计划版本、审批绑定、执行 intent/receipt、验证报告分别归行动模块；事件状态/审计归事件模块。 |
| 权限、工具与前端 | **C** `S/investigations/{authorization,tool-contract,profiles}.ts`、`S/tools/{policy,security-catalog}.ts`：工具受 profile、实时 actor、资源范围和预算约束；`S/tools/ops/query_metrics.ts` 支持发现、历史与来源。工作台分别守调查与行动权限。`U/components/semantic-metrics.ts#investigationHref` 的事件按钮传 eventId **不传 metric/series**，序列按钮传 metric/dimensions **不传 eventId**。**T** `frontend/e2e/investigation-resource-links.spec.ts`、`U/views/workbench.test.ts`。 | 两条入口各保留一半；人能手工拼回，模型拿到普通窗口也不能声称知道具体触发输入。权限过滤后的缺项又不能解释成该对象不存在。 | 同一工作台、草案预览、权限变动清屏、原工具审计和来源上限 | 合并上下文，不合并授权；首期不扩普通聊天权限。 | 实时 actor/资源 scope、调查所属与 profile、各源 ACL；URL、模型和 UI 不授权。 |

**真实验证到哪里为止。** [MAX-239 实际 collector 记录](https://github.com/max2055/Slide/blob/0f95335499d97dbfada5995f5804fce0d4b70be6/docs/slide/development/MAX-239/real-collector-20261031.md)记录在隔离平台库通过真实 MySQL 只读采集，运行时长由 **251435 s** 到 **251452 s**，跨过试验阈值 **251449 s**，事件恢复一次；有 JWT、共用 Fastify 读路由及 Lit 验证，不是生产现场故障。该日记录写 VM 不通，不能当作现在仍不通：[最终矩阵](https://github.com/max2055/Slide/blob/0f95335499d97dbfada5995f5804fce0d4b70be6/docs/slide/development/MAX-239/final-acceptance-matrix.md)后续列出 MySQL 和 VM 的 source/episode，以及受控 UDP SNMP（非厂商硬件）。`docs/slide/ai-native-operations/v23-data-readiness.md` 区分受控执行证据与真实业务质量 unknown。**本方案不把旧链路成功数、合成案例或规则自然越线换算为诊断准确率和节省工时。**

## 2. 从三个运维判断确定边界

| 场景与用户问题 | 现在怎么做；困难的性质 | 能改善哪一步；怎么观察 |
|---|---|---|
| **① 首期：DBA 接班复核一个 MySQL 模板事件。** “这次低运行时长是哪个样本触发？同窗还有什么？请带原证据进调查。” | 事件中心 → 聚合事件详情看冻结快照；资源详情 → 指标历史 → 事件链接或序列链接 → 工作台预览。活动告警另有 `POST /api/alerts/:id/investigation`。`semantic-metrics.ts` 两个调用点和 `entry-routes.ts` 两种查询分支展示了交接损失。主因是**证据成员、上下文和交互**，不是没有时序、调查或查询接口。未测手工频次。 | 事件旁打开带 **event + resource + metric@version + dimensions + 绝对窗** 的同一草案视图，分别列出冻结命中与同窗背景。测正确定位率、定位用时、手输次数；用“仅补链接”作强对照。 |
| **② 值班长判断能否结案。** “规则恢复了，是不是业务恢复、可以关闭？” | 事件详情已有 episode、人工确认及关闭；调查 `workflow.ts#retest` 取原规则和后续窗，受样本数量、质量、范围和版本约束；行动工作台另读执行/验证报告。有能力，困难主要是**状态语义与证据适用范围**，还可能确实缺观察窗。 | 首期只在回答中区分“当时触发”和“当前恢复未评估”。后续若经常误判，先改现有标签与复测跳转；测将 ack/执行成功误报为恢复的比例。不新建恢复算法。 |
| **③ 平台 SRE 排查宿主故障影响。** “哪几台库可能受影响？” | 资源详情的宿主映射、`get_resource_relations`、受控 `GET /api/operations/resources/:type/:id/relations` 及关注事项关联可供核查；人工扩调查范围走 `workflow.ts` 的版本化关系。瓶颈可能是**历史关系或业务依赖根本没采到**，而非跳数不够。 | 需要现场确认某时刻宿主/集群成员、故障及对照样本。将来统计确认边覆盖率、漏列和错列；候选单列。现阶段不承诺爆炸半径、因果或完整受影响数。 |

选择①，因为同一事务已经留下事件、对象和样本身份，有可独立裁判的答案，且不用对生产做任何处置。②已有专用复测；③缺标注时即使换图数据库也不能创造事实。

**为什么不直接用已有告警 RCA 作首期入口？** `S/alert-rca-service.ts#analyzeAlert → S/investigations/alert-bridge.ts#dispatch` 可以走新调查，也会按配置或既有 owner 走旧分析；`S/investigations/resource-event-bridge.ts#alertObservation` 从告警 tags 取观测时间、窗口、质量，缺失时保持未知。模板 writer 给告警写的是 episode、配置修订、事件定位等 tags；真正的 opening 样本清单在 episode 快照，不在那些 tags 里。这是两个模块各自正确却不能互相代替的实例。为一个无需模型的取证问题启动 RCA，既不保证拿到快照，还改变了任务、预算和审计语义。

## 3. 路径选择：在哪里统一，而不是统一多少表

Palantir 的[官方概念](https://www.palantir.com/docs/foundry/ontology/core-concepts)、[对象身份](https://www.palantir.com/docs/foundry/functions/object-identifiers)、[Action types](https://www.palantir.com/docs/foundry/action-types/overview) 和[对象/关系权限](https://www.palantir.com/docs/foundry/object-permissioning/overview)分别讲对象及连接、类型与主键、成组业务修改、模式与实例访问。**公开方法**是用业务对象和关系连接数据与操作。**本文理解**是“引用同一事实”和“有权改变它”应分开。**Slide 的选择**是借这些约束，不复制 Foundry 的后端、对象集服务或权限系统；外部 SSH 操作尤其不是本地数据库事务。

| 比较维度 | A：在原模块完善契约和入口（推荐） | B：独立于领域接口的统一语义访问层（先不做） |
|---|---|---|
| 首期帮助 | 用已有入口直接传全五元上下文；只需在事件/调查边界辨别命中和背景。 | 可统一为对象/边查询，但同样要编写该适配和授权；第一条问题并未减少一次权威读取。 |
| 与现有重合 | 使用已有身份、时序、事件、证据、草案、复测；增加一个窄的、可单测的只读投影。 | 再定义对象 ID、链接、查询、字段裁剪、订阅或写入，容易与 `ResourceRef`、`RelationService`、调查 store 及行动状态重叠。 |
| 开发、维护、迁移 | Lit 入口、Fastify 契约、回归；无 DDL、无回填；字段随领域所有者升级。 | 至少维护各域适配器、统一错误和权限矩阵；若物化还要同步、删改传播、修复与追赶历史版本。 |
| 权限、一致性 | 来源权限取交集；同事务冻结的 opening 与稍后可变的保留状况分别标时，可在发送前复核。 | 读穿多源或缓存都需逐端逐字段按实时授权、时间和来源裁剪；聚合计数与边也可能泄露。不能靠 ACL 缓存取代。 |
| 扩展、回退 | 可重复使用已证实的契约；关闭入口/附加投影即可，原草案继续可读。代价是多个场景若独立长大可能重复。 | 多域、多消费者都稳定后可摊薄映射成本；全面切换后要保双读、版本、缓存清理和旧接口，回退较重。 |

**改变推荐的证据：** 至少两个相互独立的业务流程、两个消费者反复实现同一组身份/来源/授权适配，并有实际维护或权限漂移记录时，先提取**进程内只读语义接口**。只有真实历史多跳问题、有带时间戳的权威关系、MySQL 有界查询及索引经同数据压测仍不达业务 SLO，才比较图索引；要求可重建、读延迟和撤权验证，权威事实仍不移交。独立服务还须证明不同部署/伸缩或故障隔离的必要性；通用查询语言须有多个固定查询无法覆盖的授权需求及成本上界。相反，若仅传完整入口即可达标，连下述证据投影也不扩大。

## 4. 首期模型与读契约

**这里的 Operations Ontology 是一份可执行的业务语义契约：** 对每个声明说明“说的是谁、哪一刻、哪个来源、它最多证明什么、谁可看/改”。不是一张新表。首期只支持一台已纳管 MySQL、一个模板 episode、一条有标量样本的简单 `last` 问题规则（恢复也为简单 `last`）、一个已定义维度集合。无数据触发、复合规则、聚合跨窗以及非模板事件保留原详情；不能假装它们有唯一命中样本。

### 4.1 身份、关系和事实所有权

| 业务引用（非新实体表） | 来源、关联方式 | 能回答／不能回答 |
|---|---|---|
| 资源 `instance:42` | 同一 Slide 部署内 `{type,id}`；指标域的 `"42"` 仅经正整数、范围、规范十进制及类型检查转为 `42`。换类型、删除重建、重新注册均不得用同名/同 IP 自动延续。迁出到别的平台须带部署命名空间，首期不做跨平台合并。 | 稳定定位记录；标签、IP、端口、外部资产号是查找线索而非主键。仅给名称时显示已授权候选让人选择；不可唯一确认不启动。隐藏候选的存在、数量均不提示。 |
| 模板事件 → episode → 唯一资源、告警、规则 | 只信 `metric_trigger_episodes` 里的 event/alert 键及资源，与 payload、冻结 configuration、`episode.rule_id/scope/version/body_hash`、`config_revision` 交叉核对；用 `verifyTriggerSnapshot` 校验。`event.id` 不是 `alert.id`。 | **记录事实**，在该次 occurrence 有效；配置再发布、episode 关闭不会令新阈值追溯生效。记录残缺或冲突标记不可核，不补造关联。 |
| 规则 opening → 样本／采集尝试 | `snapshot.opening.sample_ids/samples/attempt_ids`（以及 `unit/dimensions`）是冻结的输入引用；`metric_trigger_inputs.sample_id` 由正式观测 `o.id` 写入。`episode.opened.at` 是判定时间。窗口内正式观测是另一集合。 | 有界、精确 ID 匹配，且序列、修订、单位、时间和值相符，才记“已回查”。冻结列表没引用的样本只能记“同窗背景”。不以值/时间相近猜 ID，不把整个窗口算成命中。 |
| 调查草案 → 来源事件／窗口；Run → 证据 → 结果版本 | 原 `InvestigationEntryContext` 存在现有草案上下文；`sourceEventIds` 是回查线索，并非授权或命中证明。真实执行产生 `investigation_evidence.id`，结果只能引用本次 investigation/request/run 下已授权、未过期的证据。 | 草案、快照输入、调查证据、结果四者不可互换。事后重读取回的是“当前仍能回读的旧窗”，不伪装成在事故现场冻结的一整页。 |
| 可选拓扑边（**非首期输入**） | `runs_on` 规范方向是实例 → 服务器；其逆向展示不是第二条事实。`origin` 与 `state` 分开；经关系服务按 `expectedVersion` 修订或确认，证据有版本/hash，两端均须可读。区间 `[validFrom,validUntil)`，源撤回、到期、冲突、删除均不得继续用作确认事实。 | collector/model 提示、legacy v0 或同 IP 都不是已验证部署关系。以后追溯要证明边在故障窗内有效且证据可用；窗中换宿主则分段，否则未知。今日 `graph()` 不是历史 as-of 接口。 |

**仅建议新增两样：** (1) 事件详情到既有草案的上下文组装，解决换页面丢失限定条件；(2) 若导航对照不足，给既有事实响应加可选的 `triggerEvidence`，说明每条引用是冻结命中、已回查还是普通背景。两者都是投影。**新持久化为零**；预览不写，用户点“保存调查草案”才复用既有调查及幂等记录。没有新关系写入者、证据仓库、权限库或指标字典。

### 4.2 窗口、质量与不确定性

- 内部统一 UTC 毫秒、`[from,to)`，展示时标时区。建议只为**查看背景**默认打开判定前 5 分钟，通常 `from=opened.at−5min`、`to=opened.at+1ms`，使恰在判定时刻的样本可见；不能取未来的 `to`，边界未到时可稍后重读。5 分钟是试点展示参数，**不是**规则评估窗口、采集周期或恢复等待时长。实际 `observed_at` 在窗外就指出窗外，不拓宽查询冒充命中。用明确的人工选窗回看时保留原窗，不覆盖旧草案。
- 固定 `metric.id@semantic_version + resource + dimensions`，并核对配置修订、单位和数值编码。`db.uptime_seconds@1.0.0` 是该数据库实例自启动的秒数，不是主机运行时长、百分比或重启原因；不要把所有 `uint64/int64` 转 JS 浮点。`observed_at` 是观测时点，`collected_at` 是采集时间，`stored_at` 是入库时间；查询返回的字段子集缺某时间就留空。`readAt` 只是回查时间。
- 保留 `quality`、`accuracy`、采集失败、覆盖和间隙各自的含义。新鲜度如需判定，用事发修订的 `stale_after_ms` 和判定时点；回答“现在”须按当前时钟另读。`opening` 能证明“系统当时报了什么”，不能单独证明“此刻正常”。`has_more`、留存到期、当前不可解析旧定义、未知区段、单位或值矛盾分别给缺口，不补零；没查到原因时只说“未回查到”，不武断称已过期。首期不计算健康分。
- 跨资源比较不是首期缺省退路。将来必须在各自实时权限内分别读**同一绝对窗**，保留各自采样间隔、时钟来源、偏差/覆盖和已验证关系的有效交集；必要时比较重叠子窗。时钟偏差未知、无交集或仅相关边时，不输出同一时刻因果链。

### 4.3 各状态由谁改变

| 状态所有者 | 现有事实与转换 | 不允许的推导 |
|---|---|---|
| 规则与事件 | `episode.open → closed` 由冻结规则的独立恢复条件判定；模板恢复事务同步把关联 alert/event 标为 `resolved` 并写恢复日志。确认处理只改告警处理记录；`/events/:id/investigate` 仅流转人工处理为 `investigating`。`closeEvent` 要求已解决且有带原因的人工确认。 | `acknowledged`、手记、“开始调查”按钮均不是规则恢复；不调用通用 resolve 去改变模板事件。 |
| 调查 | `open/waiting/closed/archived` 是生命周期；`unconfirmed/in_progress/resolved/not_applicable` 是问题状态；Run 终止和结果版本又是不同事实。人工 `retest` 要求原 entry 的 event、后续绝对窗、授权与 expectedVersion，读取规则和正式样本，返回 recovered、not_improved 或 insufficient_evidence。 | Agent 的“似乎恢复”、Run 成功、草案预览都不能改变问题状态，更不能自动关闭。 |
| 行动 | `draft/pending_approval/approved/rejected/expired/superseded` 管计划；worker 的 `queued/.../succeeded/failed/outcome_unknown` 管执行；`pending/observing/passed/failed/inconclusive` 管效果报告。精确计划版本/hash、来源调查和结果版本、目标、授权主体、一次性批准及有效期不可省略。 | 审批未等于执行，执行成功未等于恢复；未知回执只走原 `reconcile`，不重发。现有固定受控 adapter 如 `restart-demo-service.ts`，不是通用生产数据库处置能力。 |

## 5. 一次从问题到答案的完整交接

**问题：**“值班交接提到 orders 库运行时长偏低。事件 701 到底引用了哪次采样？是否已经恢复？”下面数字、ID 和时间均为**假设**，不是采集结果。需要现场补当时的实际 event/episode ID、完整规则 hash、模板绑定、采样周期、授权范围及保留状况。

1. **进入。** 用户在 `/events?view=aggregate` 选事件。现有页面并行读 `GET /api/alerts/events/701` 与 `/logs`，模板详情读 `GET /api/metrics/template-events/701`。后者已能回答“当时报了什么”。建议在该组件加“带触发证据到调查”，走 `investigationEntryHref`，不复用带副作用的“开始调查”或 RCA 按钮。URL 只带已允许的上下文键，不塞样本正文、名称、SQL、凭据或授权令牌。
2. **确认可见性。** 工作台发既有 `POST /api/investigations/entry-facts`。服务端先做原调查读取门禁、实时 actor、`alert:view` 与该事件资源访问，再使用原模板和指标读取权限。URL 中的 id、窗口甚至 event+metric 组合都不受信任。事件存在但不可见与不存在按原不可见响应处理，不经计数、提示、缓存或旧页面泄露。读取及序列化前重新验证；收窄权限即丢弃整个在途敏感响应，而不是保留半张旧表。
3. **确定序列，做两种读取。** 从授权 episode 和冻结 snapshot 得到 `instance:42`、`db.uptime_seconds@1.0.0`、`{}`、修订、规则及 `opened`；取原 opening 的样本/尝试。随后由 `authenticatedMetricConsumerService.observations` 回读原窗正式观测。校验完整规则身份和主体，按 ID + 精确序列及证据内容比对。仅返回允许的 ID、时间、单位、值、修订和质量；不整包转发模板、通知渠道、人员信息、工具原文。读后若 opening 身份发生矛盾，拒绝发布关联。
4. **给答案。** “事件 701 对应实例 42。规则 v3 在 02:10:00Z 判定；其冻结输入 O2 是 02:09:59Z 的 62 秒，正式样本与配置 r7 一致。O1 是同窗样本，不是该次判定引用。仅由运行时长不能确定停机原因；这次查询也没有验证当前恢复。”若另问规则是否已恢复，展示原 episode 的末次判定/恢复日志及其时刻；要验证后续业务恢复，进入原复测。两种答案不覆盖对方。
5. **可选的人为写入。** 查看不写数据库、不创建模型任务。点击保存才 `POST /api/investigations/drafts`，带原 `Idempotency-Key`、精确上下文；服务原事务创建调查/Session 并最终验 scope，回 `modelInvoked:false`；再次进入 `GET /api/investigations/:id/context-facts` 按原窗重新授权和读取。未知保存回执核对原请求，不发新键另建调查。草案不是新 RCA 任务；不并发调用 `/api/alerts/:id/investigation` 或事件 `/rca`。如已有正式调查，按原 ID 进入，不凭同名归并。

### 5.1 契约示例（保留现有请求，不发明对象查询语言）

**已有**路径 `POST /api/investigations/entry-facts` 及下列 v1 请求字段。**建议**由新入口在协商扩展表示时发送请求头 `Slide-Entry-View: trigger-opening-v1`；未发送时维持旧响应。正式实现须同步公开 schema/客户端，不让旧严格解析器收到陌生字段。

```json
{
  "schemaVersion": 1,
  "resourceRefs": [{"type": "instance", "id": 42, "role": "primary"}],
  "sourceEventIds": [701],
  "metric": {"id": "db.uptime_seconds", "semantic_version": "1.0.0"},
  "dimensions": {},
  "from": "2026-11-17T02:05:00.000Z", "to": "2026-11-17T02:10:00.001Z",
  "returnTo": "/events?view=aggregate"
}
```

**响应投影示例**：原 `context` 和 `facts` 不变，此处只列 `modelInvoked` 与**建议新增**的 `triggerEvidence`。`O1/O2/T2/E9/H3` 为便于阅读的引用代号，线上以源记录完整 ID/hash 返回；数值沿用正式样本编码，不另做百分比换算。

```json
{
  "modelInvoked": false,
  "triggerEvidence": {
    "version": 1, "resource": {"type":"instance","id":42},
    "eventId":701, "alertId":880, "episodeId":"E9",
    "rule":{"id":"mysql-uptime-low","version":3,"bodyHash":"H3","configRevision":7},
    "series":{"metricId":"db.uptime_seconds","semanticVersion":"1.0.0","unit":"s","dimensions":{}},
    "window":{"from":"2026-11-17T02:05:00.000Z","to":"2026-11-17T02:10:00.001Z"},
    "evaluatedAt":"2026-11-17T02:10:00.000Z", "readAt":"2026-11-18T03:00:00.000Z",
    "opening":[{"sampleId":"O2","observedAt":"2026-11-17T02:09:59.000Z","value":{"encoding":"float64","value":62},"unit":"s","quality":"good","match":"verified","source":"template-event:701/snapshot.opening + formal-observation:O2"}],
    "openingAttemptIds":["T2"], "contextOnlySampleIds":["O1"],
    "coverage":{"openingReferenced":1,"openingMatched":1,"formalPageTruncated":false},
    "uncertainty":{"gaps":[],"rootCause":"unknown","currentRecovery":"not_assessed"}
  }
}
```

这里的 `coverage` 只表示**已引用 ID 回查覆盖**，不是采样时间覆盖率，也不证明 5 分钟无缺测。`source` 是受控来源定位符，不是访问票据；点回时执行源服务权限。相同 ID 内容矛盾不能给 `verified`，要区分“系统留下过冻结快照”和“今天仍能独立复核”。

### 5.2 失败路径及人与 Agent 的界面

| 条件 | 必须给出的行为 |
|---|---|
| 同名库、只给 IP；或换成 `server:42` | 不猜；从可见资产重新选择。事件定位只能用服务端已授权映射。两端身份、指标版本或维度冲突，不展示疑似命中，不保存为本试点草案。 |
| 快照缺失／历史非模板／复杂规则／显式 nodata | 回原事件详情，分别说“无可用模板快照”“本视图不解释该规则”或“缺测判定，无新数值样本”。不以当前配置、core 历史或上一个正常值回填。 |
| 已换模板、样本未保留、超页或超时 | 旧规则/值仍可来自冻结快照；仅回查到且完全一致的记为 verified，其余为 `snapshot_only`、`not_in_page` 或 `conflict`，附原因。历史查询依赖不可用标暂不可核；不得把 503 当空结果。若权限检查本身失败则不返回快照。跨页没有完整读完不能宣称整窗已核完。 |
| 在列表、读取、保存、订阅或发送前撤权 | 保持已有 401/不可见/503 语义、`private, no-store`；前端撤销在途响应、清屏；不可见时不提示隐藏端点、样本数、旧标题或“另有 N 项”。有草案 ID 也不能重放。 |
| 要求自动修复或宣称恢复 | 只读面仅给带来源建议，指向工作台复测/原行动页签；不把建议变 SQL/SSH。操作若另获授权，仍须原计划绑定来源结果版本、对象及 scope、审批人/申请人隔离、once 和执行前重验，留原回执与验证报告。 |

**AI 边界分两步。** 人的首期预览不依赖模型。当前 ops 调查可用被允许的 `query_metrics`、`get_resource_observations` 等查询**自身可见的**正式观测，可建议“核查重启日志”，应引用本 Run 的证据 ID；只靠这些工具不能宣称“O2 就是事件输入”。入口 URL、用户贴入的快照、过往案例和工具摘要不提升事实等级。若模型拿不到事件事实，应明确说“看到同窗观测，尚未核实命中”。

若 §7 证明人机交接仍是瓶颈，才把同一投影接入**受限的调查执行**：通过已保存且已授权 `context.entry` 定位，不允许模型指定任意 eventId/增加 related 资源；走 profile／工具安全目录／实时策略／入场 scope 和行数窗口预算的交集。仅工具执行后由原 `captureToolResult` 产生调查证据，再由原结果绑定器审核引用；不可将 O2 直接填入 `facts[].evidenceIds`。事件字段比资源权限更严：在工具返回、模型出站、结果回读/订阅都必须能重新验证原事件权；撤权时连带正文和引用摘要不可见。若既有持久化内容/流式路径不能保证这点，**不开放 Agent 事件投影**，维持现有指标工具，不以扩大普通聊天或 service actor 权限兜底。

## 6. 工程拆分、上线与退回

**默认路径是停在最早证明有价值的一步。** 以下是后续实施包，不是已开发功能或建单/发版授权。无数据库迁移、无历史回填、无共享资源操作。不以工时预测代替现场测量。

| 工作包／依赖 | 当前与拟改位置 | 可交付／停止条件 |
|---|---|---|
| W0 样本与基线；先做 | `docs/slide/development/MAX-239/final-acceptance-matrix.md`、`frontend/e2e/investigation-resource-links.spec.ts`，现有 `/events` 与 `/workbench` | DBA 和非管理员按 §7 标注脱敏锚点、旧入口最优路径、实际问法与耗时。核定数据可得性、部署 commit/flags。无任务频次、无可用事件或旧路已足够，停止。 |
| W1 仅补入口（A0）；依赖 W0 | 复用 `U/components/{template-event-evidence,semantic-metrics}.ts`、`U/controllers/investigation-entry.ts`、`U/components/investigation-entry.ts`。从已读事件详情提取资源、rule.metric、opening.dimensions、opened.at 和数字 eventId，使用 v1 `investigationEntryHref`。 | 单击到原只读工作台（无自动保存），保留资源原有入口、返回定位和 legacy URL；只有快照/权限/窗口合法才显示。新按钮与事件工作流的“开始调查”文字和副作用分清。与旧页面盲测；若导航即够，不上 W2。 |
| W2 正式证据匹配（A1）；依赖 W1 和失败样本 | **拟新增** `S/investigations/template-opening-evidence.ts`：纯规则身份核对、分类与有界投影；在 `S/metrics/triggers/routes.ts` 附近抽取必要的**只读**快照读取供 owner 复用，不调用 acknowledge、不联查通知投递。`S/investigations/entry-routes.ts` 编排；`S/investigations/entry-contracts.ts` 增可选响应表示，并同步其公开契约及客户端。 | 仅单实例、单模板事件、精确序列。沿用 entry 事实一页上限 200，不为匹配扫描全表，不多开资源、不持锁嵌套申请连接；快照输入也加硬上限，超限注明未核完。重用 `workflow.ts#retest` 的规则匹配原则，不调用有写入的复测方法。缺保留源仍能标示可证边界。 |
| W3 权限、兼容和真实 E2E；依赖 W2，可与 UI 渲染并行 | `U/components/investigation-entry.ts` 内分列“发生时已引用／同窗背景／无法核对”；复用 `S/investigations/{authorization,entry-routes}.ts`、原指标/事件权限。扩展 `investigations/{entry-routes.test,entry-races.mysql.test}.ts`、`frontend/e2e/investigation-resource-links.spec.ts`；拟增 `S/investigations/template-opening-evidence.test.ts`。 | 预览、显式保存、重开、改规则、改权限、超页均有证据；保存时再核来源/主体及事务授权。不开通则旧草案照常显示。跨模块权限按质量门独立复核。 |
| W4 Agent 受限读；**有条件另行批准** | `S/investigations/{profiles,tool-contract,executor,evidence-store,result-schema}.ts`、`S/tools/{catalog,policy,security-catalog}.ts` 和直接出站/回读授权路径；只有复用 W2 的读函数，不写第二套匹配器。 | 先做授权与历史正文回读审查，再决定是否新增单个“读本调查的事件输入”工具及新 profile 版本；旧 profile/请求上限不放宽。执行/撤权/来源留存/模型账本任何门未过，不发布，不影响 W1–W3。 |

**交叉计划与范围。** `docs/slide/plans/2026-10-14-t10-resource-entry.md` 已覆盖 alert owner/桥接；`docs/superpowers/plans/2026-10-16-unified-metrics-backend.md`、MAX-237/238/239 覆盖模板、绑定与正式观测；`docs/superpowers/plans/2026-10-16-ai-native-operations-v2-v3.md` 已覆盖关系、关注事项、行动与验证。MAX-683 固定工作台规范地址，MAX-684/#1010 固定聊天权与出站重验。这里依赖已合入部分，不重新实现这些计划，也不要求开启全套 Operations flags。实施开工时复查远端主线、在途 PR 和源模块 owner；本次有限 GitHub 开单关键词检索不是全量项目盘点。

**W2 的契约交付件。** `S/investigations/http-contracts.ts` 已注册 `InvestigationEntryFactsSchema`；`S/contracts/generate-public-api.ts` 为 `entry-facts`、`context-facts` 生成公开响应。由源 schema 派生扩展表示，并生成 `docs/slide/openapi.json`、`frontend/src/api/generated/public-api.ts`，不手改生成物。旧表示继续严格校验；同一新增只读函数负责预览与重开，保存复用相同的绑定核验。这样回退 UI 后，普通 v1 草案仍有独立消费者。

**发布顺序与兼容。** 拟设默认关闭的试点开关，不更改既有 operations/dispatch、调查 bridge 或采集配置。先发能识别可选表示的后端，再向试点账号展示入口；`entry-facts`／`context-facts` 请求 opt-in，旧 v1 body、旧客户端、旧返回与老草案不变。旧服务忽略扩展时 UI 只显示普通事实，绝不臆造匹配。走本试点的保存请求也要重验同一不可变事件绑定，但仍保存原 v1 上下文；历史无事件、无快照或无法确认来源时仅走原视图。版本/hash 不能匹配就不把旧草案“升级”为已核实。先退 UI/工具开关，再退投影；保留用户原始草案、运行记录、计划和审计，无需反迁移。已执行过的动作不能靠关开关撤销，本试点不派发动作。

**后续阶段门槛。** ②只有现场误结案/误报恢复得到验证，才复用原 `retest` 和报告做分别展示；③先人工抽样查故障发生时的确认关系、边可见性和时间覆盖，再决定是否支持一个历史一跳查询。两者均不默认要求图存储。若没有可授权、能复核的数据来源，停在“未知”，不为填满界面制造关联。

## 7. 如何证明有效，以及何时停

**已有基线：** 能显示触发快照、能查正式历史、能独立保存草案而不调用模型，已有受控 MySQL 案例及指定测试。**待测基线：** 现场提问频次、命中样本回查率、三种入口完成率、人工操作数/耗时、Agent 误认率、P95 延迟、目标数据量和保留覆盖。没有测量值，不声称收益。以下数字都是建议的试点准入标准，不是现网成绩。

**配对实验。** 选至少 12 个可脱敏事件/反例作第一轮功能与可用性试验，至少两名 DBA/SRE；包含两名不同权限主体。真实现场与刻意构造的负例分别标明，缺现场量则只报告可行性。冻结同一 commit/授权/数据截点、规则及样本清单，请非实现方用原事件快照、正式 publication、日志及原结果绑定标金标准，不用待验响应自证。三组用等难题交叉轮换，避免同人背答案：**现状最佳原生路径**（包括已有历史页草案链接）／**W1 仅导航**／**W2 带来源比对**。分别记录事件数、参与者数、题级对错及失败，不把多次点击当独立案例。提问固定为“对象、判定时点、规则版本、命中样本、背景样本、能否说明根因/当前恢复”。

| 指标 | 取证与建议通过线 |
|---|---|
| 事实与可追溯性（硬门） | 对全部可判样本核对 typed ID、准确规则版本/hash、revision、维度/单位、时间及正式观测 ID；**错误主体、错误确定性关联、把未引用样本当命中均为 0**。每条确定性命中 100% 能在授权来源复核。明确的缺口不能从分母剔除；另报“可回查样本／全部冻结输入”。 |
| 负例与数据新鲜度（硬门） | 同名异库、同数字异类型、同窗别的序列/修订、恰在 `to` 边界、模板 v3→v4、样本缺失/过期、无新样本、超页、未知恢复回执。预期 unknown、仅快照、留在原页面或拒绝均逐例预登记。**不得补零、用当前值改写当时值、自动结案或重发。** 比较 sample age 对应的配置版本，而非拿墙钟回算历史健康。 |
| 权限与副作用（硬门） | 普通 DBA、无事件权、无资源/调查权、仅行动页权限；预览期间、保存事务等待、重新打开、在途 WS/模型出站撤权。检查状态码、响应、DOM、模型输入/输出、日志/审计；隐藏正文/ID/数量泄露为 0。预览/刷新零 Run、零 action/approval/通知、零模型 token；双击/断线核对同幂等键只有一份草案。 |
| 人的收益（决策门） | 从读题打开事件开始，到提交带可复核引用的答案止；记录每题完成/放弃、有效点击、手输和中位配对耗时（包含失败/超时的单列，不只看成功者）。目标：不降低答对率，且多数配对题少一次跨页重选或正确完成耗时中位数降 ≥20%。若 W1 与 W2 等效，选 W1；样本太少不外推 ROI。 |
| Agent（仅 W4） | 相同模型/Provider、profile 对照、问题、来源、token/工具预算，重复试验并报告分母、调用数、误认、无引用确定性断言及 unknown 命中数。盲核每个事实的当前 Run 证据；资源误认、虚构命中、越权和把建议当执行为 0。未启用或预算/真实模型不可用记“未测”，不以 mock 达标。按根规则共用账本，禁止重放结果未知请求。 |
| 查询代价 | 以现场目标数据量和并发、短/稠密窗、旧修订、冷/热读各取样，分别记录现状/W1/W2 P50/P95、DB 查询数/扫描行、字节数、截页率、超时率；区分快照历史未保留和查询慢。必须有上限、无全库扫描且满足 owner 事先约定的延迟预算。未定预算或未测真实量，只可灰度，不能承诺毫秒数。 |

**真实业务路径与留证。** 后续在专属隔离测试 schema、显式选择的 MySQL 测试目标上，用已注册 collector/模板试采和正式 writer 自然产生样本和事件 → 实际浏览器打开 `/events` → 预览 → 保存 → `/workbench` 重新读同一 ID → 权限变更后再读。复用 MAX-239 对 uptime 隔离阈值的做法，不需要令目标宕机。另测保留期外/超页/晚到的 fixture，标明哪些是实采、哪些是注入。保存 commit/配置摘要、脱敏 ID/时间/响应、截图、裁判差异、查询计划与幂等审计；不留 token、连接串、私有日志原文。先领域/契约与 MySQL 集成，再真实 JWT/Fastify/Lit，最后当前候选的 `contracts:check`、前后端受影响检查、`ci:source-policy` 及完整 gate。三种约定桌面尺寸只查关键入口和异常，权限/跨模块须独立复核；不是本次已经执行的测试。

**Go / 缩减 / 停止。** 安全、事实硬门全部通过且真人试点有收益，才保留相应变更；W4 单独准入。若大部分现场问题仅靠快照已解决，将改动缩为原详情到草案的链接；若事件样本稀少/保留不足，先交给采集与留存 owner，不用新存储补齐“正确率”。发现任何越权、对象误认、伪恢复、读引发写操作，立即停试点并恢复旧路径。没有可靠基线或权限重验无法落实，不扩大流量，也不进入独立语义层建设。

### 待负责人核实（不影响本方案的只读结论）

1. **运维负责人：** 哪类 MySQL 模板事件真正需要交班调查？能否提供脱敏的正例、误判和原始问题，而不只给演练 uptime？这决定 W0 是否值得进入 W1。
2. **监控/存储 owner：** 目标部署 commit、已生效模板/规则、历史定义可解析率、正式观测保留期及 page 截断比例如何？这决定首批指标、窗口、性能预算，以及哪些只能标 `snapshot_only`。
3. **调查与权限 owner：** 在实际角色、聊天分享、服务身份、结果导出/订阅和撤权路径，能否对事件派生字段长期施加原权限？证据不足时仅开放人工预览，不开启 W4。
4. **平台负责人：** 旧工作台链接/草案、来源定位及回滚由谁验收？未来影响分析若无可验证的历史关系 owner 和有效期，不安排关系图项目。

**评审结论：** Slide 缺的不是重新命名“资源、事件、行动”，而是在一个确定的业务交接点上保住“哪次观测证明哪条判断”。先证明这一点能让人更少走错；成功才提取可复用的语义，失败则保留原来的领域边界。
