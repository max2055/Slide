# T09 System 领域与共享装配验收

## v1.2.25：长期授权与真实 completed 恢复验收（2026-10-14）

当前状态以本节为准；下文保存历史失败、限额与交付阶段，不再作为当前调用审批规则。Max 评论 `01a137d7-4d36-757f-a0ad-2d92cb91299b` 取消验收的3请求/2048输出/32000累计授权预算，覆盖失败后再索取token/Provider审批。仅opt-in qualification使用新模式；共享Provider配置、16k运行上下文、32k单次执行预算、权限、源码egress和生产默认关闭状态均未修改。

长期账本从最新已停发且全部请求有usage的场景建立不可变哈希关联，fsync claim阻止分叉，锁及发送前持久计数阻止未知发送重放。新场景仅在前一场景停止并完成诊断后创建，不清除原stop，不重开partial Run。工作树迁移使用显式绝对路径映射验证原journal与claim原始字节，不重写旧文件；后续账本继续携带路径映射与累计基线。缺usage、未知发送、损坏或缺失历史、残留锁均失败关闭。保留旧两场景3081+2970=6051 token、原四请求和T04五请求；T04 token与家族遥测不可用。

本轮共享DB仅SELECT已有deepseek/deepseek-flash及场景配置，通过原Provider factory使用实际4096配置输出；零共享写入。业务使用独占mysql:8.4、两次正式迁移、合成两小时积压事件与允许出站的签名夹具源码。三次HTTP200中模型自主调用全部五个System工具，第三次实际请求包含原事件、精确Commit、manifest及完整源码。最终回答引用`SYNTHETIC_TIMEOUT`、`src/system-fixture.ts`，明确缺日志/窗口截断、合成夹具性质和未验证根因/恢复。源码及目标为fixture，不能称生产根因验收。

真实Run `896e3f04-cce5-4752-ab16-06ec26612511` 在模型最终回答后确实触发`T09_REAL_COMPLETION_FAILURE` SQL trigger。移除trigger并dispose原Adapter，正式Workflow重新claim获得新fence；独立Node进程以禁止Provider调用的factory恢复，再终态重投。两次均为同一completed Run、单版结果、五份完整证据/五条canonical tool fact，Provider重发增量0。JWT/真实TCP HTTP200读取原事实并关联原调查；SQL ledger settled且charged_tokens与原始HTTP usage、journal一致。独占容器/schema已清理。

本轮input4781+output1704=6485 token；cached2560已含input。T09累计12536 token、七次请求；跨阶段累计12请求，T04历史token不可用。ledger费用8189 microUSD仅配置估算，供应商实付与家族token/费用不可用。新场景以`QUALIFICATION_COMPLETED`停止，旧两份journal/hash/claim/stop不变。

零调用保护测试15/15（长期超过旧上限、基线/分叉/复制/未知usage/残留锁/跨worktree迁移）；前三个新用例在旧实现RED，修复后GREEN。类型检查、秘密扫描通过；其余未变化System/SQL/浏览器回归复用父已核验结果。最终准确head CI见PR165 checks及MAX-150证据附件。真实复验后仅补齐后续worktree导入的路径映射继承，并验证原场景账本零发送读取；executor和真实qualification发送源码未变化。

当前运行方式（环境中的全部文件路径为绝对路径，历史路径映射文件按实际迁移提供）：

```bash
pnpm --filter slide-api exec tsx -e 'import {initializeSystemJournal,SYSTEM_STANDING_AUTHORIZATION} from "./src/investigations/system-real-provider-budget.ts"; import {readFileSync} from "node:fs"; initializeSystemJournal(process.env.T09_REAL_JOURNAL!, {authorization:SYSTEM_STANDING_AUTHORIZATION,previousJournal:process.env.T09_PREVIOUS_JOURNAL!,historicalPaths:process.env.T09_HISTORY_PATHS ? JSON.parse(readFileSync(process.env.T09_HISTORY_PATHS,"utf8")) : undefined});'
T09_REAL_AUTHORIZATION=01a137d7-4d36-757f-a0ad-2d92cb91299b \
  pnpm --filter slide-api exec tsx src/investigations/system-real-provider-qualification.ts
```

