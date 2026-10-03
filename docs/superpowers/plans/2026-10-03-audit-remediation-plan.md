# 10 月 1 日代码审计复核与整改方案 — Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 核实 2026-10-01 审计结论，按风险和依赖安排整改，使凭证、执行身份、任务状态、证据和部署行为具备可验证的边界。本文件为待用户确认的方案，不代表已经实施整改。

**Architecture:** 保留模块化单体、DirectAdapter、ActorContext、现有 Workflow/Outbox、租约与 fencing、规范化事实存储；修复旧入口接入缺口，不更换架构。

**Tech Stack:** Fastify / TypeScript、Lit / Vite、@slide/agent-core、MySQL 控制库、现有数据库驱动、Vitest / Playwright、Docker Compose。

## 1. 执行契约与结论

- 原报告：[202610011354-全面代码审计.md](</Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault/39-Slide/04-过程文档/202610011354-全面代码审计.md>)，已全文阅读。
- 审计基线：`56ba779b4f35f3bea963340b16cec692aa967d4f`；本次复核：`main@7916d44f3fb4ca82a1a2735298efa441b4c4550f`，日期 2026-10-03。
- 当前代码根目录：`/Users/max/Coding/40-Slide`。原报告链接指向 `40-Slide-main-runtime`；本次依据当前 main 源码核实，不能据此推定正在运行的服务已采用相同代码或配置。
- 本次范围：10 项主要发现、8 项其他发现、审计后同一问题边界内的相关变更、整改与验收设计。
- 本次排除：修复业务代码、迁移生产数据、重启服务、真实模型付费调用、创建外部任务或 PR、重新开展全仓安全审计。
- 验收：逐项给出当前证据与结论；区分缺陷、条件风险和产品决策；列出优先级、工作包、迁移/回滚、测试和确认项。
- 测试层级：本轮静态调用链复核、已有定向单测、无网络/无数据库的模拟验证；实施后的真实故障、浏览器和部署验收另列。
- 资源预算：未设定硬预算。子代理 0；实际 token、缓存 token、费用遥测不可用，不提供虚构统计。工作量“小/中/大”仅表示相对范围，不是工期或费用承诺。
- 停止条件：交付本方案并等待用户确认。后续基线变化时只复核受影响项，记录范围版本，不将本文自动解释为发布或生产数据清理授权。

**复核结论：原报告整体成立，可以作为整改依据。前十项没有发现已被当前 main 完整修复的项目，但不能把它们全部视为已在线复现的高危故障。** 其中权限、凭证、PG 解密、状态衔接和界面 ID 有明确代码证据；启动/租约、指标保留、队列容量的实际影响依赖部署和负载。人工恢复确认是产品定义问题，资源诊断 UI 是体验改进。

审计后 main 仅变更 20 个文件，主要是模型发现/参数适配和 Fastify 升级。原模型测试入口的安全问题仍在；新增 `/api/llm/models` 已有管理权限检查、URL 基础校验和禁止重定向，但复用已保存凭证时也未绑定保存地址，需要纳入同一整改。此新增入口的风险主体是有模型管理权限的用户，不能与原 `/api/llm/test` 的普通登录用户暴露混为一谈。

优先级是实施顺序：P0 为首先关闭安全边界缺口；P1 为明确功能、恢复和一致性缺陷；P2 为有条件启用能力的治理、容量和体验。这里不声称已发生凭证泄露或跨实例读取事故。

## 2. 逐项核验

编号 A01–A10 对应原报告前十项，A11–A18 对应“其他有效发现”。证据链接行号以本次基线为准。

