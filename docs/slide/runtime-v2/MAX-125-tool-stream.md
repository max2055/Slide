# MAX-125 工具事件实施与验证契约 v1

目标：保留真实 toolCallId，逐调用发布计划、排队、执行、结算及 checkpoint 持久化边界；修复 text→tool→text 重复前缀。
基线：c3195b46c81f6855bab32ee4e5b622575d7ce031。设计依据：[比较报告](../evaluations/2026-10-04-agent-streaming-comparison.md) §6.2。
排除：完整 Parts reducer、增量 WS、快照续传、生产部署、付费模型调用。硬预算未设定；实际 token/费用遥测不可用；无子代理。

## 实施清单

1. `packages/agent-core/src/tool-stream.ts` 提供 browser-safe 工具协议、字段校验、唯一 wire→UI 规范化和有界脱敏预览。旧无 ID 工具帧不猜配；历史沿用现有 MessageParts 转换。
2. `runtime/tool-executor.ts` 在每个执行边界发事件，progress 捕获调用 ID；快工具不等待整批结束。`turn-loop.ts` 仅在 tools_completed checkpoint 成功后发 persisted。取消/超时未知结算不标成功。
3. `direct-adapter.ts` 转发执行器事件，正文保留旧累计 delta，新增 partId/partText。`direct-gateway.ts` 在工具屏障 flush 并校验/规范化。`app-tool-stream.ts` 保存独立身份、阶段、计时及段顺序。
4. focused 测试覆盖同名并行、重复帧、error、取消/unknown、边界校验、预览安全和真实 Adapter→Gateway→UI。受影响模块测试及 typecheck/build 作为最终本地 gate；仓库完整 CI 由 PR 当前 head 执行。
5. 验收证据记录 SHA、环境、命令、结果与未验证项，创建 MAX-125 PR 并核验平台关联。进入 in_review，父任务负责检查及合并。

停止条件：真实权限阻塞、未合并前置、或不可恢复验收环境；保留可审阅候选与准确未验证项。回滚入口为撤回本任务 PR；无 schema 迁移。

## 协议与兼容决定

- `ToolCallRequest.id` 直接作为 `toolCallId`，不按名称/参数/时间猜配。planned/queued 不计执行时间；只有 start 建立 startedAt，progress 单独到达时不会伪造开始时间。重复/迟到 start/result/progress 不回退 settled/persisted。
- core `onToolEvent` 直接发布每次执行及进度，Adapter 不再依赖整轮 afterIteration。结构化 `success:false` 和未知工具均为 tool_error。工具 settled 不等于成功，outcome 另含 error/cancelled/unknown。
- persisted 只在既有 `tools_completed` checkpoint callback 成功后发布；anchor 与 checkpoint 状态先接收该提交。快调用可先 settled，批次持久化仍沿用现有事务。
- Adapter 的 `concurrentTools:true` 显式启用 core 原有 concurrencySafe 批次；默认串行不变。独占或未声明 concurrencySafe 的工具仍按现有分区串行执行。
- native wire 的工具类型与校验来自纯 `tool-stream.ts`，frontend 直接导入该文件，避免 Node runtime 导入。`normalizeToolEvent` 是唯一 wire→UI 转换。无 ID 的旧 native 工具帧丢弃，绝不按名称关联；有 ID/name/phase 的旧 AgentEvent 仅在命名的 legacy 边界适配。历史继续用既有 MessageParts/legacy 转换。
- text_delta.delta 保持旧累计替换语义；新增 run-scoped partId/partText 明确当前段全文。新消费端只用 partText，旧端继续用 delta；段保存带 beforeToolCallId，避免多个工具时按数组下标错误交错。reset 清除可撤回文本段并保留工具事实；完整 Parts 原子投影及快照恢复属于 S2/S3。
- 预览至多 4096 字符，遍历深度 4、最多 64 项；入参/进度同样有界脱敏。预览保留 kind/truncated，截断附工具调用 detailsRef；它不是 URL，只能通过既有 actor-authorized chat.history 识别工具事实，并继续受已有结果截断限制。不新建未授权或无界详情端点。

## 验收矩阵与候选证据

实施代码提交：`227a69d169e8835b523a43cf06f32f13e1b4f67e`；本文件追加为证据提交，不改运行代码。base：`c3195b46c81f6855bab32ee4e5b622575d7ce031`。
兼容前置已在 main：MAX-103 `34c67dbb`（PR #107），MAX-104 `9d7b0a0c`（PR #108）。
环境：2026-10-05，macOS darwin/arm64，Apple M5，Node v24.18.0，pnpm 11.19.0；Chromium Playwright 本地受控夹具。

