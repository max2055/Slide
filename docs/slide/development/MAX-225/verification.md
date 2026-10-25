# MAX-225：三类资源自动告警准入检查点

2026-10-26；本次为部分交付，真实业务验收与完整 gate 尚未完成，不应合并/发布或视为已解决。

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
| 三类单条 critical 自动且仅创建一次 | 真实隔离 MySQL + 正式迁移，三类均从共享保存入口创建 owner/request/job；重复恢复不加 job | 已验证准入，不包含真实采集/模型执行 |
| 不满足配置/身份/权限/范围/预算时抑制且不发模型 | 总开关/通道/级别/范围/配置无效的 SQL 检查通过；既有真实权限撤回回归通过；时窗边界/跨夜单测通过。新增预算拒绝专项因 Docker 中断未执行 | 部分验证；预算专项待重跑 |
| 重复/重启零重派，unknown 不重放 | 桥实例重建后同 investigation/job；事务提交/回滚恢复；既有 unknown owner 回归与 1/2/10 连接池检查 | 已验证现有路径；最终完整 gate 待补 |
| 真实 VM → 告警 → 自动受理 → 有引用有效结论 → 恢复/实测用量 | 读取现有资源清单成功；后续验收脚本在采集前 ETIMEDOUT，Docker daemon 的只读查询也超时 | 未完成，无模型发送 |

最终独立检查：告警/策略 6 文件 61 项通过；调查模块 42 文件 380 项通过、1 文件/37 项跳过；API typecheck、contracts:check 通过。较早 SQL 专项 10 项通过，当前生产逻辑与该次一致；此后仅新增预算拒绝测试及验收脚本 stage 字段。新增预算拒绝用例仍未运行，不隐去这一缺口。完整受影响模块 gate 在 MySQL fixture 初始化超时后终止，不宣称全绿。

## 环境阻塞和恢复

Docker Desktop 在完整模块回归期间停止响应；后续 `docker ps` 8 秒超时，共享 MySQL 连接 10 秒 ETIMEDOUT。不能据此判定真实 VM 本身不可达。仅终止了已核对属于本 worktree 的测试进程，没有重启 Docker、共享 API 或共享数据库。精确测试容器清理请求也在 15 秒超时，待清理名称在 `cleanup.json`，仅可停止这些容器，不按名称前缀批量停服务。

最小恢复条件：由共享环境所有者协调恢复 Docker/MySQL 可用性，然后用一个共用、可清理的隔离 MySQL 串行执行 SQL 回归，避免再并发创建多个 MySQL 容器。重跑新增预算拒绝检查、完整 gate；继续真实 VM 采集及真实模型结论验收。`apps/db-ops-api/scripts/qualify-automatic-alert.ts` 当前只覆盖无模型采集/准入/自然恢复段，显式传入 `MAX225_CONFIG_ENV`、`MAX225_EVIDENCE`、可选 `MAX225_SERVER_ID`；共享库仅 SELECT，其余写入隔离库，不制造 CPU 压力、不改共享配置。脚本本轮未越过采集前阻塞，不能作为成功证据。

真实模型发送前，仍必须按父单唯一 `model_test_budget_ledger` 预留并回读，再以 Provider/Runtime 实测结算；不复用历史测试账本。父账本本次读取 revision 3，实测发送 0、结算 0、预留 0、unknown 0，未修改账本，没有生成测试 token 或费用估算。