|编号/优先级|当前结论与边界|关键证据|整改包|
|---|---|---|---|
|A01 / P0|确认。`/api/llm/test` 仅校验登录；没有草稿 Key 时取保存 Key，再使用调用者传入的 baseURL。新增模型列表接口也缺保存凭证目的地址绑定，但已限制管理权限。实际泄露须具备保存 Key 和网络可达条件。|[测试入口](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:779)、[连接覆盖](/Users/max/Coding/40-Slide/apps/db-ops-api/src/llm-service.ts:801)、[发现入口](/Users/max/Coding/40-Slide/apps/db-ops-api/src/llm/model-discovery.ts:60)|W01|
|A02 / P0|确认。创建时检查目标权限，Agent 执行时改用固定 `slide-cron` 系统 Actor，未携带创建者和目标范围。现有工具过滤仍为只读，不是任意写入漏洞。|[创建任务](/Users/max/Coding/40-Slide/apps/db-ops-api/src/cron/cron-routes.ts:72)、[执行参数](/Users/max/Coding/40-Slide/apps/db-ops-api/src/cron/cron-manager.ts:169)、[固定 Actor](/Users/max/Coding/40-Slide/apps/db-ops-api/src/adapter/get-agent-engine.ts:147)|W02|
|A03 / P1|确认。报表批量认领后首项失败会遗留后续 running；running 没有业务级过期接管；完成后入队通知有崩溃窗口。分析任务进程内异步派发，故障/资源诊断可能复用僵尸 active 状态。不能用队列可恢复推导业务可恢复。|[认领/存储](/Users/max/Coding/40-Slide/apps/db-ops-api/src/report-scheduler.ts:51)、[报表 handler](/Users/max/Coding/40-Slide/apps/db-ops-api/src/workflows/report-schedule-handler.ts:26)、[派发](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-agent-bridge.ts:110)、[资源分析](/Users/max/Coding/40-Slide/apps/db-ops-api/src/resources/resource-agent-diagnosis-service.ts:73)、[超时函数](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-analysis-database-service.ts:333)|W06a / W06b|
|A04 / P1|确认。Schema/Index 的本地解密仅认两段 CBC，无法识别统一加密的 v2 五段格式，并可能退为空密码；PG 临时连接缺异常路径释放。需密码认证且保存为 v2 时触发。|[统一加密](/Users/max/Coding/40-Slide/apps/db-ops-api/src/db-connection.ts:128)、[Schema 解密](/Users/max/Coding/40-Slide/apps/db-ops-api/src/schema-service.ts:444)、[Index 解密](/Users/max/Coding/40-Slide/apps/db-ops-api/src/index-service.ts:228)|W03|
|A05 / P1|确认。typed handler 入队即记成功；Agent 完成状态不等于业务 completion；工具声称 saved 却无持久化；结果提取忽略 tool events；定时加载漏 output_schema。保留现有超时后等待执行实际结束的互斥保护。|[状态处理](/Users/max/Coding/40-Slide/apps/db-ops-api/src/cron/cron-manager.ts:138)、[结果提取](/Users/max/Coding/40-Slide/apps/db-ops-api/src/cron/cron-executor.ts:164)、[完成工具](/Users/max/Coding/40-Slide/apps/db-ops-api/src/cron/cron-completion-tool.ts:34)、[定时查询](/Users/max/Coding/40-Slide/apps/db-ops-api/src/cron/cron-job-service.ts:58)|W05|
|A06 / P1|结构确认、影响有条件。全局租约默认 30 秒，续租在慢初始化后启动；未获租约者仅 API-only，无后续选主。CronManager 等初始化位于 leader 分支。健康接口恒 ok。已有运行期续租失败 shutdown，不能说完全没有租约保护。|[租约 TTL](/Users/max/Coding/40-Slide/apps/db-ops-api/src/lifecycle/worker-lease.ts:9)、[启动/续租](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:5611)、[API-only](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:5644)、[探针](/Users/max/Coding/40-Slide/apps/db-ops-api/src/health-routes.ts:12)|W07|
|A07 / P1==|确认。TopSQL prompt 要求查执行计划/索引，但后台工具只开放完成分析，且没有预采集上下文。输出只校验形状，不绑定 subject/引用到任务快照；provenance 使用环境变量占位而非本次实际执行身份。已有 analysisId 绑定、部分输入 subject 校验，不应误说完全无绑定。|[TopSQL 派发](/Users/max/Coding/40-Slide/apps/db-ops-api/src/topsql-analysis-service.ts:139)、[后台工具](/Users/max/Coding/40-Slide/apps/db-ops-api/src/adapter/direct-adapter.ts:68)、[校验器](/Users/max/Coding/40-Slide/apps/db-ops-api/src/analysis/analysis-envelope.ts:50)、[落库](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-analysis-database-service.ts:255)|W08|
|A08 / P1|确认。关闭触发弹窗先清空 triggerJobId，再用它开始轮询；按最新日志判断，不能识别本次运行，只有一个轮询计时器。当前 `/run` 还会 await executeJob 后仅返回“执行完成”，并非已有 runId 异步契约。|[前端触发/轮询](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/cron-jobs-settings.ts:611)、[触发路由](/Users/max/Coding/40-Slide/apps/db-ops-api/src/cron/cron-routes.ts:205)|W04 / W05|
|A09 / P2；启用 V2 前必做|确认生产接线缺失。在 apps/packages/scripts 非测试源码中未找到 `.prune(` 调用；两个清理方法仅有定义和测试。默认不启用采集降低当前暴露，不代表保留配置已生效。|[指标 prune](/Users/max/Coding/40-Slide/apps/db-ops-api/src/metrics-v2/storage.ts:146)、[rollout prune](/Users/max/Coding/40-Slide/apps/db-ops-api/src/metrics-v2/rollout/control.ts:76)、[采集开关](/Users/max/Coding/40-Slide/apps/db-ops-api/src/metrics-v2/scheduler/runtime.ts:11)|W09|
|A10 / P2|确认单 WorkerRuntime 串行执行，容量影响尚未测量。不同 handler 共用执行通道，可发生队头阻塞；不能推断具体吞吐上限或已影响 SLA。|[运行互斥](/Users/max/Coding/40-Slide/apps/db-ops-api/src/workflows/worker-runtime.ts:103)、[单实例装配](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:5496)|W12a|
|A11 / P1|确认。resolveEvent 状态检查、事件更新、日志、关联告警分开执行；更新未带旧状态条件。closeEvent 已有 resolved/验证通过条件，应保留。|[事件流转](/Users/max/Coding/40-Slide/apps/db-ops-api/src/alert-event-service.ts:303)|W10|
|A12 / P1|确认。实例删除路由/存储只删除记录，没有调用现有连接释放。关系/指标等残留须按表逐项判断，不能一概认定无级联。|[删除路由](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:1358)、[删除服务](/Users/max/Coding/40-Slide/apps/db-ops-api/src/instance-database-service.ts:655)、[连接释放](/Users/max/Coding/40-Slide/apps/db-ops-api/src/database-service.ts:378)|W11|
|A13 / P1|确认。每次启动把近 30 天 is_estimated=0 全改为 true，未按公式版本限定；改变历史来源语义。具体页面影响未做浏览器验证。|[启动 UPDATE](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:5597)|W04|
|A14 / P2|确认读时重写整个 Memory 文件和单主机锁语义；容量退化需启用并达到一定规模。不是现有跨主机强一致存储。|[Memory 事务/list](/Users/max/Coding/40-Slide/packages/agent-core/src/memory-record.ts:101)|W12b|
|A15 / P2；启用相关能力前必做|确认正式 Compose 缺相关开关透传且没有对应 env_file；宿主 .env 变量不会自动注入。存在部署 override 时可以补齐，故不认定现场一定配置错误。|[Compose API 环境](/Users/max/Coding/40-Slide/compose.production.yaml:80)、[Memory 配置](/Users/max/Coding/40-Slide/apps/db-ops-api/src/adapter/memory-service.ts:17)|W07|
|A16 / P2|体验建议成立，非功能缺失。已有历史/当前、事实/推论/假设和未验证提示；原始 ID、gap code、关系类型仍在主要阅读路径。未执行窄屏/键盘/读屏验收。|[资源诊断视图](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/resource-diagnosis.ts:178)|W13|
|A17 / 产品决策|确认当前为人工恢复确认；是否必须自动检测恢复没有证据，不能直接定性为 bug。|[verifyRecovery](/Users/max/Coding/40-Slide/apps/db-ops-api/src/alert-event-service.ts:357)|D4；W10 / W13 保持含义准确|
|A18 / 工程治理|共享机制被旧入口绕过这一归纳成立。用调用方契约测试预防同类回归，不因 server.ts 很长而整体重写。|A01/A04/A05/A09 的调用链已证实；[现有 API 契约入口](/Users/max/Coding/40-Slide/package.json)|各包验收 + W14|

