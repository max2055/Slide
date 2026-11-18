# MAX-684 最小权限候选
本轮按 Chief `01a1ebf8-3c26-7d98-bbb6-5e82f688dd57` 和范围审计 `01a1ebdc-aeca-7c03-b34f-7ed21b370d0c` 收敛，不继续性能、监督或归档实验。原权限成果成立与当前 PR 可否合并分开报告：权限旧证据有效；新候选尚待 Chief 安排独立审查和必需 CI，当前不能合并。
## 固定边界与 PR
- main base `451ab8c9969f18d94f17392a74301294de82b5e1`；输入/保全源码 `7ce6621aa2bebcada300ddde91d099373722eb77`。
- 隔离整理分支 `candidate/max684-permissions-20261118` 从输入 head 追加提交，原输入保存在 `archive/max684-pre-convergence-7ce6621aa`；不 reset、rebase、amend 或删除历史。完成后任务分支仅 fast-forward 到该候选，保留 7ce 祖先和原 AGENTS 未提交差异。完整候选 SHA 由本次交付评论锁定，本文属于该候选，不把旧运行重标为新候选实测。
- 仅回读 PR 元数据：[#1010](https://github.com/max2055/Slide/pull/1010) open/draft，远端 head `578ccfce6aa2974ce5d3026fc124b8a99cfd22ff`、base 为上述 main，尚未包含本候选。没有推送、修改 PR、查询/重跑 CI、合并或部署。PR 正文仍描述旧 e5，须由 Chief 下一阶段按新候选更新。#1009 不关闭。
- e5 是原权限验收锚点，df7 是最后生产兼容修复锚点，均不是本轮完整候选；合法身份/credential 迁移及安全恢复夹具继续保留。
## 本轮差异与契约
23 个变更涉及的生产/迁移文件逐字保持输入 head，前端权限产品实现不变。HTTP/WS 拒绝模型、chat:view、实时撤权/exp/version、旧绑定保全、分享与派生执行政策不变；不扩大权限。保留 HTTP 生命周期、调查资源拒绝不清登录、Cron 异步回复兼容及必要回归。

仅解除 fixture 耦合：runtime spec 删除 runtimeEvidence 及 finally 额外观测查询，保留原登录 token、真实 JWT/SQL claim、原 Actor/WeakMap credential、nonce/owner/单次准入限制及全部业务断言；nonce/coordinate/NODE_OPTIONS preload 从归档 runner 移入专用 Playwright 配置，配置在 worker 重载时复用身份，API 正常退出清理自己创建的 coordinate。CI 仍执行原三场景，只改用该 fixture 配置并运行两项装配单测；没有删除业务门禁/原断言、改变条件或放宽预算。自动 trace 关闭防止新增登录 JWT 入 trace。

streaming spec 恢复到 `82436e3e200d86ed87d703904d0515ced666b13a` 的合法 SQL/JWT/UI 登录版本，移除之后数值观察；原 80%、两项 100ms、全部断言和预算保持。原 main 已有的诊断/清理不顺手改写；身份迁移所需 trace 关闭及精确秘密替换保留。监督两入口、startup-readiness、bounded-queue 逐字恢复 main，排除后加取证/资源调整，不执行这些场景。
## 验收证据与本轮检查
| 范围 | 结论与版本边界 |
|---|---|
| 原权限政策及 MF-I1/I2/I3 | 复用 base→e5 的独立 PASS：68 项、原五探针 5 项、前端相关 330 项；生产权限逻辑未改。详见保留的 implementation-fixes.md。 |
| HTTP/调查/Cron 兼容 | 保留原红绿已证明的修复和回归，字节与输入 head 相同。原证据文档保存在输入提交的 ci-upstream-repair.md、http-lifecycle-repair.md、login-lifecycle-repair.md、cron-*-reply-repair.md、catch-repair-and-backend-triage.md，不重新运行未变范围。 |
| 必要 canonical/恢复/调查等身份夹具 | 复用 ci-fixture-repair.md 的 36/26/41 项及定向恢复 1 项；保留相同夹具字节。该历史全文件 bounded-queue 失败不改写为通过。 |
| runtime claim 身份与单次准入 | helper、真实 SQL/JWT 前置及 admission 回归逐字保留；复用旧 9/9 认证前置、6/6 离线准入及 3/3 managed 业务。旧业务绑定 2d8024aa，不冒称本次无取证直接入口已实跑。 |
| streaming 身份迁移 | 复用原 5/5 SQL/JWT 前置；原业务越过身份首错但 80% 仍 FAIL。原 0.12413694796619557 及后次 0.17776017473159622 保持历史绑定，不迁移成当前候选数值。两项 100ms 当时未到达，本轮未重跑。 |
| 新配置/解耦检查 | 实际加载两份 config 的离线检查 2/2；Playwright --list 仅列原三场景，不启动服务或浏览器；专用配置定向 TS 语义检查及 preload node --check 退出 0。没有把装配检查称业务 E2E。 |
| 范围不变量/源码策略 | 23 个生产文件与输入 head 相同；runtime/streaming 所有 expect 行保持；四个恢复入口与 main 字节相同；diff 和 source-policy 通过。 |

新入口检查命令：

```sh
node --experimental-vm-modules --test frontend/playwright.agent-runtime.config.test.mjs
pnpm --filter slide-frontend exec playwright test agent-runtime.spec.ts --config playwright.agent-runtime.config.ts --workers=1 --list
pnpm --filter slide-frontend exec tsc --ignoreConfig --noEmit --module ESNext --moduleResolution bundler --target ES2022 --typeRoots ../apps/db-ops-api/node_modules/@types --types node --esModuleInterop --skipLibCheck playwright.agent-runtime.config.ts
node --check frontend/e2e/runtime-claim-preload.mjs
pnpm ci:source-policy
git diff --check
```

Node24.22.1/pnpm11.19.0/TypeScript6.0.3/Playwright1.60.0，复用已有依赖，pnpm verifyDepsBeforeRun=false；不是新 frozen install。TS 首次入口缺 --ignoreConfig 返回 TS5112，其后缺 Node 类型返回 TS2688；显式指定已有 Node 类型路径后语义检查通过，无安装/产品改动。未启停任何数据库或服务，真实模型调用 0。
## 剩余合并阻塞
远端已核验历史 run44185239121/attempt1、merge checkout488026a9fc13e553c78ba75ca76179337958e491 的 backend/browser-qualification 失败，release-artifact/ci-gate 为传播。streaming 原 CI 首错为夹具缺 chat 权限，合法身份迁移已越过；其后 80% 失败的归属仍未知。监督 watchdog 与权限改动的因果同样未知，不能直接称既有故障。新候选未经过 CI，也未获得新的独立通过，原必需 gate 不能豁免。

本轮删除的是范围外新增观测，不是消除上述历史失败；保留的原监督入口仍由 CI 正常执行，不调整 watchdog/阈值、skip 或成功条件。停止实际探针、特权申请、性能重跑、归档增强和反复验包；资料/权限缺口不在本轮另开实验。Chief 下一阶段统一安排独立审查与必要 CI；原 e5 精确合并授权不自动覆盖本候选。MAX-684 保持 in_progress、PR 保持 draft。
## 完整文件清单
以下覆盖输入相对 main 的全部 119 条路径，加本轮新测试/本文；retain 为字节保留，restore-base 为原路径仍在且排除其 MAX-684 增量，exclude 为候选树排除但原提交链保留，decouple 为仅解除身份夹具与取证层耦合。

| 路径 | 处置 | 理由 |
|---|---|---|
| `.github/workflows/ci.yml` | decouple | 只解除必要身份夹具与后加取证层的耦合 |
| `apps/db-ops-api/server.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/sql/migrations/160_chat_execution_authority.sql` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/agent-run-recovery.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/audit-ws-recheck-20260916.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/canonical-store.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/display-stream-ws.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/memory-service.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/runtime-lifecycle.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/steer.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/steer.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/__tests__/tool-stream-integration.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/agent-run-service.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/bounded-socket-writer.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/canonical-store.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/direct-adapter.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/get-agent-engine.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/adapter/memory-service.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/agents/subagent-lifecycle.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/agents/subagent-manager.fixture.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/agents/subagent-manager.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/agents/subagent-manager.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth-middleware.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/actor-context.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-authorization.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-authorization.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-authorization.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-credential.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-execution.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-handler-ownership.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-ownership.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-permission-contract.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/chat-routes.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/dependency-recovery.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/auth/security-boundaries.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/chat-database-service.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/chat-handler.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/chat-history-page.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/chat-routes.active-minutes.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/chat-routes.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/cron/cron-routes.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/cron/cron-run-lifecycle.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/cron/cron-script-lifecycle.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/health-routes.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/http-lifecycle.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/investigations/execution-recovery.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/investigations/observation.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/investigations/session-bridge.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/lifecycle/platform-unavailable.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/login-lifecycle.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/src/operations/server-composition.mysql.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/tests/runtime-claim-fixture.acceptance.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/tests/runtime-claim-fixture.admission.test.mjs` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/tests/runtime-claim-fixture.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/tests/streaming-auth-fixture.acceptance.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `apps/db-ops-api/tests/streaming-auth-fixture.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `docs/slide/development/MAX-684/catch-repair-and-backend-triage.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/chat-authorization-proposal.md` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `docs/slide/development/MAX-684/ci-failure-closure.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/ci-fixture-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/ci-upstream-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/concurrent-evidence-delivery.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/controlled-diagnostics.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/cron-empty-response-diagnosis.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/cron-job-reply-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/cron-list-reply-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/cron-run-reply-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/cron-script-reply-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/diagnostic-followup-evidence.json` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/diagnostic-followup.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/evidence-repair-and-authenticated-fixture.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/fixture-admission-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/http-lifecycle-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/implementation-fixes.md` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `docs/slide/development/MAX-684/implementation.md` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `docs/slide/development/MAX-684/login-lifecycle-repair.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/observation-archive-candidate.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/offline-ci-failures-00bf3c.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/source-evidence.json` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `docs/slide/development/MAX-684/startup-auth-diagnostic.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/streaming-identity-and-supervisor-analysis.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/streaming-numeric-and-probe-plan.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/streaming-once-4fd9af11a.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `docs/slide/development/MAX-684/supervisor-signal-correlation.md` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `frontend/e2e/agent-runtime.spec.ts` | decouple | 只解除必要身份夹具与后加取证层的耦合 |
| `frontend/e2e/fixtures/streaming-login.html` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/e2e/fixtures/streaming-login.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/e2e/runtime-claim-preload.mjs` | decouple | 只解除必要身份夹具与后加取证层的耦合 |
| `frontend/e2e/runtime-evidence.ts` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `frontend/e2e/streaming-live.spec.ts` | decouple | 只解除必要身份夹具与后加取证层的耦合 |
| `frontend/e2e/workbench-repair.spec.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/playwright.agent-runtime.config.ts` | decouple | 只解除必要身份夹具与后加取证层的耦合 |
| `frontend/src/app/ui/chat-session-state.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/src/app/ui/controllers/chat.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/src/app/ui/direct-gateway-authorization.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/src/app/ui/direct-gateway-init.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/src/app/ui/direct-gateway.test.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/src/app/ui/direct-gateway.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `scripts/diagnostics/fixtures/fatal-rejection.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/diagnostics/http-lifecycle-repro.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/diagnostics/process-evidence.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/diagnostics/process-evidence.test.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/diagnostics/request-evidence.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/diagnostics/request-evidence.test.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/bootstrap-admin.mjs` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `scripts/qualification/runtime-browser-evidence.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/runtime-browser-evidence.test.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/runtime-observer-failure.test.mjs` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/serve-e2e-boundaries.bash` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/serve-e2e-boundaries.py` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/serve-e2e-boundaries.test.py` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/serve-e2e-evidence.py` | exclude | 后续诊断/监督/归档/报告增量；原提交链保留 |
| `scripts/qualification/serve-e2e.supervisor.test.sh` | restore-base | 恢复原测试/监督入口，排除后加观察，不更改原断言或预算 |
| `tests/qualification/agent-runtime-mysql.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `tests/qualification/assert-bounded-queue.ts` | restore-base | 恢复原测试/监督入口，排除后加观察，不更改原断言或预算 |
| `tests/qualification/serve-e2e-supervisor.test.mjs` | restore-base | 恢复原测试/监督入口，排除后加观察，不更改原断言或预算 |
| `tests/qualification/startup-readiness.test.ts` | restore-base | 恢复原测试/监督入口，排除后加观察，不更改原断言或预算 |
| `tests/qualification/stream-boundary-crash.ts` | retain | 权限实现、必要回归、兼容/合法身份迁移或原政策依据，字节保持 |
| `frontend/playwright.agent-runtime.config.test.mjs` | add | 验证直接CI入口的fixture环境继承和预算，无服务启动 |
| `docs/slide/development/MAX-684/minimal-candidate.md` | add | 本轮唯一收敛说明、证据复用和完整清单 |
