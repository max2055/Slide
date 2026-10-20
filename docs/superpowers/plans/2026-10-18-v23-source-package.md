# V23 有界正式来源执行包 Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules. 不委派；沿 PR212，父审准确执行包后才分配真实目标写锁。

**Goal:** 将已批准 source-execution-package-1 契约落实为可运行、失败关闭、可恢复的分阶段来源脚本。

**Architecture:** 专属 schema 内复用 MetricScheduler/MysqlScheduleStore(production)、MetricFormalization、JobRegistry、SQL claim/heartbeat/fence；不用全局 worker。告警与调查沿原服务，计划沿原 JWT HTTP create/submit。外层限制目标、UTC、批量和期限，发送前持久记账，未知不重放。

**Tech Stack:** TypeScript、Zod、MySQL、现有生产服务及 Vitest。

1. 新增 `operations/source-package/config.ts`、`definitions/*.json`：严格配置、固定目标/policy/verifier 与字节摘要、时钟偏差上限2秒/RTT1秒；正反例拒绝重定向、过期及漂移。
2. 新增 `operations/source-package/control.ts`：专属schema检查、跨进程 SQL 锁、单次操作 workflow intent、精确一次 claim、5秒续约/30秒失租停止、截止与取消、审计与未知隔离；不得重放既有operationId。
3. 新增 `operations/source-package/runtime.ts` 与 `scripts/qualification/v23-source-package.ts`：生产采集与正式发布、生产告警与事件调查、真实只读 executor、准确结果/证据到计划 create/submit。当前阶段不实际调用产品模型或接触目标。产品 provider 必须复用唯一 canonical budget，禁止重试/流式旁路。
4. 隔离集成验证：生产 MigrationRunner、SQL竞争/租约/未知不重放、真实 scheduler/store/registry 与合成传输；保留 synthetic 限定，不做SQL enrichment、不重跑无变化B16或旧全量。
5. 交 `docs/slide/operations/v23-source-package.md`：准确命令、配置和种子映射、隔离 schema/备份恢复、API-only租约、helper18文件恢复清单与停机步骤。检查typecheck/契约/秘密扫描/受影响测试，提交推送原PR，留准确head CI及父独立审查接续。

停止条件：目标/配置/hash/权限/时钟/租约不符，或任何发送/usage未知，立即停止新阶段，保留intent与日志；不DROP业务证据，不消费批准、不dispatch。

本地完成状态（2026-10-18）：步骤1～5代码与运行材料已实现；受影响单元检查累计52项通过，专属MySQL8.4上的CI脚本5项通过，另有MySQL9.6生产采集/编排验证。新schema的131条正式迁移记录备份/恢复逐条一致，恢复后无活跃作业、批准或执行。集成发现规则表不存文件系统维度，已在P10受控配置中显式绑定准确规则及维度，通过原评估器内部参数执行，无新增表或第二套算法。必要准确head CI和父独立审查由交付记录接续，不能将本段当作放行；真实来源、调查产品调用、现场时钟修复、helper恢复和准确计划尚未现场执行。