## 3. 本次验证证据与限度

在当前 main 运行以下只涉及模拟数据的既有测试：

```bash
pnpm --filter slide-api exec vitest run src/llm/model-discovery.test.ts src/analysis/analysis-envelope.test.ts src/workflows/report-schedule-handler.test.ts
```

结果：3 个文件、30 项测试全部通过。它们证明现有测试所声明的行为，不证明上述问题已修复：模型发现测试未覆盖“保存 Key + 更换目的地址”；Envelope 测试只验证格式；报表测试 mock 掉认领存储，不能验证 running 恢复。

另通过 `pnpm exec tsx -e` 做了两个进程内断言，无真实网络、无数据库写入：

1. 在 Fastify 注入 `/api/llm/models`，鉴权钩子模拟已授权 manager，保存配置 `https://approved.invalid/v1`、假 Key `audit-fake-key`，请求改为 `https://unapproved.invalid/v1`。返回 200，模拟 fetch 收到新地址和 `Bearer audit-fake-key`。确认的是保存凭证目的地址绑定缺口，不是鉴权绕过。
2. 向 `validateAnalysisEnvelope` 提供合法结构、subject id 999 和 `nonexistent-evidence` 引用，返回 ok。确认该函数仅做结构校验；结合完成工具和存储调用链，未发现后续任务 subject/快照引用校验。此验证没有执行数据库落库。

没有运行全仓测试、真实 MySQL/PG 故障演练、浏览器、实际双进程部署、容量压测或付费模型评估，也没有读取实际 .env 凭证。本方案的这些验收均为待实施后的要求。完整 CI 绿灯不能替代缺失的故障窗口测试。

## 4. 建议采用的产品与兼容默认值（待本方案确认）

|决定|建议默认值|对范围的影响|
|---|---|---|
|D1 部署承诺|近期支持一个承担后台任务的 API 实例；意外双进程必须安全失败、状态明确。完整多副本自动接管不列入本轮。|W07 仍修启动期续租和就绪误报；备用实例不被承诺会自动接管。若要求 HA，需要加选主重试、共享状态及真实滚动升级验收。|
|D2 数据库承诺|保留 MySQL/PG/Oracle/达梦现有入口；分别显示 declared/configured/verified/degraded，不把 declared 当认证通过。首批真实验收为 MySQL 控制库和 PG 采集。|不删除其他驱动、不擅自降低既有支持承诺；Oracle/达梦缺真实环境时记为“未验证”。若发布宣称四种均已验证，四种真实环境都必须通过。NoSQL 当前矩阵为 unsupported，不新增完整支持。|
|D3 分析新鲜度与费用|运行中复用同一有效任务；完成结果只有在主体、证据版本、模型/提示词版本相同且未过期时才可复用，并标明时间。允许显式重新诊断。|结果未知时禁止自动再次付费；用户主动重试时提示可能重复调用。缓存时效沿用当前配置/窗口，但不再只按同一小时判断有效性。|
|D4 恢复含义|本轮保留“人工恢复确认”，记录人、时间、原因，文案不称“自动验证通过”。|不新增自动恢复引擎。客观指标持续观察窗是后续独立需求。|
|D5 Memory 定位|保持个人/会话作用域和现有显式共享，默认关闭；本轮不扩为团队知识库。|做只读查询和容量测量；不默认迁移到数据库或引入向量库，不宣称跨主机可用。|

## 5. 实施顺序和工作包

建议按阶段交付，每个工作包独立验证并提交，避免一次 PR 覆盖全系统。所有路径均在上述项目根目录；新增测试/模块名为本方案拟定，实施时按仓库既有命名校对。

|阶段|工作包|依赖|相对工作量|阶段出口|
|---|---|---|---|---|
|第一批：安全与明确功能|W01 凭证/地址；W02 Cron Actor；W03 PG；W04 界面 ID 与指标标记|可分别实施|小～中，各自独立 PR；W04 两项分开提交|拒绝越权和凭证错投；PG 采集恢复；不再请求 null；启动不再重标新数据|
|第二批：执行与恢复|W05 Cron 完成/runId；W06a 报表；W06b 分析；W07 启动/部署；W08 证据|W05 接 W02/W04；W06/W08 协调状态及所有权契约；W06 恢复验收接 W07|中～大；W06a/b 分开 PR|状态与业务一致；崩溃后可收敛；引用可追溯；探针反映实际可服务能力|
|第三批：长期一致性|W09 保留期；W10 事件事务；W11 删除生命周期|W09 接 W07；W11 接 W02/W05/W06 的失效协议|中|维护确实被调度；事务原子；删除后不再发起访问|
|第四批：容量与体验|W12a 队列；W12b Memory；W13 诊断 UI；W14 集成验收|W12a 先测后改；W13 接 W05/W08|小～中；并发改造依测量结论|得到测量证据和可解释界面；最终 gate 与回滚演练通过|

### W01：保存凭证与目的地址绑定（A01，P0）