另需`T09_PROVIDER_ENV`、`T09_REAL_EVIDENCE`、`T09_REAL_ARTIFACTS`；`T09_REAL_PREPARE_ONLY=true`仅零调用预检，不能替代真实验收。脚手架不由生产启动或常规测试隐式执行。禁止用上述命令重开已完成场景。

真实模型消费/回答/completed恢复验收已通过；完整T09仍待父独立复核、准确新head CI与普通merge/main核验。共享owner仍T09，T11的40样本unscored、T10/T12门禁未释放。旧144.5ms根因未确认，100ms门禁保留；无新增Issue/子代理/生产操作。

## v1.2.21：真实 Provider 有界验收与输出预留修复候选

Max 授权评论 `01a135cd-25dd-7ab7-aca4-f92d31398f37` 覆盖本场景的旧零请求限制。共享 MySQL 仅通过应用环境认证执行 Provider/场景 SELECT，沿现有 `createConfiguredAgentProvider` 默认场景路由使用 deepseek/deepseek-flash；密钥仅在内存解密，未改共享配置。本场景独立持久账本记录发送前计数、输入字节保守上界、输出额度及真实 usage；锁竞争、未完成请求、缺失 usage、HTTP/协议错误均停发，不自动重试或 fallback。上限为 3 次 HTTP、32,000 input+output、每次输出 2,048；缓存属于 input 子集，不重复相加。原 5/6 成功停发历史保留，未挪用剩余额度。

唯一一次真实场景使用独占 MySQL 8.4、两次正式迁移、限制 service 身份及两小时前合成错误。正式 composition→持久事实→admission→Workflow/DirectAdapter/executor，真实模型自主第一轮选择 observations/manifest，第二轮选择 symbol/search/read；实际工具读取原事件、一小时窗口及 gaps、精确合成 Commit、经验证的签名 manifest、允许出站的 178 字节夹具源码。没有人工伪造真实模型的工具选择。源码/目标为 fixture，不称真实生产源码/故障根因验收。

**真实验收未通过**：两个成功 HTTP 共 input 2,469、output 612、总吞吐 3,081，缓存 640（已含 input）。旧阶段 5 加本阶段 2，累计 7 次；旧阶段 token 实测不可用，不能声称累计只有 3,081。执行器在第二批工具后返回 `partial / CONTEXT_UNRECOVERABLE`，未发第三次、未生成最终模型回答。5 条工具结果均存入 canonical/evidence；SQL ledger settled、charged_tokens=3,081、配置估算费用 3,693 microUSD，供应商实际费用及家族 Agent token/费用不可用。新进程持正式新 fence 恢复及终态重投均保持同一 partial Run、一版降级结果、5 份证据、零模型重放，JWT/TCP HTTP 仍能关联事件与调查。预计的 completed SQL 故障修复没有触发，不能将 partial 重投等同于该 completed 场景通过。容器和业务 schema 已清理。

离线复用已记录的助手/工具事实，未发模型请求，`ContextManager` 保守估计 11,936，大于 16,000−4,096−1,024=10,880 的输入额度。本场景实际输出 ceiling 为 2,048，但 executor 固定以 4,096 预留。候选现在同时遵守 Provider 配置的 preferred/max output、原 4,096 ceiling 和执行剩余预算；没有扩大 16k 上下文、32k ledger 或启用摘要模型。以 2,048 预留的离线相同事实估计在 12,928 输入额度内。这只定位并验证预留修复，不证明真实最终回答可通过。

新增真实 SQL 回归以 8,192 上下文、1,024 最大输出及512配置输出验证原事实→completed/canonical，旧固定4,096失败、修复后通过；预算并发/崩溃/缺 usage/失败停发直接测试保留。当前请求账本已永久 stop，修复后没有重发或重新初始化。

显式运行方式（从仓库根；路径变量必须为绝对路径）：

```bash
# 一次性独占初始化，已有文件会拒绝；不得用新路径绕过本场景 stop。
T09_TEST_JOURNAL_PATH="$T09_REAL_JOURNAL" pnpm --filter slide-api exec tsx -e \
  'import {initializeSystemJournal} from "./src/investigations/system-real-provider-budget.ts"; initializeSystemJournal(process.env.T09_TEST_JOURNAL_PATH!)'
# 环境需显式提供本授权、已有应用 .env 的路径、账本及脱敏产物路径。
T09_REAL_AUTHORIZATION=01a135cd-25dd-7ab7-aca4-f92d31398f37 \
  pnpm --filter slide-api exec tsx src/investigations/system-real-provider-qualification.ts
```

