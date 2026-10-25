# MAX-225：三类资源自动告警准入检查点

2026-10-26（第二轮，Docker/MySQL 恢复后）；真实 VM 采集→告警→自动受理→自然恢复已验证。真实模型结论与可审计用量仍未完成，不能视为全部验收通过。

## 目标和实现

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
| 真实 VM → 告警 → 自动受理 → 有引用有效结论 → 恢复/实测用量 | **采集→告警→自动受理→自然恢复已验证**（`vm-acceptance-20261026.json`）；有效引用结论与实测用量未完成 | 部分完成 |

### 真实 VM 段（2026-10-26 本轮）

脚本 `apps/db-ops-api/scripts/qualify-automatic-alert.ts` 以真实 SSH 采集 server #3（192.168.49.130，kylin）：

- 真实观测 `linux.cpu.user_system_percent` = 9.1%（质量 good，exact，measured，SSH 尝试 succeeded），据实设阈值 8.645。
- 规则触发后创建单条 critical 告警，`tags.auto_analysis` = `{status:"pending", reason:"accepted", investigationId:def6e7ac-…}`。
- `investigation_alert_owners` 恰好 1 行，`lane='investigation'`，同一 investigation_id；旧 lane 调用 0 次。
- 下一次真实采样回落到 0%，告警自然恢复（`resolved_at` 有值），无人工写入观测、无伪造数值。
- 全程 sharedWrites=0、modelRequests=0，共享库仅 SELECT。

脚本本轮修复了三处使其无法越过采集的真实缺陷（此前被误判为纯环境阻塞）：`runPackage` 选择项缺 `overrides:{}`、评估器健康门 `dbConnection.isConnected()` 未指向隔离池、以及从未上报采集能力导致正式指标读取 `capability_unknown`。另外空载 VM 合法返回 0%，改为继续观察真实非零样本而非断言失败。

### 本轮完整受影响模块 gate

并行运行时出现 5s 超时/钩子超时（容器并发争用），以 `--maxWorkers=2` 串行复跑后全绿：

- investigations：56 文件 552 通过、362 跳过
- metrics：44 文件 442 通过、121 跳过
- alert 相关 9 文件：8 通过 1 跳过，47 通过、28 跳过
- workflows：15 文件 116 通过、45 跳过
- 准入专项：11 项通过（含新增预算拒绝用例）
- API typecheck、contracts:check 通过

并行失败属环境争用（同一容器并发启动），串行复跑全绿；不据此宣称任意并发度下稳定。

## 未完成项与原因

- **真实模型结论（有证据引用）与可审计 provider 用量未完成**。本单子代理无法写入父单权威 `model_test_budget_ledger`（CLI 无 metadata 写入能力），按父策略"无法可靠计量时停止模型发送"，本轮不发起真实模型请求，model sends 仍为 0。
- 若需完成该段，需由持有账本写入能力的 Chief 在预留/回读后授权一次真实调查运行。

## 环境状态

Docker 已恢复：`docker ps` 正常，共享 MySQL 3306 可达，正式迁移可执行。本轮产生的两个遗留测试容器（`slide-t08-68670-…`、`slide-t08-68672-…`）已按名精确停止，未按前缀批量清理其他服务；`cleanup.json` 中上一轮的 4 个容器已不存在。

## 真实模型发送前的约束（沿用）

真实模型发送前，仍必须按父单唯一 `model_test_budget_ledger` 预留并回读，再以 Provider/Runtime 实测结算；不复用历史测试账本。本轮未修改账本、未生成 token 或费用估算。