**修改位置：** `apps/db-ops-api/server.ts` 的 LLM 测试路由，`src/llm-service.ts`，`src/llm/provider-connection.ts`，`src/llm/model-discovery.ts`，`src/llm/model-discovery.test.ts`。新增 `apps/db-ops-api/src/llm/credential-destination-policy.ts` 与同名测试，必要时将测试路由提取成可注入依赖的小模块。

1. 先添加失败用例：普通登录角色访问测试入口返回 403；manager 使用保存 Key 改地址被拒绝，拒绝时尚未读取/发送 Key；正常保存配置可用；显式草稿 Key 可用于新地址。
2. `/api/llm/test` 接入 `llm:manage`。在取保存 Key 前读取供应商配置，通过统一策略绑定规范化 origin 和已批准的代理基础路径；不以供应商名称推导受信地址。仅尾斜杠/默认端口等无语义差异允许等价化。
3. 保存 Key 的新地址必须先完成有权限的供应商配置更新，或使用本次显式草稿 Key。空字符串/掩码不视为新 Key；兼容既有前端不回传保存 Key 的设计。
4. 两入口使用同一策略。携带凭证的请求禁止未经校验的重定向；验证 SDK 和 fetch 实际行为。保留合法私有服务、本地服务、代理子路径，不简单封禁内网 IP。沿用现有限流并加入口成本限制，错误/审计不记录 Key。
5. 回归 DeepSeek、StepFun、MiMo 的模型列表、草稿测试、保存后测试；未知模型仍需手动确认参数，不扩展模型目录任务。

**验收：** 假 Key + 模拟 receiver，跨 origin/非批准子路径/重定向均不收到保存 Key；401/403 路径无出站调用；正常私有代理可用。执行上述新测试和现有 `src/llm/model-discovery*.test.ts`、`src/llm/model-configuration.test.ts`、前端 `llm-config.test.ts`，补浏览器配置流程。

**迁移/回滚：** 无凭证重加密或数据库迁移。若发现历史实际异常调用，另行核对日志并由用户决定轮换，不凭静态问题宣称已泄露。修复后不得通过撤销地址校验来“兼容”旧行为。

### W02：Cron 用户主体与资源授权（A02，P0）

**修改位置：** `src/cron/cron-routes.ts`、`cron-job-service.ts`、`cron-manager.ts`、`cron-executor.ts`，`src/adapter/get-agent-engine.ts`，现有 Actor/tool policy，`sql/migrations/` 新增迁移；新增 `src/cron/cron-actor-scope.test.ts`，扩展 `cron-mysql.integration.test.ts`。

1. 添加受限用户仅能访问实例 A 的行为测试：确定性假 Agent 请求 B 时，工具执行前拒绝；服务器/网络资源同样不得从 system 权限继承。
2. 持久化任务 owner、主体类别（用户任务/系统维护）、授权资源约束和审计信息。运行时重新加载有效用户权限，与任务目标取交集；每次敏感工具调用再次校验撤权/删除状态。不能仅复制创建时权限快照当永久授权。
3. 为每次运行创建专属 ToolRegistry/ActorContext，禁止跨任务复用可变全局 Actor；保留只读工具白名单、资源过滤和持久审计。系统维护任务限定明确 handler/capability，不允许用户把任意任务设为系统任务。
4. 手动触发者也须具备当前目标权限，记录触发者与执行主体；默认仍以任务 owner 的受限权限执行，避免由临时管理员触发提升任务权限。
5. 迁移旧任务：可由可信历史记录确定 owner 的回填；无法确定的用户 Agent 任务暂停并提示管理员重新绑定。不得统一赋给 admin/system。现有 script_binding 保留并回归。

**验收：** A/B 隔离、撤权中途生效、用户停用、目标删除、跨任务 Actor 泄漏、审计写入失败时关闭执行；真实 MySQL 保存/加载/重启后身份一致。保护现有 `cron-security.test.ts`、`__tests__/cron-cancellation.test.ts`。

**回滚：** 加字段不删旧列；安全路径未启用前做 owner 清单预览。无法回滚至继续用全局系统身份的旧版来恢复任务，必要时停用受影响 Agent Cron，其他任务保持可解释状态。

### W03：PG 统一凭证与临时连接释放（A04，P1）

**修改位置：** `src/schema-service.ts`、`src/index-service.ts`；复用 `instance-database-service.ts` 的凭证读取或 `db-connection.ts` 统一解密。新增 `schema-service.pg.test.ts`、`index-service.pg.test.ts` 和隔离 PG 集成场景。

1. 用假加密密钥建立 legacy CBC/v2/损坏密文测试，断言两个调用方拿到正确明文或明确错误；先证明当前 v2 路径失败。
2. 删除两个局部解密实现，接统一接口；解密失败不降级成空密码，不在日志输出密文/明文。核对历史密钥来源是否与统一解密一致，不能只保证新格式。
3. 所有 discovery 和单库 PG client 使用 `try/finally` 释放；连接/查询/解析任一步异常都释放已创建资源，关闭异常不覆盖原错误。
4. 在临时 PG 中验证“保存 v2 密码 → 基础连接 → Schema → 索引”，覆盖有密码认证的用户；再跑 legacy 读兼容及查询错误连接释放。

**验收命令：** `pnpm --filter slide-api exec vitest run src/db-connection-encryption.test.ts src/schema-service.pg.test.ts src/index-service.pg.test.ts`。真实 PG 验收须独立记录地址类别/版本和结果，不使用开发或生产库做故障试验。

**回滚：** 不批量改写既有密文、不轮换密钥；保留 legacy 读能力。缺真实 PG 时可交付单测通过的代码候选，但不得宣称 PG 全链路已通过。

### W04：两项最小功能修复（A08 第一部分、A13，P1）

**修改位置：** `frontend/src/app/ui/views/cron-jobs-settings.ts`；`apps/db-ops-api/server.ts` 历史指标 UPDATE；分别新增前端 `cron-jobs-settings.test.ts` 和后端 `src/lifecycle/metric-quality-startup.test.ts`。

