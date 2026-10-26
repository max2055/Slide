# MAX-225：三类资源自动告警准入检查点

2026-10-26（第三轮）：真实 VM 采集→critical 告警→自动受理→真实模型有引用结论→自然恢复已全部跑通，用量在父单唯一账本中预留、回读并实测结算。

## 第四轮：当前 CI 门禁修复（2026-10-26）

- `tests/qualification/investigation-rollout.ts`：自动通道关闭后不再断言 legacy 回落。改为断言桥返回 `suppressed` / `AUTO_ANALYSIS_LANE_DISABLED`、新告警的 `ai_analysis` 与 `investigation_alert_owners` 均为 0 行、legacy 回调 0 次、付费请求 0 次；同时保留已受理 owner 在关闭与恢复前后的同 investigation 断言及真实 SQL 校验。
- `apps/db-ops-api/tests/event-aggregation.test.ts`：补上恢复路径依赖的 `pool.query`，fixture 改为当前代码实际读取的单条告警行；断言创建 1 个事件、3 条成员关联与日志内容，并新增“单条告警不建展示事件”和“恢复扫描失败不阻断独立聚合”两条用例。
- `apps/db-ops-api/src/event-aggregator.ts`：恢复扫描失败只记录告警并继续事件聚合（工作流取消仍优先抛出），避免把独立的展示聚合与自动准入绑定；准入仍由告警持久化路径负责。
- 门禁证据：`vitest run tests/event-aggregation.test.ts` 6/6 通过、API typecheck 通过；rollout 资格用例依赖隔离 MySQL，按本轮串行约定交由 CI 执行。

## 第三轮：真实模型结论与可审计用量

`apps/db-ops-api/scripts/qualify-automatic-alert.ts` 增加显式模型段（只有 `MAX225_REAL_MODEL=authorized` 才执行，默认不发送）。它复用同一隔离 schema 中已受理的 `investigation.execute` 作业，用既有 `InvestigationExecutor`、既有 Provider 配置（共享库仅 SELECT）和真实 DeepSeek 路由执行，结果见 `vm-acceptance-model-20261026.json`。

| 原验收 | 本轮证据 | 状态 |
|---|---|---|
| 真实 VM → 告警 → 自动受理 → 有引用有效结论 → 恢复/实测用量 | 见下 | 已验证 |

- 采集：真实 SSH 读到 `linux.cpu.user_system_percent`=9.1%（quality good / exact / measured），据此设阈值 8.645；下一次真实采样 0% 自然恢复（`resolved_at` 有值）。
- 受理：单条 critical 告警 `tags.auto_analysis`=accepted，`investigation_alert_owners` 恰好 1 行、`lane='investigation'`，旧 lane 0 次。
- 真实模型：3 次 HTTP200（序列 1/2 为 `tool_calls`，3 为 `stop`），模型各轮调用 `get_resource_observations`、`get_server_alerts`；`agent_runs.state=completed`，`investigation_results` 1 行，7 条 claims 全部引用本次 `investigation_evidence`（3 行）中的 evidenceId，结论明确写单位/口径未知与证据缺口，未宣称根因或恢复。
- 用量：Provider 实测 input 7201（其中缓存 4736，作为子集不重复计入）+ output 4090 = 11291；产品侧 `investigation_budget_ledger` 同时为 `settled`、`charged_tokens=11291`，与实测一致。
- 父账本：每次发送前写入唯一 reservation（input 上界＝请求字节+1024，output 上界＝请求内 `max_tokens`≤4096）并回读确认后才发送；响应后按实测结算。累计 settled 57,478/10,000,000，无未结算预留；1 条未拿到响应的发送保留为 unknown（15,367 预留额，`MODEL_TRANSPORT_UNKNOWN`），按策略不重放。
- 逐次可追溯性：**只有最终成功运行的 3 次发送**保留了完整 Provider requestID、请求哈希、上下界与逐次 usage；此前 16 次响应的逐次明细在父账本 8KB 压缩时只留下总量，现有产物中仅能恢复其中 5 个 reservation id、2 个 Provider requestID 及若干尝试级用量聚合。这两组 ID **可能指向同一次发送**，不能相加作为互斥计数，因此只能确认“至少 9 次没有任何已恢复标识”，无法精确到 9 或 11。恢复范围与缺失项见 `model-budget-journal-20261026.md` / `.json`；不声称全部 19 次响应均逐次可追溯。
- 汇总口径：57,478 settled 只来自 19 次有响应并已结算的发送；未知发送的 15,367 预留额单独保留、不包含在 settled 内（含 unknown 的总占用 72,845，但 15,367 是上界）。
- 尝试 M 的 `Connection error` 只按已有运行记录解释：其 4 次已记录发送全部结算，M 之后 reservations 为空且 unknown 仍只有 G 的 `a37ad0e6`，因此产生该错误的 fetch 调用在 reservation 持久化前即被拒绝、没有进入 HTTP，不构成新的未知发送；具体是哪项预发送检查失败已不可恢复（SDK 用通用消息替换了原始异常）。完整推理与限制见 journal 的“尝试 M 的 Connection error”一节。

