# T09 System 领域交付（共享装配待移交）

日期：2026-10-13。授权：MAX-150 v1.2.16；父 MAX-140 同版本。保留 T09-A / PR157 历史，不重做准备阶段，不把本次领域交付称为完整 T09 出口。

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