1. 前端触发前保存本地 jobId，再关闭弹窗；补“请求不含 null”的回归。此补丁不声称解决历史日志误判或并发轮询，完整跟踪依赖 W05。
2. 移除每次启动的无条件历史重标。若旧公式确需标注，使用迁移记录和可证明的公式/时间分界只处理旧批次；无法证明范围则不进行历史自动改写。
3. 测试首次与第二次启动均不改变新写入的准确指标；合法旧批次迁移最多一次且可核对行数。

**历史处理：** 已被错误标记的数据不能整体改回 false。先导出受影响候选/来源，只有能由备份或原公式版本证明的行才可恢复；无法证明保留现状并注明来源质量待核实。

**回滚：** 两项独立提交；不得恢复破坏语义的启动 SQL。历史修正脚本先 dry-run，真正批量修改另行给出具体范围确认。

### W05：Cron 运行 ID、真实完成协议与页面跟踪（A05、A08，P1）

**修改位置：** Cron 五个模块和完成工具、`src/workflows/job-registry.ts`/相关 handler，Cron 日志迁移、API contracts、前端 Cron 类型/控制器/视图。新增 `src/cron/cron-run-contract.test.ts`、`frontend/e2e/cron-runs.spec.ts`；扩展既有 Cron/MySQL 测试。

1. 先定义并测试状态：`queued → running → success | partial | failed | unknown | cancelled`。沿用已有 `success` 名称或显式映射，不能只因报告写 succeeded 就破坏旧 API/枚举。入队、runner 结束、业务完成是不同字段/事件。
2. 触发时事务创建 runId 与持久化调度意图；返回 `202 { runId, jobId, status }`，保留兼容消息字段。提供按 runId 查询接口并校验任务/目标访问权限，避免长请求等待与掉线重复触发；请求幂等键绑定主体、任务、参数。
3. completion 绑定当前 runId，校验业务 status/output_schema，持久化后才返回 saved；runner 退出不覆盖已记录的 failure/partial。普通最终文本不伪装成结构化完成。重复相同完成幂等，冲突完成拒绝；没有完成证据记为缺失/未知，不默认为成功。
4. typed workflow 用同一关联 ID 回填业务状态；定时 getEnabledJobs 和手动读取均带 output_schema。保留脚本授权、超时取消、旧执行未 settle 时不放行同一任务的互斥。
5. 前端按 runId 管理轮询/AbortController，显示本次结果；离开页面清理、并发任务互不影响、刷新后可恢复状态。断网显示“状态待确认”，不能改为成功或盲目重新运行。

**验收：** 假模型 completion=failure + 最终普通文本必须失败且有结构结果；排队不能显示成功；旧 success 日志不能结束新运行轮询；两任务同时运行/弹窗关闭/组件卸载；手动与定时 schema 一致；重复提交只产生一个 run。真实 MySQL 检查 restart 后映射与终态，浏览器按本次运行验收。

**迁移/回滚：** 新字段/查询接口先加，前端后切换，更新生成 API 契约；旧日志保留，无法还原业务结果的历史 success 标注旧语义，不追溯伪造。旧前端兼容窗口中不能把 202 解读为已完成；不兼容客户端需随发布同步升级。回滚时停止新触发并排空/保留运行记录，不删新状态。

### W06a：报表 occurrence 恢复与通知 outbox（A03，P1）

**修改位置：** `src/report-scheduler.ts`、`src/workflows/report-schedule-handler.ts`、报表持久化服务、`outbox-service.ts`/投递 handler、`sql/migrations/` 新增字段与约束。新增 `src/workflows/report-recovery.mysql.test.ts`，扩展既有 handler 测试。

1. 先用真实临时 MySQL 写失败场景：两个到期 occurrence 首个失败；认领后进程退出；报告保存后退出；occurrence 完成后通知尚未入队；旧 owner 迟到写入。
2. 以 configId+occurrenceAt 唯一定位业务发生，绑定 durable job、owner/fencing/租约。优先采用扫描产生独立 occurrence job、逐项认领；不要预占整批后只执行首项。保留调度 successor 的持久化安排。
3. 报告内容和业务 occurrence 关联持久化；生成过程不得长期占用数据库事务。最终报告关联/occurrence 终态/通知 outbox 在同一短事务提交；复用已生成 reportId，重试不得重新生成同一已完成报表。
4. 接管过期运行要检查 owner 和 fencing；所有迟到副作用都须拒绝。通知以 reportId+channelId 幂等，沿用发送后响应丢失为 unknown 的既有投递协议，不能宣称通用 exactly-once 外部通知。

**验收：** 每个崩溃窗口重启后均有可解释状态；另一 occurrence 不永久卡住；至多一个有效报告关联、一个逻辑通知意图；旧 owner 无法完成；已投递但未知的通知不自动重复发送。

**历史迁移：** 先列旧 running 与 report/notification 关联。确定已生成的补关联/缺失 outbox；确定未开始的安全重排；无法确认外部结果的保留 unknown 等待处置。先 dry-run，再经具体数据清单确认执行；不能批量把 running 改 failed 再重跑。

**回滚：** 迁移只新增；暂停 scheduler，等待/标注在途任务，再降级到能理解新状态的版本。保留 outbox 与投递审计；禁止通过清空表“恢复调度”。

### W06b：分析任务持久化派发与结果未知处理（A03，P1）

**修改位置：** `src/ai-agent-bridge.ts`、`fault-diagnosis-service.ts`、`resources/resource-agent-diagnosis-service.ts`、`ai-analysis-database-service.ts`，现有 workflow/agent run 集成点；新增 `src/analysis/analysis-recovery.mysql.test.ts` 与派发 handler。与 W08 共享快照/执行身份契约。