### 发送前约束（脚本内强制）

- 端点/方法/model/非流式/`max_tokens≤4096`/请求体不含密钥任一不符即不发；
- reservation 写不进去就不发（失败会以 `MODEL_LEDGER_RESERVE_FAILED_*` 明确报错，不会被 SDK 的通用 "Connection error" 掩盖）；
- 响应无 usage 或非 200 时保留全额 unknown，不重试、不重放。

### 本轮发现的既有运行限制（未在本单修改产品代码）

1. 生产默认上下文窗口 16000 时，模型一轮发起两个只读工具调用后，下一轮触发上下文治理并失败（`CONTEXT_UNRECOVERABLE` / `CONTEXT_GOVERNANCE_ERROR`），本次验收因此把限定运行设为 `INVESTIGATION_CONTEXT_WINDOW_TOKENS=60000`（在 provider 实测 capability 1048576 之内）与 `INVESTIGATION_SUMMARY_OUTPUT_TOKENS=2048`（`summaryMaxTokens` 默认 10240 超过该 provider `maxOutputTokens` 4096，本就无法通过校验）。生产默认值未改，是否调整属另外范围。
2. 父单 metadata 总量已接近 8KB 服务端上限（三个 key 合计约 5.8KB 后仍会随发送记录增长），单次结算写入曾因超限失败并留下一条 reservation；已按授权把静态说明与历史逐次事件收敛为总量+证据引用，账本数值未丢失。**但“证据引用”并不完整**：先前 16 次发送的逐次事件被折叠为 `s_hist`，parent note 声称其逐次明细在 MAX-225 证据中，实际只在证据里保留了最终 3 次；已在 `model-budget-journal-20261026.md` 中如实记录可恢复部分与缺失，未改写父账本。

### 环境说明

本机 Node 进程到 VM 桥接网段缺少可用 scoped route（`EHOSTUNREACH`，而系统 `ssh`/`nc` 可达），因此采集阶段使用本机 `192.168.49.1:2222 → 192.168.49.130:22` 的临时 TCP 转发；SSH 会话仍终结在真实 VM，凭据、操作系统与指标均来自真实主机。转发信息记录在证据 `sshRelay` 字段，转发进程在验收后停止。该偏差不影响告警/受理/模型/恢复各环节的真实性，但不宣称本机网络路径等价于生产。

## 目标和实现（第一、二轮，保留为历史）

源码候选 `442ad300c`，任务分支保留起点 `e004b772a`。已复用父候选中 MAX-226 的规则/维度隔离与 MAX-227 的指标修复，未搬入其运行时快照。本单新增源码提交为 `5c73b1d01`（RED）和 `442ad300c`（修复）。

三类资源均通过 `AlertDatabaseService.createAlert` 保存，写入同事务待受理标记；自动提交后统一调用现有 RCA/调查桥。显式事务只在提交后由周期聚合入口恢复。旧聚合器只承担数据库展示聚合，不再负责触发分析，不把空 instance_id 的服务器/网络告警分到同一组。

桥在占用的同一 SQL 连接上读取 `auto_analysis_config`，fail-closed 检查总开关、级别、运行进程本地时窗（含跨午夜）、数据库白名单；服务器/网络的资源列表继续来自专用服务身份配置，不以相同数字 ID 扩展范围。自动通道关闭会明确抑制，不再新建旧版自动任务。新任务仍由 Workflow Worker 执行，保存告警不直接调用 Provider。

沿用明确策略 `criticalSingle=true`、`threshold=1`：包含在级别配置中的单条 warning/error/critical 可以进入准入，之后仍受资源身份、实时权限、冷却、有效预算约束。并未添加另一个隐含的 critical-only 策略。服务身份从可信配置读取，交互管理员不能替代；恢复自动意图及复用链接重新核验原服务身份、范围、实时权限。手动入口不能执行被当前策略阻止的冻结自动意图。

既有持久 owner、事件幂等键及预算/outbox 继续承担只创建一次。已完成的旧自动分析也直接复用，未知请求不重放；新旧 lane 不互相接管。恢复只扫描新写入的 pending 标记及可证明尚未受理的基础设施错误，不批量回放历史无标记告警。

## 与 MAX-228/#252 的事实来源

- 配置：现有 `system_config.auto_analysis_config`，不新增第二份总开关配置。
- 运行策略：`automatic-alert-policy.ts`、`investigationBridgeFlags()`、`databaseAlertPilotConfiguration()` 与有效预算服务。
- 最近受理结果：`alerts.tags.auto_analysis`，包含 status/reason/investigationId/analysisId/requestId/attemptedAt。
- 身份、所有权、事件、预算：现有 owner、operational_events、requests、ledger、workflow_jobs。tags 只记录展示事实，绝不授权。
- 尚未写回 receipt 的 pending 是待核对，不代表已启用或模型已调用；suppressed 不是成功。