必需环境：`T09_REAL_JOURNAL`、`T09_REAL_EVIDENCE`、`T09_PROVIDER_ENV`、`T09_REAL_ARTIFACTS`。`T09_REAL_PREPARE_ONLY=true` 只做零模型预检，不能作为真实模型消费证据。默认测试/生产启动不会执行 qualification。完整 T09 仍需父核验本次失败与修复、另行明确复验授权、所需真实验收、新 head CI、独立 Review、普通 merge/main 核验。共享 owner 仍 T09，不释放 T11/T10/T12；原 144.5ms 性能失败根因仍未确认，100ms 门禁不变。

## v1.2.19：T09-WINDOW-01 积压窗口修复

父在 PR165 `08b8ccaa` 真实 MySQL 复现两小时积压：准入成功，但发生时间到摄入时间的间隔被直接当作工具查询窗口，超过一小时后抛 `SYSTEM_TOOL_SCOPE_INVALID`；事件时钟领先数据库也会产生反向窗口。历史准入/CI/失败证据保留。

正式 `createSystemComposition` 现在将两个持久时间解释为事件发生时间 `context.from` 和数据库摄入时间 `context.to`，并生成 `[occurredAt, occurredAt + min(1h, max(0, receivedAt - occurredAt))]` 查询窗口。原请求快照、事件原件、关联、调查/component/Commit 均不改写；旧积压请求也使用同一装配恢复。没有扩大 `createSystemTools` 或 `readFacts` 的一小时上限，没有平移窗口丢弃原事件，没有新增事务/迁移/执行 owner。

超出窗口时 observations 同时返回原 `eventOccurredAt`、数据库 `receivedAt` 与实际 `observedFrom/observedTo`，并标记 `SYSTEM_EVENT_WINDOW_TRUNCATED`；负间隔返回零宽事件窗口和 `SYSTEM_EVENT_CLOCK_AHEAD`。日志仍按原进程证据质量降级，不推测不存在的历史日志。正常窗口保持既有工具输出，避免增加后续 Run 的上下文体积。源码仍使用原事件精确版本、签名 manifest 和实时权限；没有改动源码同步链路，复用既有真实 sync 验收。

本轮真实隔离 MySQL 8.4、两次正式迁移：**17/17**，无条件跳过。新增两小时/七天积压及未来两小时时钟偏差的三项 SQL 测试先在旧代码上以 `SYSTEM_TOOL_SCOPE_INVALID` 失败，再通过。每项新建服务实例与独立 Node 进程读取原事件，验证哈希、关联、最多一小时窗口、缺口及实时撤权。七天积压经正式 executor/AgentRunner/工具/SQL canonical 执行；真实 SQL trigger 拒绝完成提交，随后新进程以正式 Workflow 新 fence 恢复完成，Provider factory 禁止调用。再重投仅保留同一 completed Run、一版结果、一份证据和一条 canonical tool fact。源码用例改为两小时积压下的正式装配，继续验证签名快照/egress/部署错版本关闭读取。

受控本地 Provider 实际消费原事件并返回缺口结论，**不替代真实 Provider**。Chromium/JWT/真实 HTTP/WS 原 System 三 Run 回归通过；本轮初版在正常 observations 增加时间字段导致第三 Run `CONTEXT_UNRECOVERABLE` 的失败历史保留，最终仅异常时间返回新增字段，正常场景回归通过。测试夹具曾误复用旧 fence、误查 `chat_messages` 的 tool 行，已分别改为正式新 fence 与 `agent_canonical_facts`，未修改执行核心。

零新增外部模型请求、Issue、子代理、生产操作；原外部 Provider 5/6 成功停发且不转授/重置。家族 token/费用可靠实测不可用。当前为修复候选，完整 T09 仍待新 head CI、父独立 Review/真实验收、真实 Provider System 消费及普通 merge/main 核验；不释放共享 owner 或 T10/T12。

历史领域阶段：2026-10-13，授权 MAX-150 v1.2.16；父 MAX-140 同版本。保留 T09-A / PR157 历史，不重做准备阶段，不把本次领域交付称为完整 T09 出口。

## 行为及文件边界

