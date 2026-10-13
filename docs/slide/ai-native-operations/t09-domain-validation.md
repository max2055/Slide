# T09 System 领域与共享装配验收

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