1. 建立 analysisId、durable job、attempt/owner/fencing 和请求状态的关联。创建分析与派发 outbox 同事务，不再依赖仅进程内 fire-and-forget。
2. 区分 pending、running、终态和结果 unknown；派发前失败可安全重试，已可能到达供应商的请求遇崩溃/超时先记未知，支持供应商查询或幂等时才自动恢复，不默认重复付费。
3. 恢复扫描真正接线，按租约和运行身份判断；不把既有 `checkAndFailStuckAnalyses` 直接定时调用作为完整修复。迟到 completion 受 attempt/fencing 约束，不能覆盖新尝试。
4. 按 D3 修改缓存：active 只有有效租约才复用，完成结果需证据/配置版本及新鲜度匹配；错误路径收敛，前端显示重试后果。

**验收：** 创建提交后派发前退出、发送前退出、发送后响应前退出、完成落库前/后退出、双 owner 迟到回写；安全窗口不丢任务，未知窗口不自动重复计费；相同用户重试不会无限得到失效 active；权限撤销后不能恢复执行。

**迁移/回滚：** 旧 pending/running 分为可证未发送、已有结果、无法确认三组；保留原记录与原因，未知组由用户选择是否重试。不抹掉历史结果、不自动补充虚构 provenance。关闭新派发即可止损，未结任务必须保留可查询，回滚版本需理解 unknown。

### W07：启动租约、服务就绪和配置透传（A06、A15，P1/P2）

**修改位置：** `server.ts` 启动装配、`src/lifecycle/worker-lease.ts`、`src/health-routes.ts`、`compose.production.yaml`、配置示例；新增 `src/lifecycle/worker-startup.test.ts`、`tests/qualification/startup-readiness.test.ts`。

1. 获得全局 lease 后立即续租，再执行可取消的慢初始化；每次启用后台副作用前确认所有权。续租失败/超时在初始化阶段也停止任务并关闭未完成资源，保留运行期 fail-closed。
2. 分离 API 必需依赖初始化和 leader-only timer/worker 启动；API-only 不再通过非空断言使用未初始化 CronManager。无可用执行者时对触发类 API 返回明确不可用，而不是成功或内部空指针错误。
3. 保留 `/api/health` 作为 liveness；新增只返回布尔/有限状态码的基础设施 readiness，不泄露资源、配置或凭证。现有 `/api/health/readiness` 需 JWT+config:view，不能直接改成未认证详细接口或直接拿它做 Compose 探针。
4. D1 下正式 Compose readiness 要求本实例声明的角色已就绪、控制库和派发能力可用；租约未获/已丢失时不可误报可承接后台工作。备用实例不自动接管的限制写清楚；若以后选择 HA，增加退避选主和共享状态验收。
5. 显式透传 `METRICS_V2_COLLECTION_ENABLED`、`SLIDE_MEMORY_PIPELINE_ENABLED`、`SLIDE_MEMORY_WORKSPACE_ID`、`SLIDE_MEMORY_RETRIEVAL_MAX_COUNT`、`SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS`。默认保持关闭；启用 Memory 缺 workspaceId 需明确失败；只记录脱敏后的有效开关，不输出全环境。
6. 核对启动 reaper：不得在多实例启动时无条件把另一活跃 owner 的所有 running Cron 日志改终态；结合 W05/W06 按所有权与过期条件恢复。

**验收：** 初始化延迟超过 30 秒仍不丢 lease；两个真实 API 进程不会重复启动后台任务；leader 退出后备用状态符合 D1 且不误报自动接管；数据库失联、续租阻塞、初始化半途失败均可解释。临时假配置渲染 Compose，再核验测试容器实际收到开关；不打印真实渲染结果中的 secrets。

**回滚：** 不自动开启新功能；开关可关闭。探针有 start period，避免部署误杀启动中的服务；不能回滚到恒 200 探针来掩盖未就绪。完整 HA 为单独范围扩展。

### W08：冻结证据、引用校验和实际 provenance（A07，P1）

**修改位置：** `src/topsql-analysis-service.ts`、`ai-agent-bridge.ts`、`adapter/direct-adapter.ts`、`analysis/analysis-envelope.ts`、`ai-analysis-database-service.ts` 和生成完成工具的源定义/生成链；新增 `src/analysis/analysis-evidence-binding.test.ts`，扩展 `analysis-envelope.test.ts`、`ai-analysis-lifecycle.test.ts`。

1. 授权后由服务端预采集 SQL、Schema、索引及安全执行计划，冻结为有版本/hash/采集时间/缺口的证据快照。TopSQL 不再要求没有开放的工具；不为解决缺证据而给后台分析全局数据库工具。
2. EXPLAIN 使用现有 SQL 边界：限时/限行/只读，不对未知 SQL 自动执行 EXPLAIN ANALYZE 或 DML。采集失败形成缺口，不能虚构执行计划。
3. 完成接口携带服务端任务上下文，校验 analysisType/subject 与任务一致，evidenceRefs 必须指向本任务有权限的冻结快照。保留现有 ref 格式并建立明确解析器，不能为方便只支持一种新格式导致历史引用失效。
4. 不存在/越权引用和错误 subject 拒绝并返回稳定错误码；缺证据允许明确 unknown 结论，不能保存成“已验证”。保留旧 Markdown/Envelope 展示并标明验证等级。
5. provider/model、路由配置版本、实际 prompt hash、输入 hash、tool 版本来自本次服务端执行；usage 在供应商提供时保存，否则记不可用。完成工具不能自行伪造。处理 completion 先发生、最终 usage 后返回的次序，补充元数据不能改写结论或冒充另一 attempt。

**验收：** 错 subject、错类型、虚构引用、属于其他任务/作用域的真实引用均拒绝；真实快照引用通过；切换模型或提示词可区分；结果能反查到执行时快照而非当前变化后的指标。用假模型覆盖确定性路径；少量已知根因案例的真实模型质量评估单列预算/环境，未完成时不宣称业务质量通过。