- `investigations/system-event-bridge.ts` 先在既有 `workflow_jobs` 保存脱敏原始错误事实，再由 `system.event.ingest` handler 读取数据库原件并调用既有 `MysqlOperationalEventIngest`。不复制 admission/预算/权限/Run/结果事务，无新 migration。幂等键使用 source + 原事件 ID 的 hash；内容冲突拒绝覆盖。
- `platform/system-failure-publisher.ts` 有界 64 个待写请求，不让 SQL/admission/model 进入响应等待链路。数据库写入失败/溢出明确计入 lostEvents，不把进程日志冒充持久 fallback；默认未安装，诊断返回 `SYSTEM_EVENT_BRIDGE_NOT_INSTALLED`。
- API 实际 5xx、数据库/服务器/网络采集失败、Workflow 已提交的失败、runtime candidate.reject 提供挂钩。只有稳定代码、注册 route/callsite、request/run/job 关联和部署版本；不保存 request/query/job payload、SQL、凭据、模型/用户正文或远端错误文本。当前日志 window、runtime unknown terminal 映射保持 T09-A 行为。普通 runtime 的 body-free terminal 缺停止原因，不能把它伪造为成功或失败；调查真实失败由 Workflow 的已提交失败事实覆盖。
- `origin=investigation_engine`（包括 Agent 和调查 job）只记录事件，不产生调查/Run；摄入 job 自身失败保留原 job/错误记录，不再提交另一个摄入 job，防止摄入队列递归。
- `investigations/system-tools.ts` 提供 System Profile 既有五个工具。调用方、调查和窗口由 server 固定；每次及返回前检查实时权限和工具策略，全部 required scope 遵循既有 authorization。读取仅关联当前 investigation 的持久事件与 job 原件，无任意 rawRef/job payload 查询。日志仍声明 process-local，缺失、窗口不覆盖、丢失、截断都有 gaps。
- 原事件 release/完整 Commit、当前运行部署和经 SourceManagementService 验签的 manifest 必须一致；缺版本、错 Commit/digest、partial、未绑定、读取期间换版本/撤权、model egress 禁止均关闭内容返回。没有 main/ref fallback；源码只声明 implementation-intent / rootCauseVerified=false。
- 没有改动源码同步、快照发布或部署绑定模块。复用 PR157 已核验 sync 证据；本轮另运行真实签名快照/正式 SQL 配置/实际 SourceManagementService 读取，未重新执行 POST sync，不将此项当作 sync 端到端。

未修改 T08 告警/Analysis、T11 feedback、共享 server/contracts/迁移/CI 注册或授权/Session/executor/DirectAdapter 核心。公共 platform observations HTTP 响应保持既有契约。

## 验收证据

最终本地领域 gate：16 文件 **133 passed / 0 failed / 0 skipped**，包括新增 10 项真实隔离 MySQL 测试、21 项直接单元测试及相关回归。原 20 项 focused 和首次 SQL 9 项为历史检查，最终结果不累计重复计数。

真实 SQL 使用本次独占 `mysql:8.4` 临时容器、唯一 schema、两次正式 MigrationRunner，无生产数据库访问；结束后 schema 删除、容器优雅停止并自动删除。

| 要求 | 当前证据 |
|---|---|
| 持久原始错误先于自动 admission | SQL 原事实写入后 operational_events / investigations / agent_runs 均为 0；后台 deliver 后才创建事件/调查 |
| 重启后原事件可查询 | 新服务实例重投与读取；独立 Node+tsx 进程以真实 live actor 查回同 sourceEventId/contentHash |
| 投递幂等/冲突 | 100 并发同键只有一条原事实，后台重复 deliver 只有一条事件/调查，变更内容拒绝 |
| 400/403 | 真实 TCP HTTP 不提交事件；显式内部投递仍持久并 STATUS_EXCLUDED，不创建调查 |
| Agent 故障防递归 | agent / investigation job / intake job 原始事实摄入后 ORIGIN_LOOP；0调查/0Run。worker hook 不再发布摄入自身失败 |
| 实时撤权 | 真实用户 JWT+HTTP，SQL 撤 config:view 后同 JWT 返回404，不发送原事件；System 工具也拒绝旧 caller |
| 源码版本/egress | 实际签名 manifest+SQL source policy+SourceManagementService：精确 Commit 可读取，禁 model egress/错 Commit/部署缺失返回 gaps |
| 数据库失败/限流 | 无 store 的写入失败计数；有界 pending/溢出/冻结输入由受控单元场景证明，不称为持久 spool |
| 响应不等 SQL | 单元 Fastify 注入：SQL仍 pending 时已有503响应；不称为生产负载性能验收 |

