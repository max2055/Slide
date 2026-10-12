# T01 当前验证与测试基线

日期：2026-10-12（Asia/Shanghai）。独立分支 `codex/MAX-142-contract-baseline`，从已合并 R00 的 main `730b0bc1564efd72c21066d73e560db28288e434` 建立；相对 Review 源码 `fb0766d6` 的 main 增量只含 R00 规则/材料，无业务变化。Node v24.18.0，pnpm 11.19.0。

本记录对应本 PR 的契约/生成代码与固定样本。已有代码及依赖未变化的结果复用；新 schema 和测试修改后已重跑受影响契约/生成/类型检查。原始本地日志不作为跨环境交付，脱敏机器结果及准确测试命令见 [t01-baseline-results.json](evidence/t01-baseline-results.json)。

## 验收结果

|检查|当前结果|
|---|---|
|T01 specified acceptance|3 个文件，37 通过、0 失败、0 skip|
|existing backend baseline|21 个文件，225 通过、0 失败、0 skip|
|public API and shared projection|4 个文件，33 通过、0 失败、0 skip|
|existing frontend baseline|7 个文件，60 通过、0 失败、0 skip|
|navigation baseline|2 个文件，4 通过、0 失败、0 skip|
|`pnpm security:agent`|17 个文件，187 通过、0 skip（与已有基线有重叠，不重复统计）|
|前后端 typecheck、`pnpm contracts:check`|均通过；类型来自同一 TypeBox 源|
|前端 build + CSP|通过；2 个生产脚本 CSP 检查通过；动态/静态导入混用和 >500kB chunk 是既有非阻塞提示|
|focused oxlint、`pnpm security:scan`、`git diff --check`|通过，lint 0 警告/错误；无真实密钥、无无关格式变化|
|固定样本|40 项，12/6/6/8/8；ID 唯一、subject 与支持/反面引用检查通过|

指定验收命令：

```bash
pnpm --filter slide-api exec vitest run src/investigations/contracts.test.ts src/analysis/analysis-envelope.test.ts src/adapter/__tests__/agent-run-service.test.ts
```

合法三类 resource/platform 通过；错误 subject、无依据 resolved、未知→completed/成功/终态重写、伪造/过期引用均拒绝；旧 v1 envelope 原样可读，bound 不升级为根因验证。request.accepted 无虚构 Run，run.terminal schema 排除 running；Parts payload 用共享 frame/reducer。

## 逐文件基线

|测试文件|通过项|
|---|---|
|`apps/db-ops-api/src/investigations/contracts.test.ts`|28|
|`apps/db-ops-api/src/analysis/analysis-envelope.test.ts`|5|
|`apps/db-ops-api/src/adapter/__tests__/agent-run-service.test.ts`|4|
|`apps/db-ops-api/src/ai-analysis-database-service.active.test.ts`|8|
|`apps/db-ops-api/src/ai-analysis-lifecycle.test.ts`|5|
|`apps/db-ops-api/src/ai-analysis-routes.test.ts`|10|
|`apps/db-ops-api/src/alert-evaluator.test.ts`|13|
|`apps/db-ops-api/src/alert-rca-service.test.ts`|7|
|`apps/db-ops-api/src/chat-history-page.test.ts`|2|
|`apps/db-ops-api/src/server-alert-evaluator.test.ts`|3|
|`apps/db-ops-api/src/analysis/analysis-evidence-binding.test.ts`|40|
|`apps/db-ops-api/src/analysis/analysis-provider.test.ts`|5|
|`apps/db-ops-api/src/analysis/analysis-recovery-schedule.test.ts`|2|
|`apps/db-ops-api/src/auth/chat-handler-ownership.test.ts`|11|
|`apps/db-ops-api/src/auth/chat-ownership.test.ts`|10|
|`apps/db-ops-api/src/auth/chat-routes.test.ts`|4|
|`apps/db-ops-api/src/auth/require-instance-access.test.ts`|12|
|`apps/db-ops-api/src/network-devices/network-device-alert-database.test.ts`|4|
|`apps/db-ops-api/src/network-devices/network-device-alert-evaluator.test.ts`|7|
|`apps/db-ops-api/src/network-devices/network-device-alert-route.test.ts`|1|
|`apps/db-ops-api/src/platform/runtime-events.test.ts`|3|
|`apps/db-ops-api/src/workflows/worker-cancellation.test.ts`|6|
|`apps/db-ops-api/src/workflows/worker-runtime.test.ts`|17|
|`apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts`|55|
|`apps/db-ops-api/src/contracts/public-api.test.ts`|10|
|`apps/db-ops-api/src/adapter/__tests__/display-stream-ws.test.ts`|4|
|`apps/db-ops-api/src/adapter/__tests__/display-stream.test.ts`|10|
|`apps/db-ops-api/src/adapter/__tests__/message-projection.test.ts`|9|
|`frontend/src/app/ui/app-chat-cancel.test.ts`|3|
|`frontend/src/app/ui/chat/message-parts.test.ts`|12|
|`frontend/src/app/ui/chat/message-projection.test.ts`|2|
|`frontend/src/app/ui/controllers/chat-acceptance.test.ts`|8|
|`frontend/src/app/ui/views/ai-analysis-result.test.ts`|25|
|`frontend/src/app/ui/views/alerts-analysis.test.ts`|3|
|`frontend/src/app/ui/views/network-device-detail.test.ts`|7|
|`frontend/src/app/ui/app-navigation.integration.test.ts`|1|
|`frontend/src/app/ui/app-navigation.test.ts`|3|

## 失败分类与证据边界

- 本次引入并已修正：开发中新增文件语法、生成类型的浏览器导入路径、request.accepted 夹具错误。最终 37 项指定验收、公开契约/投影 33 项及前后端类型检查通过，不把初次失败隐去。
- 环境问题并已解除：曾并发执行两组使用固定端口的 DirectAdapter WS 测试，出现 426、ECONNRESET 和 mock 调用计数错误。停止自身已完成的测试进程后串行执行，既有 225 项与 security:agent 187 项全部通过；没有改 Adapter/既有测试或强杀其他服务。
- 最终 focused 范围无剩余既有失败；R00 confirmed/pending 门禁仍按 [T01 映射](t01-contract-baseline.md) 保留，单测通过不能把已确认问题关闭。
- 未运行新调查真实 MySQL/provider/SSH/SNMP/浏览器业务链、40 样本模型/盲评及 T12 V1 总 gate；本任务没有新业务入口、迁移或生产部署。合成快照的硬项期望全为 0，尚非模型评估成绩。
- 未新增模型/付费资源调用；实际 token/费用遥测不可用，不估造用量。

CI/审查/正常合并证据对应实际 PR head，记录于 MAX-142 最终交付评论；本文件不预填 CI 成功、merge SHA 或完成状态。仓库 main 当前无 branch protection（API 返回 404），仍按 Issue 要求等待全部 CI 成功且不使用 admin/force。