**迁移/回滚：** 新结果强约束、历史结果只读兼容。不能给历史记录批量填 configured-provider 后声称真实来源已恢复。新快照有访问控制与保留策略，脱敏敏感 SQL/业务数据；回滚保留快照和原结果。

### W09：Metrics V2 保留策略真正进入调度（A09，P2）

**修改位置：** `src/metrics-v2/storage.ts`、`rollout/control.ts`、现有调度装配；新增 `src/workflows/metric-retention-handler.ts` 和 `.test.ts`，扩展 `storage.mysql.test.ts`、`rollout/control.mysql.test.ts`。

1. 注册内部固定能力的维护 job，使用现有 Workflow 和 lease；非用户自由配置的 system Agent。有效保留期从显式配置读取并校验，记录清理原因、批次计数和最老数据年龄。
2. 每批上限沿用现有 bounded limit，另限制单次运行批数/时长，未完成则安排续批；重复执行、进程退出、关闭任务后都可恢复。
3. 先依据原始证据过期语义去 payload/留 tombstone，再清理历史/attempt，最后处理 publication/transition 关联。明确当前发布状态和可追溯引用如何保留，不能仅串联两个 prune 就认定安全。
4. 过期敏感原始内容不得因引用而无限保留；仍被当前视图需要的身份、来源和过期状态保留可解释引用，读取不得将已过期证据当新鲜数据。

**验收：** 真实 MySQL 混合过期/未过期/当前引用样本，跨批次/重启/重复执行；从生产装配入口触发到存储删除的集成测试，不能只直接调用 prune 单测。

**迁移/回滚：** 首次启用先 dry-run 给出数量/时间范围，再执行具体清理。停止 job 可回滚调度，删除的 payload/行只能从已验证备份恢复；不是可随意逆转的配置操作。

### W10：事件流转事务与准确的恢复含义（A11、A17，P1）

**修改位置：** `src/alert-event-service.ts`、`server.ts` 事件路由，新增 `src/alert-event-transitions.mysql.test.ts`。

1. 同一事务中锁定/条件更新事件状态、写事件日志和关联告警状态；日志 helper 使用同一 connection，不能仍走独立 pool。只允许合法原状态，失败整体回滚。
2. 将 resolve、close、人工 verify 的共享流转边界一起核对：保留关闭前验证要求，拒绝迟到/冲突转换；相关路由传入真实 userId，不把操作者丢为 null。重复同一动作明确幂等或冲突响应。
3. 按 D4 记录人工确认依据；界面区分人工确认和客观指标证据，不新增自动检测能力。

**验收：** 两并发相冲突流转只有合法一个生效；事件更新后日志插入失败/关联更新失败全部回滚；关闭条件及审计 actor 正确。历史不一致先只读列清单，再按可证明事实修正，不批量倒推过去状态。

**回滚：** 不丢历史事件/日志；数据库事务迁移兼容旧记录，保留状态约束。不能通过移除 closeEvent 验证条件绕过新流程。

### W11：实例删除后的任务与连接生命周期（A12，P1）

**修改位置：** `server.ts` 实例删除、`instance-database-service.ts`、`database-service.ts` 和直接相关任务/采集/资源关系服务；新增 `src/resources/instance-removal-service.ts`、`.test.ts` 与 MySQL 集成用例。

1. 先列当前外键级联、应用关联和 runtime 缓存清单；为连接、任务、资源关系、指标、审计分别明确停止/失效/保留，不做全库级联删除。
2. 删除请求先让资源进入不可新增访问的 deleting/失效状态，停止调度和取消可取消在途任务，再关闭各驱动连接，最后完成记录删除/墓碑。跨数据库与进程操作使用可重试清理步骤，不能假设一个 SQL 事务能回滚关闭 socket。
3. 每次任务执行检查资源有效性，阻止删除后旧任务重建连接；释放一个驱动失败时仍尝试其余资源清理，并记录可重试原因。涉及多实例时必须有失效传播；D1 先验证单主机边界。
4. 审计、历史诊断、指标按既有保留政策可读但明确对象已删除；禁止把删除目标变成 null 后转成控制库/全局任务。

**验收：** 已连接且有 Cron、指标、关系的实例删除后无新增查询/采集，连接关闭；重复删除/清理中断能收敛；迟到任务不能恢复目标；历史审计仍可查。数据库记录删除失败时状态可解释，不出现“已成功”但进程仍访问。

**回滚：** 保留清理意图和 tombstone；不要自动重新连接已删除对象。真正删除既有用户资源仍通过其原有删除操作触发，本整改实施不直接替用户批量删除实例。

### W12a：队列测量后再决定有限并发（A10，P2）

**修改位置：** `src/workflows/worker-runtime.ts`、工作分发装配、`src/platform/` 现有队列观测；扩展 `worker-runtime.test.ts` 和 `tests/qualification/` 稳定性场景。

1. 先补按 job 类型统计最老等待、排队/执行耗时、积压、retry/dead-letter、lease 丢失；记录测试硬件和负载。
2. 用可控慢报表 10 秒，同时入队通知和采集，测当前串行基线；这证明等待关系，不代表生产吞吐容量。
3. 只有测量超过目标时才增加类型隔离的有限 worker 或公平调度。建议候选目标：该确定性场景下通知/采集可在 2 秒内开始；将它明确标为待确认验收目标，而非现网 SLA。并发上限按 DB pool/模型限额设定，默认保守。
4. 不删除 runInFlight 来“开启并发”；每个 worker 保持自身互斥，保留同资源互斥、fencing、shutdown quarantine，避免不可取消慢操作失控扩张。

**验收/回滚：** 同样负载前后对比等待与资源消耗；同资源无重叠副作用、无饥饿；可将并发设回 1。未做压测时仅交付观测与结论，不能宣称已消除容量瓶颈。

### W12b：Memory 只读快照和容量基线（A14，P2）