命令（仓库根）：

```bash
pnpm --filter slide-api exec vitest run \
  src/investigations/system-event-bridge.test.ts src/investigations/system-tools.test.ts \
  src/investigations/system-event-bridge.mysql.test.ts \
  src/platform/deployment-binding.test.ts src/platform/source-snapshot-service.test.ts \
  src/platform/platform-observation-service.test.ts src/platform/runtime-events.test.ts \
  src/platform/structured-log-evidence-adapter.test.ts \
  src/workflows/worker-platform-observation.test.ts src/workflows/worker-runtime.test.ts \
  src/workflows/worker-cancellation.test.ts src/collector-failure-isolation.test.ts \
  src/collector-due-only.test.ts src/server-collector-filesystem.test.ts \
  src/network-devices/network-device-collector.test.ts \
  src/tools/generated/slide-self-mgmt/platform_tools.test.ts
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm security:scan
git diff --check
```

API typecheck、contracts、secret scan、diff check 通过。没有新增外部模型调用；沿用原 DeepSeek 5/6 成功停发且不转授/重置。家族 token/cost 实测不可用，未冒充0或内部预算统计。

## 共享装配最小移交请求

以下 **没有应用**；依据 MAX-150 v1.2.16，父须核验 T08 当前 PR/merge/文件释放后授予，再由原 owner 续接。

1. `apps/db-ops-api/server.ts`（启动/关闭约5500行）：加载受限 service identity 及可信 System policy，构造本 bridge/publisher，显式仅授权测试/灰度配置安装；关闭时停止采集后 drain/uninstall。零隐式 admin/生产自动开启。桥接原事实必须由同一实例的正式迁移后的 pool 落库。
2. `apps/db-ops-api/src/workflows/register-workflow-handlers.ts`：新增可选 `systemEventBridge` 依赖；仅配置时 `registry.register(SYSTEM_EVENT_JOB, bridge.handler())`。绑定 source/component/policy/actor 不来自 job payload。handler 复用现有 Worker lease、重试、completion。
3. `apps/db-ops-api/src/investigations/executor.ts`：可选 server-bound `systemToolsForInvestigation(actor, requestSnapshot)` callback；仅 System 请求使用此 registry，并在每次 live tool 重新创建。factory 从可信 request context/linked events 取调查ID/component/window。保留 canonical/fence/预算/终态 owner。将新增四个源码工具的后台准入限制到此专属 registry，**不能直接给现有普通 platform_tools handler 加 BACKGROUND_SAFE**，否则会绕过原事件 Commit 边界。普通 Chat/其他 Profile 沿原 registry。无需改 DirectAdapter 的普通执行接口。
4. `server.ts` / T08 事件中心注册（具体文件随 T08 已合并最终差异核验）：只读 System 事件/原事实 HTTP 入口消费既有实时权限，suppressed 事件也可查；不得通过 service caller 暴露未授权原件。公开 schema/生成类型如需新增，串行处理 contracts 注册。
5. 当前 CI backend 自动发现新增 `.test.ts`（SQL test 不 skip）；正式共享 qualification 注册待移交，可将独立 SQL gate 并入对应测试命令并保留准确 head CI。不得用本次测试 fixture 路由作为生产接入。

未完成：上述生产入口、正式 System admission→executor→canonical evidence/result→HTTP/WS/浏览器继续追问链路、真实 Provider System 证据消费、父独立 Review、普通 merge/main 包含核验和 T12 总 gate。领域部分交付进入 in_review；不标 done、不释放下游依赖。主任务已有确切运行的一次性 terminal handoff wakeup，不重复创建/触发父或子 run。

托管起始 `6fa44775` 和用户修改原样保留；功能 PR 从核验 main 生成仅任务文件的提交树，托管分支不 switch/reset/force，私有 .multica 与用户 AGENTS 不进入 PR。


## v1.2.18 正式共享装配（当前候选）

T08 PR163 合并 `1091de79cbc4e4a655af28e072934ee4a38c8d12` 后，父已移交共享入口。本节覆盖上文“没有应用”和“待移交”的当前状态；原领域结果与失败历史保留。