| S1 验收 | 实际证据 | 结果 |
| --- | --- | --- |
| start/progress/result/error 贯穿实际链路 | `apps/db-ops-api/src/adapter/__tests__/tool-stream-integration.test.ts`：真实随机端口认证 WS → DirectGateway dispatch → handleDirectAdapterEvent → handleToolStreamEvent；只替换 provider/auth/persistence 边界 | 通过 |
| 同名/重复/并行快慢/error/取消/unknown/晚到 | core `tool-lifecycle.test.ts`、frontend `tool-stream-contract.test.ts`、实际 WS 集成：fast settled 时 slow 仍 running；业务失败为 error；超时未结算不提升成功 | 通过 |
| text→tool→text 无重复/丢段/重复卡，阶段耗时真实 | 同一 WS 测试旧 delta=before,beforeafter、新 partText=before,after；Chromium `e2e/tool-stream.spec.ts` 断言“正文甲→2工具→正文乙→2工具→正文丙”，四卡及 queued/unknown/cancelled/persisted 耗时 | 通过 |
| 边界校验/有界 typed 预览/授权 | core 测试非法 id/name/time/args/progress/error/phase/outcome/sequence/preview、循环值、大结果和秘密脱敏；frontend 测试非法帧不污染 sequence，已识别旧事件明确适配 | 通过 |
| 文档与基线 fixture | [仓库可用比较报告](../evaluations/2026-10-04-agent-streaming-comparison.md)，源链接固定 GitHub SHA；`tests/fixtures/tool-stream-baseline.json` 保存旧事件及已识别 legacy 对照；HTML 未进入生产页面 | 通过 |

最终候选本地 gate：

- `pnpm -r test`：sandbox 22 passed/4 skipped；core 660 passed；frontend 578 passed；backend 3017 passed/251 skipped。合计 4277 passed，255 skipped。skipped 的环境资格用例不计通过。
- `pnpm -r --if-present typecheck`：四模块通过。
- `pnpm contracts:check`：通过；`pnpm --filter slide-frontend build`：通过，production CSP 检查通过。
- `pnpm --filter slide-frontend exec playwright test --config playwright.audit.config.ts tool-stream.spec.ts`：1 passed，真实聊天 DOM 顺序/阶段/耗时及截图。
- `bash scripts/qualification/run-agent-runtime.sh --mode deterministic`：单独运行通过；首次与全套测试并发时检测器 p95=61.87ms 超阈值，分类为资源竞争环境失败；隔离复验 p95=3.69ms，未修改性能阈值。最终提交复验数据见下文。

证据范围：本任务验证真实 WS 和真实 Gateway/UI 消费器，但 provider、认证用户及数据库写入为受控测试边界；未声明真实 MySQL/付费模型/生产资格通过。八项 GitHub 当前 head CI 由 PR 启动，父任务负责全部成功后验收合并；本子任务不合并、不置 done、不启动后继。

资源：未设硬预算；当前平台 run usage=null，raw input/cached/output、费用及标准化吞吐不可用。子代理 0、最大委派深度 0；保留 scope v1，未新增任务或扩展 S2/S3。
回滚：撤回本 MAX-125 PR；没有数据库迁移、生产配置修改或付费业务调用。

## PR/CI 续修补充 v2（2026-10-05）