**修改位置：** `packages/agent-core/src/memory-record.ts` 及现有文件/锁 helper；新增 `packages/agent-core/src/memory-store-read.test.ts`，相关 memory 测试。

1. list/export 使用安全只读快照，不为纯读取调用会持久化的 transaction；复用原子文件替换保证读到旧或新完整状态，保留 schema 校验、文件权限和作用域过滤。
2. 写操作继续使用已有单主机锁、原子替换、tombstone 和 budget 规则；读与删除并发不能泄露不属于调用者的记录。坏文件不静默初始化空库。
3. 对 100/1,000/10,000 条模拟记录测查询耗时/内存/写次数，确认重复 list 不改变文件内容/mtime、不创建写锁；测试多进程写入和崩溃恢复。
4. 分区或 MySQL 存储仅在测量需要且产品范围确认后另立迁移方案，保留 scope、共享授权、来源失效和预算；不引入向量库。

**回滚：** 本包不改文件格式；关闭功能后保留状态卷，恢复旧读取逻辑不丢数据。跨主机使用不在支持范围。

### W13：诊断结果面向业务解释（A16、A17，P2）

**修改位置：** `frontend/src/app/ui/views/resource-diagnosis.ts` 及相关状态展示、`frontend/e2e/resource-diagnosis.spec.ts`，复用共享组件。

1. 主界面展示资源名称、异常结论、证据时间/有效性、缺什么和可执行下一步；原始 ID、gap code、JSON 保留在详情便于排查。
2. 明确区分排队/运行/部分完成/失败/未知、历史结果/当前证据、人工确认/自动观测；重试前显示费用和未知结果含义。现有未验证引用提示保留。
3. 按项目共享组件/token/boolean property binding 规范实现；不扩成全面视觉重设计。

**验收：** 浏览器桌面和 375px 窄屏、纯键盘、读屏语义检查；无权限/数据缺失/超时/旧结果均有准确反馈；业务用户能回答“分析对象是谁、依据何时、哪些不确定、下一步做什么”。不得仅凭静态源码宣布可访问性通过。

### W14：调用方契约和最终集成（A18）

1. 每个工作包用行为测试防止旧入口绕开统一凭证、Actor、completion、保留策略；优先测实际路由与存储，不用源码字符串断言代替行为。
2. 每个工作包先失败场景，再最小修复，再 focused tests 和受影响模块 typecheck；记录 commit、环境、命令、结果和未验证项。API 改动重新生成并校验契约。
3. 最终候选只运行一次完整 CI gate，后续变化仅重跑受影响检查和必要集成。当前 CI 包括 backend/frontend/agent-core/sandbox、browser、browser-qualification、recovery-qualification、release-artifact。
4. 在隔离环境增加本计划故障窗口覆盖，现有 failover/stability 脚本通过不能替代报表/分析业务层崩溃验收。涉及迁移的包都验证空库、旧基线升级、重复启动和旧结果读取。
5. PR 每包说明触发条件、前后行为、迁移、回滚和测试证据。本文确认不自动授权合并/发布或生产历史数据批量修复。

## 6. 验收命令与发布边界

以下命令为实施后的执行入口，不是本轮已通过清单。新增测试路径按各工作包落地；真实服务脚本仅在隔离临时环境运行。

```bash
# 每包按实际受影响范围选择
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter agent-core typecheck
pnpm contracts:check

# 最终候选：统一执行一次，复用当前 CI
pnpm lint
pnpm -r test
pnpm --filter slide-frontend build
pnpm qualification:matrix
pnpm security:audit
pnpm security:scan
pnpm --filter slide-frontend test:browser
bash scripts/qualification/run-agent-runtime.sh --mode deterministic
bash scripts/qualification/run-environment.sh bootstrap-upgrade
bash scripts/qualification/run-environment.sh failover
bash scripts/qualification/run-environment.sh stability
bash scripts/qualification/run-environment.sh backup-restore
```

此外必须按本计划验收 PG 真实链路、Cron 浏览器运行跟踪、MySQL 业务故障窗口、正式 Compose 的慢初始化/探针/有效开关；测试夹具使用临时端口/数据库/假凭证，不能接正在运行的用户数据。

发布声明与证据匹配：单实例安全不等于 HA；数据库 declared 不等于 verified；模型执行成功不等于诊断正确；人工恢复确认不等于自动恢复检测；全部单测通过不等于跨边界验收通过。未能提供环境的项目保持“未验证”，不得用 mock 结果替代。

迁移采用新增字段/索引/表优先，实施时分配不冲突的 migration 编号并遵循现有 runner。先兼容读，再切新写，最后另评估旧路径清退；不在本轮全删 legacy。真实历史修复、保留期删除先给出 dry-run 清单和恢复方案。

若后续另行授权发布打包，镜像/代码包/校验和/说明统一放 `/Users/max/Coding/40-Slide/outputs`，每个 tar/tar.gz/tgz 必须不超过 300,000,000 字节并生成校验和。本次不构建发布包。

## 7. 用户确认点与范围版本

建议确认 **v1：按第四节 D1–D5 默认值，先执行第一批 W01–W04；第二至四批作为后续整改路线**。这样先关闭安全边界并恢复确定受损的功能，第一批结束后可依据真实验收再推进状态恢复工作。

也可以一次确认 W01–W14 全部工程整改；W12a 的并发改造仍必须以测量为前提，真实模型费用、生产数据修正/清理、部署发布仍按具体对象和副作用另行界定。若需要近期 HA、四种数据库正式认证或自动恢复验证，请明确替换相应默认值，单独记录范围增量与验收。

|版本|日期|范围与变更原因|实施状态|
|---|---|---|---|
|v1|2026-10-03|复核原报告 18 项；增加审计后模型发现入口同类凭证风险；按既有架构拆分整改包。|仅完成复核、定向验证和方案；待用户确认，未修改业务代码。|