- `server.ts` 正式构造 `system-composition.ts`，每个 API 进程安装持久事实 publisher，仅 leader 注册摄入 Worker/executor。启动失败清理及关闭显式 uninstall 后 drain。`INVESTIGATION_SYSTEM_EVENTS_ENABLED`、`INVESTIGATION_SYSTEM_AUTO_ENABLED` 分别控制记录和派生，均默认关闭；自动派生要求记录开启。显式 `INVESTIGATION_SYSTEM_SERVICE_USER_ID` 使用已预配的 service 身份，不创建账户/角色、不继承 admin；不可变权限 ceiling 仅 chat:view/config:view、空资源边界。
- Workflow 正式注册 `system.event.ingest`；System executor 从 immutable request snapshot 固定 investigation/component/window，每次工具调用重新加载 live actor 并重建专属 registry。没有 callback 时空 registry，禁止回退普通 platform tools；现有授权、事务、admission、ledger、Run/canonical owner 不变。
- 原始事实与 suppressed 事件经 `/api/platform/system-events` 和 `/:id` 只读返回，实时 System 权限、private/no-store、正文 hash 核验；仅拥有原调查 ACL 的用户收到 investigationId。事件中心“平台异常”复用共享组件，支持原始事实、刷新、合法调查链接；撤权清空，旧异步请求不得回写。
- 模型 manifest 只提供经验证的版本绑定、完整性、验证状态和文件数量；完整签名清单仍由既有 SourceManagement 保存并验证。System 历史 assistant/tool 组投影为 reference authority 的 hash/消息ID引用并要求重新读取，完整 canonical 历史与证据仍持久保存。软压缩水位设为1以避免未计量的 summary 调用；16k硬上下文上限和32k预算未放宽。

### 当前本地证据

| 检查 | 结果与边界 |
|---|---|
| 最终 focused | 13文件143通过，0失败/0跳过；包含13项独占Docker MySQL、重复正式迁移、JWT真实TCP HTTP、独立进程事实恢复 |
| 安全回归 | 17文件187通过；不重复计入focused |
| 执行恢复真实MySQL | 102通过，1项原环境条件跳过；另以T04_BROWSER_TEST=1 focused执行该真实Chromium HTTP/WS断开测试，1通过（其余102按名称过滤）。两次合计覆盖103个不同用例，未伪称原运行0skip |
| 正式调查浏览器回归 | 50通过；49项既有调查/数据库桥接+1项System正式装配链路 |
| System新链路 | 持久HTTP_503→admission→executor→原错误/精确签名源码→canonical evidence/result→事件HTTP→WS Workspace→两次追问；3个不同completed Run、结果版本1/2/3，Provider每轮实际收到原事实与精确源码。Provider及源码内容为受控fixture，非外部真实模型 |
| 权限与降级 | suppressed可读、调查链接遵循ACL；实时SQL撤权后相同JWT拒绝。400/403不触发、防递归、Commit/manifest/egress及缺口场景由真实SQL与直接测试覆盖 |
| 响应隔离 | 真实TCP HTTP在持久store SQL人为阻塞时已返回503；不把受控故障注入称为生产负载性能验收 |
| 静态门禁 | API/frontend typecheck、frontend build/CSP、contracts、security scan、qualification matrix 37/37、diff check通过；build已有chunk size提示 |

`bash scripts/qualification/run-investigation-system.sh` 执行System浏览器验收；`--regression` 执行真实MySQL恢复（显式开启T04_BROWSER_TEST）及全部调查浏览器；`--streaming` 执行原100ms streaming门禁；`--recovery-browser` 可单独验证该条件Chromium用例。所有容器/fixture在前台收集完成后关闭，无生产操作。

### 原 CI 失败诊断及出口限制

旧PR165 head `ebfce6f3450d196da3f1e1973651186998aa5ed0` 的 CI `38391559605` 为6成功/1失败/1跳过，原 streaming accepted→actual 144.5ms超100ms。旧wire/trace没有失败时的browser receive与server分段时钟，无法证明SQL或浏览器环境根因；相关核心与旧main相同且fixture未安装System publisher。保留原产物与失败历史，不重跑旧CI、不放宽100ms、不skip。新增 gate前 startup-boundary产物（server frame/phase clock及browser clock），本地隔离MySQL同项33.2ms、server run.started→waiting_model 33.52ms通过；这不证明旧失败已根治。新head CI与准确提交绑定证据由PR和最终交接附件记录。