## 验证与逐项验收

详细计数见 `checks.json`；各轮有重叠，不相加冒充唯一测试数。

| 原验收 | 当前证据 | 状态 |
|---|---|---|
| 三类单条 critical 自动且仅创建一次 | 真实隔离 MySQL + 正式迁移，三类均从共享保存入口创建 owner/request/job；重复恢复不加 job（本轮 11 项通过） | 已验证准入 |
| 不满足配置/身份/权限/范围/预算时抑制且不发模型 | 总开关/通道/级别/范围/配置无效检查通过；真实权限撤回回归通过；时窗边界/跨夜单测通过；**此前未执行的预算拒绝专项本轮已执行并通过** | 已验证 |
| 重复/重启零重派，unknown 不重放 | 桥实例重建后同 investigation/job；事务提交/回滚恢复；既有 unknown owner 回归与连接池检查 | 已验证 |
| 真实 VM → 告警 → 自动受理 → 有引用有效结论 → 恢复/实测用量 | **全链路已验证**（`vm-acceptance-model-20261026.json`）：采集→告警→自动受理→真实模型 7 条引用结论→自然恢复，父账本实测结算 11,291 tokens | 已验证 |

### 真实 VM 段（2026-10-26 第三轮）

脚本 `apps/db-ops-api/scripts/qualify-automatic-alert.ts` 以真实 SSH 采集 server #3（192.168.49.130，kylin）：

- 真实观测 `linux.cpu.user_system_percent` = 9.1%（质量 good，exact，measured，SSH 尝试 succeeded），据实设阈值 8.645。
- 规则触发后创建单条 critical 告警，`tags.auto_analysis` = `{status:"pending", reason:"accepted", investigationId:d554fd8c-…}`。
- `investigation_alert_owners` 恰好 1 行，`lane='investigation'`，同一 investigation_id；旧 lane 调用 0 次。
- 下一次真实采样回落到 0%，告警自然恢复（`resolved_at` 有值），无人工写入观测、无伪造数值。
- 共享库仅 SELECT（sharedWrites=0）；本轮模型请求 3 次，全部经父账本预留与结算。

脚本前两轮修复了三处使其无法越过采集的真实缺陷（此前被误判为纯环境阻塞）：`runPackage` 选择项缺 `overrides:{}`、评估器健康门 `dbConnection.isConnected()` 未指向隔离池、以及从未上报采集能力导致正式指标读取 `capability_unknown`。另外空载 VM 合法返回 0%，改为继续观察真实非零样本而非断言失败。

### 受影响模块 gate（第二轮，产品源码自那之后未再改动）

本轮（第三轮）只改验收脚本 `qualify-automatic-alert.ts`，未改产品源码；脚本改动后 `tsc --noEmit` 通过，因此沿用第二轮针对同一产品源码的完整 gate 结果：

并行运行时出现 5s 超时/钩子超时（容器并发争用），以 `--maxWorkers=2` 串行复跑后全绿：

- investigations：56 文件 552 通过、362 跳过
- metrics：44 文件 442 通过、121 跳过
- alert 相关 9 文件：8 通过 1 跳过，47 通过、28 跳过
- workflows：15 文件 116 通过、45 跳过
- 准入专项：11 项通过（含新增预算拒绝用例）
- API typecheck、contracts:check 通过

并行失败属环境争用（同一容器并发启动），串行复跑全绿；不据此宣称任意并发度下稳定。

## 未完成项与限制

- 功能验收无未完成项。第一、二轮记录的"CLI 无 metadata 写入能力"为旧版 CLI（`/opt/homebrew/bin/multica` 0.6.5）导致；当前生效的 0.7.0 CLI 具备 `issue metadata get/set`，本轮据此完成预留与结算。
- **预算审计证据不完整**：最终 3 次发送有完整逐次记录；此前 16 次响应只能恢复总量、5 个 reservation id、2 个 Provider requestID 和尝试级聚合（两组 ID 可能重叠，不能当作互斥拆分），其余逐次字段已不可恢复（详见 `model-budget-journal-20261026.md`）。按策略不为补证重发模型请求；累计 settled/unknown 数值不受影响。
- 生产默认上下文窗口 16000 下的多工具轮次治理失败（见上）属于本次验收暴露的既有运行限制，未在本单修改产品代码，也未在生产配置上验证修复。

## 环境状态

Docker 正常，共享 MySQL 3306 可达，正式迁移可执行。本轮验收用的隔离 schema 由 `bridgeTestFixture` 创建并在结束时删除；未停止任何非本任务容器（验收结束时另有 `slide-t08-*` 容器由并行任务创建，未触碰）。

## 真实模型发送前的约束（沿用）

真实模型发送前，仍必须按父单唯一 `model_test_budget_ledger` 预留并回读，再以 Provider 实测结算；不复用历史测试账本。本轮全部发送均遵循该流程，账本累计 settled 57,478/10,000,000，1 条未知响应保留预留且未重放。