范围 v2 保留 S1 产品范围，仅增加当前 PR 的 CI 阻塞修复和本任务族持续跟踪配置。原始 head `a7a907bf` 的 [Actions run 37258282084](https://github.com/max2055/Slide/actions/runs/37258282084) 中，六项成功，recovery-qualification 失败，release-artifact 被依赖跳过；不计完整通过。

失败发生于 `run-environment.sh bootstrap-upgrade`：初始化 MySQL 的首次 socket ping 成功，紧随的无重试 ping 在临时服务重启时退出 1，尚未进入已有的发布端口稳定查询。删除重复 socket ping 前置，直接使用既有 TCP 三次连续查询检测；60 次上限及失败退出、容器清理保持有效，没有放宽门禁。

- `qualification-environment.test.ts` 执行真实 shell 脚本、模拟初始化重启及 TCP 查询中断/持续失败：修复前两个用例失败；修复后两个通过，确认稳定查询完成前不执行迁移、超时不执行迁移且清理容器。
- `bash scripts/qualification/run-environment.sh bootstrap-upgrade`：真实隔离 Docker MySQL 8.4，空库迁移、重复启动、旧 audit baseline 升级测试通过，115 项 migration invariant 通过；容器由脚本清理。
- `pnpm --filter slide-api typecheck` 与 `bash -n scripts/qualification/run-environment.sh` 通过。其他未变产品代码复用 v1 验证，最终完整门禁由修复 head 的八项 CI 执行。

自动闭环：MAX-124 原有唯一10分钟巡检正常，但 MAX-125 交付时没有 CI 条件规则。现在为 MAX-125–MAX-129 各配置一个 `until-pr checks`、continuous、168小时、max-fires=1000 的持久化规则，并在父/子任务追加 v2 契约；描述更新使用 `--no-start`，不提前启动 backlog。平台约30秒检查，成功或失败均续跑原子任务；失败读取日志、分类、修复并推送原 PR，成功交父任务合并；父巡检继续兜底和维护规则有效期。规则不回放注册前已完成结果，故登记时和退出前必须读取并处理当前结果。暂停/取消/完成禁用相应规则，禁止重复派发及并发改分支。规则 ID 与实际生效状态以 Multica issue wakeup list 为准。

最终 `227a69d1` deterministic 复验（退出码 0）：

```json
{
  "mode": "deterministic",
  "normal": 210,
  "falseRejects": 0,
  "misses": 0,
  "extraNormalRequests": 0,
  "benchmark": {
    "chars": 100000,
    "samples": 100,
    "p95Ms": 3.830832999999984,
    "cpu": "Apple M5",
    "platform": "darwin",
    "release": "27.0.0",
    "node": "v24.18.0"
  },
  "productionRollout": "unverified"
}
```

运行代码及测试 SHA-256（证据提交未改变以下文件）：

```json
{
  "apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts": "ed92762c5c0043dd17a07119121adb900ec2a5b37dd0b3e601a2c488c2fc63e3",
  "apps/db-ops-api/src/adapter/__tests__/tool-stream-integration.test.ts": "26d32ab8c80a81bccf3381d355ac8bafceef21560138b77574fc4b52a754ba29",
  "apps/db-ops-api/src/adapter/direct-adapter.ts": "90d300fe2f5d15cb423106818c32940ebbe55b4e47290f58bbfe8eeca3b76fba",
  "apps/db-ops-api/src/adapter/types.ts": "44084004c5d209e80103d59c30091180d04ddcc4f21edef49b878dadaa797e91",
  "frontend/e2e/tool-stream.spec.ts": "172156466e391255ec476deff7575169f3303c52c55442edf66b45d945fe6fbe",
  "frontend/playwright.audit.config.ts": "e25245d72f8053d56ab2c22aa444050b7176229eafcdb71eaa11b0e19401df62",
  "frontend/src/app/ui/app-tool-stream.ts": "2f27447414faa235dc01c69b25e1fae9ae4ddeaef2fe10d7333bf179ca012465",
  "frontend/src/app/ui/chat/grouped-render.ts": "d0aef4c6950711c7fb288372027d95dec746dceb4a580df8ed1aa23bc52f090f",
  "frontend/src/app/ui/chat/tool-cards.ts": "2d98d475e531a4409cd378f28de2c59b17b3811e8b8b439f9257b86a69c75a3e",
  "frontend/src/app/ui/direct-gateway.ts": "7140bd9d42eeefacdb2c0ece467f24f1d1d6b2be95bf2db88bf3bf89adeb09ed",
  "frontend/src/app/ui/tool-stream-contract.test.ts": "5b476d5f7dc0f6e5ee9cfb545a25cf192163c129b6129e059108ef968f33d454",
  "frontend/src/app/ui/types/chat-types.ts": "f5470d46d369d245a9865ddb07cb5a98b18eea58776ef4693b2088f2966c902b",
  "frontend/src/app/ui/views/chat.ts": "f61bcd0200a76d0b2f6992fcbbca1769c5604b0f4b1ef1ee33599d0ca2b6cb29",
  "packages/agent-core/src/__tests__/tool-lifecycle.test.ts": "c410e709c6702e2a97cd4b97c8e54e95707089d482aed622b493ef6b16546747",
  "packages/agent-core/src/runtime/tool-executor.ts": "6a869fd84a43a65037eb404679f91e524ee5fa9208c0fc505437f68cbab754fb",
  "packages/agent-core/src/runtime/turn-loop.ts": "b8d180bf08e4819d8ccb59b3d6588057f9aaa197a868093f9a0a6b568dced17c",
  "packages/agent-core/src/tool-stream.ts": "da47891bfeb3efaeec3c77d46b842a894410001cacdaed42053bc035dc2b4e6b",
  "packages/agent-core/src/types.ts": "90c86f6ecb4483f4cedfa396611d1316f20ae34f80f698578e27a49e59c21fba"
}
```