源码同步/快照发布/部署绑定未改，仍复用PR157父核验；本轮签名fixture与实际SourceManagement读取不冒充POST sync端到端。零新增外部模型请求/子代理/Issue/生产操作；DeepSeek原5/6成功停发保留，可靠token/费用实测不可用。

本次交付可进入in_review，完整出口仍缺真实Provider消费验收、父独立Review、准确head全部CI、正常merge/main核验及T12总gate；未齐备不标done、不释放T10/T12。父已登记本run唯一终态handoff，不重复启动父或创建wakeup。


### 共享装配首个 CI 的启动夹具修复

共享候选 `8b3cdb05d7be76fff89ec0d354af79231528beee` / CI `38405825949` 为4成功/1失败/3跳过。后端全量3354通过、1失败、615既有条件跳过；T09的13项真实SQL测试已执行通过。唯一失败是 `lifecycle/metric-quality-startup.test.ts` 抽取正式 `startWorkers` 后没有提供由 `initializeApi` 新增的 `systemComposition`，报ReferenceError。本次装配触达的夹具依赖遗漏，已在该测试提供默认关闭的composition；原“首次/重复启动不得修改指标历史”断言、SQL路径及全部CI门禁不变。该直接回归1项通过；另2项既有MySQL opt-in未在此focused执行。原失败head不重试，修复head再收集准确CI；不将此首个CI的qualification跳过宣称通过。


## v1.2.23 一次性追加授权与真实复验失败

Max 授权评论 `01a13794-14e8-7972-84d2-dceb59de6552` 允许原 T09 场景加复验累计最多32000 token、最多3次新HTTP、每次输出不超过2048，失败即停。复验仍使用共享DB只读配置、原Provider factory和现有deepseek-flash；业务写入只在独占正式MySQL与合成签名源码中完成。

`system-real-provider-budget.ts` 初始化必须显式传入本追加授权及下载的旧journal。验证旧SHA256 `5469172ebc7d9135248ec93c357202e76d966c20fe1fe5fed9abab84e3c40377`、2次已收据请求、2469 input/612 output/640 cached与stop；新journal引用旧3081 token基线，不重开旧账本或partial Run。初始化先用独占文件及fsync领取一次性授权，再创建新场景；中断/未知usage/锁或账本损坏失败关闭，不自动初始化替代场景。后续每次HTTP前以跨进程锁/fsync计数，保守输入字节上界+输出预留+累计已用不超过32k；缓存已含在input，T04原5次与未知token历史保留。

新真实复验发送2次HTTP200，input2496+output474=2970 token（cached1152含于input）；T09合计6051 token，历史5次加旧T09两次加复验两次合计9请求。模型自主选择全部五个工具，收到原错误/manifest，源码结果已产生并持久化，但第三次HTTP前以CONTEXT_UNRECOVERABLE结束，未生成最终回答。新场景stop保留，不使用剩余一次请求、不重试。实际供应商费用与家族token遥测不可用；本轮ledger3444 microUSD仅配置估算。

零调用诊断发现：16k上下文、2048输出和1024安全余量提供12928输入预算；此前离线估计漏计了完整reasoning/消息ID/运行时钟，真实路径会越界。保留全字段和原源码，仅将成功System工具JSON结果改为紧凑序列化，减少格式空白；结构化SQL receipt保持完整，失败对象保留原错误语义，恢复已返回工具采用同一表示。未增加上下文/调用预算、未放宽准入、未删除事实、reasoning或版本关联；没有修改源码同步链路。

新增正式MySQL回归覆盖两个工具批次、全部五项工具、真实签名源码、reasoning与最终模型输入，旧代码partial/CONTEXT_UNRECOVERABLE，修复后受控completed；completed SQL故障后新进程/新fence恢复与终态重投只生成同一Run/一版结果/五份证据，不重发Provider。该受控回归及离线诊断不能替代修复后的真实复验。本次真实Run仍partial；planned真实completed存储故障未触发。父审查、修复后真实复验、准确新head CI与普通merge/main仍是完整出口，T11/T10/T12未释放。
