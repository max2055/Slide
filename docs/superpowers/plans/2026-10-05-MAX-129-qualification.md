# MAX-129 最终资格验收 Implementation Plan

> **Execution:** 按父 MAX-124 已批准的 S1–S5 和 v2 契约实施；不派生代理，父任务唯一合并。

**Goal:** 用真实 WS/MySQL/Chromium 和受控 provider 补齐父任务九项验收证据，交付一个 PR。

**Architecture:** 保留 DirectAdapter、自有 WS、统一 reducer、canonical facts/intent/anchor/完成事务。扩展现有 qualification harness；展示不触发工具重放。

**Tech Stack:** TypeScript、Vitest、Playwright、MySQL 8.4、Lit、Anthropic/OpenAI SDK。

## 执行契约

- 范围 v1 产品 / v2 CI 自动续修；base `599af2040e2fcd6d05d2f252f15ebdd8d4ebe9d1`。原工作树 AGENTS.md/.multica 修改保留，实施使用嵌套隔离 worktree。
- 排除：付费模型质量、生产数据库/部署、无关重构及安全整改。硬预算未设定；实际 token/费用不可用；新增子代理 0。
- 停止条件：真实验收和最终一次项目 gate 有证据，PR 实际关联、当前 head 八项 CI SUCCESS 后 in_review 交父任务。外部不可恢复阻塞准确报告，不放宽阈值/skip。

## 1. Provider 协议回归

在 `apps/db-ops-api/src/adapter/provider-stream-qualification.test.ts` 使用本地 HTTP SSE + 真实 SDK 验证 Anthropic/OpenAI/Ollama（项目采用 OpenAI-compatible 接口）：无 reasoning、thinking 先行、JSON 参数分片、EOF drain。先运行失败样本，再修 `llm-provider.ts` 和 `packages/agent-core/src/openai-provider.ts` 缺失回调。参数分片只展示，执行仍等完整响应。复用既有 stream-boundary 空 reset/idle/重试测试。

命令：`pnpm --filter slide-api exec vitest run src/adapter/provider-stream-qualification.test.ts src/adapter/runtime-provider.test.ts`；预期全部通过，无付费网络访问。

## 2. 真实全链路

新增 `frontend/e2e/streaming-live.spec.ts`，使用隔离临时 schema、真实 DirectAdapter/tool registry、WS、DirectGatewayClient、统一 reducer 和 renderChat。1000 chunks/100KB、新旧双 peer、100工具、快慢工具、刷新/恢复不得增加执行数；MySQL 一条唯一完成消息与 durable 对齐。记录 hardware/browser/SHA、原始 WS 帧/字节和 browser 同钟 receipt→paint，CDP/Playwright trace。测试所有服务在 finally 清理，数据库仅独立 fixture schema。

## 3. 分层验证

开发 focused provider/stream checks；受影响 API/Core 模块；候选一次完整 gate：四模块 test/typecheck、lint、build/CSP、contracts、qualification matrix、security audit/scan、浏览器 audit、runtime deterministic、隔离 MySQL runtime/crash/approval、managed browser recovery/cancel。保留命令退出码与日志，已跳过项不计真实验收通过。S4 未变化的 15组 parse/apply 和后台/阅读证据复用，不反复压测。

## 4. 证据与交付

仓库 `docs/slide/runtime-v2/MAX-129-qualification.md` 收录最终架构/协议、九项验收矩阵、S1–S4 task→PR→head→merge、性能目标/实测、配置/灰度/安全回滚/局限及资源口径。原始证据、trace、校验和打包到统一 outputs，逐包 <300,000,000 bytes。核验 continuous CI rule 后 push，PR 标题含 MAX-129 并回读 issue pull-requests；退出前立即读 checks，失败原 PR 修复；pending 交持久化规则，不自行 merge/done。
