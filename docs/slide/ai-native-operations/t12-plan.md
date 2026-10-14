# T12 最终集成实施计划

> **Execution:** 在 MAX-153/v1.2.31 已批准范围内执行；不派生代理，不进行生产操作。父任务负责独立复核和最终合并。

**Goal:** 对已合并 T01–T11 运行最终 V1 gate，补齐灰度、恢复、故障负载和操作交接证据。

**Architecture:** 复用现有正式迁移、调查事务、Worker、DirectAdapter、权限与浏览器夹具。新增验收入口和恢复 spec，不建立第二个执行 owner。测试资源/Provider 受控；既有真实模型证据按源码及产物哈希复用。

**Tech Stack:** TypeScript、MySQL 8.4、Fastify、JWT、WebSocket、Lit、Playwright、pnpm 11.19.0。

## 1. 基线和证据

- 从 main `c87a4fcaf2dc0f1cf9e0fbe7c0382c9027272d74` 的隔离分支实施，保留托管历史分支及其用户文件。
- 回读父输入、T10/T11 原始附件并校验 SHA256；模型 ledger 只读核对 stopped/no pending、递归历史和累计 214644 token/153 请求。不新增外部模型发送。
- 先运行 investigation contracts/executor/budget focused baseline，预期零失败。

## 2. 独立资格入口

- 新增 `tests/qualification/investigation-rollout.ts`：仅接受独占 MySQL，保存版本化 JSON；重复正式迁移、只读工具、10k 同事件并发重投、一组故障单 owner/单付费预留、自动/手动配额、三类 cohort 开关回切、证据清理、10000 调查/100000 事件容量采样与 trace 指标。
- 新增 `scripts/qualification/run-investigation-rollout.sh`：创建独占 MySQL 8.4、限时等待、提供全部调查 SQL 环境变量、执行资格入口/调查 SQL gate/Chromium；退出优雅停止本脚本容器。失败非零，不跳过调查 SQL。
- 完整 gate 运行 agent-core/API/frontend 测试、frontend typecheck/build、contracts、qualification matrix；涉及发布再运行 security:agent/release:security-gate。原始日志保留失败历史并分类，不用跳过/健康探针替代。

## 3. 恢复浏览器

- 新增 `frontend/e2e/investigation-recovery.spec.ts`：所有浏览器关闭后后台 durable result；断线/刷新及游标保留期恢复无重复；raw 到期 410 保留引用；Provider 故障保持原事件、终态与零自举循环。
- 仅扩展 `frontend/e2e/fixtures/investigation-server.ts` 的测试故障注入开关；纳入 `frontend/playwright.investigation.config.ts` 和 CI 原隔离 gate，保存 JSON 回执和截图。

## 4. 交付

- 新增 `docs/slide/ai-native-operations/t12-runbook.md`、`t12-validation.md`：A01–A18 逐项证据、灰度/停机/恢复/回滚记录、操作者培训和明确停止条件。13.4 是提案，实际环境与延迟单列，不能冒充生产 SLO。
- 保留 T11 数值 unscored、DB06/NW05 原失败、软目标未测和盲评 unavailable；复用 Max 已接受定性决定。
- 源码、原始报告、哈希与环境记录打包到规定 outputs；独立 PR 写当前范围和完整验证，准确 head CI/父 Review 待齐时不声明完整合并出口。
