## 独立实现审查返修（2026-11-17）

对应独立报告 `8adee7869e61435b2fbc578b041cc3334d1fa128` 的 MF-I1 / MF-I2 / MF-I3。原审查结论为 FAIL，本文件记录作者修复和验证，不代替 Reviewer 复审或最终验收。政策合同仍为 `58abcdbb4683532430f447c32a47e87b3b603dd4`，不包含合并或部署。

版本关系：

- PR #1010 的 main base：`451ab8c9969f18d94f17392a74301294de82b5e1`；被审 head / 本轮起点：`8451da7dd6a084780c40249575d6f7e1d55fbabc`。
- 后端修复：`402b87358f3a552988656628465a58ee04cc8a51`，四个后端文件，含原真实验收文件。
- 前端 #1009：从 `0f4919bf76a224912409102ce9f93f85b419560b` 只追加 `227393c154f3dbd1d984b86bb0b0f09f2bc79b87`，三文件 +139/-16。Chief 明确释放后，以 merge `7cec64b7ec98b9f3f6551586a11e7c4acbdc1dbe` 纳入；保留双方起点和历史，未改写/关闭前端 PR。
- 完整候选验证 SHA：`a4a7ec1316e4832950466c3871152a58aaef9e8c`；相对 merge 仅追加实际客户端的无/未知关联与全局拒绝断言。后续仅补本文档，最终交付 head 见 PR 和证据 REPORT。
- 工作分支始终为 `agent/15-backenddev-01/max-684`；运行时 AGENTS.md 未提交。原独立证据未修改。

## 逐项回应

| 缺陷 | 修复与验证 |
|---|---|
| MF-I1 / P1 | 在统一 `sendSocketEvent` snapshot 边界将 staged `result` 限为 `{completionPending:true}`，不发送 event / finalContent / messageParts / projection；legacy 与 parts 一致，涵盖 watch/replay 及其他恢复 catch。SQL staged event 和未知事实保留，失败不重发模型/工具。真实 SQL 暂存后，watch/replay × legacy/parts × 原 exp 到期/缺绑定/version 失效 × 取连接/开事务故障共 24 组合均不泄露；故障恢复后的新凭证仅观察，旧运行取消、无 assistant 写入、模型/工具零增量。 |
| MF-I2 / P2 服务端 | watch/history/幂等 send 拒绝沿用请求的规范化 sessionKey，携带适用 messageId/runId；已找到的幂等记录可补原 session/run。只有确认不可见才发稳定不可见码。parts 订阅登记和 unwatch 同步规范化，避免 key 格式改变造成观察错位。 |
| MF-I2 / P2 完整集成 | 原作者前端补关联兜底、会话接收器和调整待确认隔离。三个实际服务拒绝帧用例直接驱动真实客户端/控制器：隐藏 A 清理并阻止迟到恢复；B 正文、草稿、真实观察和 held 模型请求的 pending acknowledgement 保留；B 仅一次发送/模型准入。故障注入的无/未知关联拒绝不猜 B；实际全局 CHAT_FORBIDDEN 清全部并结束未知回执。服务端字段仍必需，客户端保守丢弃不能替代合同。 |
| MF-I3 / P2 | 存储授权读取只将列举的 SQL 连接、容量、锁等待/死锁故障归一为现有 PlatformUnavailableError。覆盖身份、ACL/share、owner、关联调查以及携带 ACL 的历史读取；watch/history/send/memory 的异常处理保留 503/1013 路径，未知错误不再伪装为永久不可见。4 个查询阶段的准入/出站故障、history/send/replay、HTTP 已加载历史后的最终授权故障及未知 ACL 异常共 9 项通过。确认不可见仍为 404/稳定码，恢复仅重建观察、调用计数不增加。 |

MF-I2 双视图夹具使用真实旧 owner run 和当前 owner/read-share SQL 状态，以分享撤回触发拒绝；SQL 状态准备不宣称产品提供会话 ownership 转移功能。迟到帧和缺关联帧是明确的传输故障注入；三个拒绝帧均来自实际服务，不是替身构造。

## 验证与复用

环境：macOS、Node 24.22.1、pnpm 11.19.0（仓库 packageManager）、冻结锁依赖。显式选择 mysql3308，随机独占 schema，真实 MySQL / JWT / Fastify routes / DirectAdapter / WS；客户端为实际前端源码加 JSDOM。最终真实验收与五个独立探针顺序执行，不启停共享容器。清理停止客户端、释放在途受控请求后关闭服务、连接池并删除本任务 schema。

模型是本地真实 OpenAI 兼容 HTTP 端点的受控输出；工具是可计数 handler。完整 59 项真实验收共 14 次本地 Provider 请求、1 次工具 handler；较原 23 项的 11 次模型多出的 3 次用于双视图 B pending 回执。拒绝和恢复不新增调用由逐例计数断言保证。付费模型请求为零，不构成外部模型或目标 SQL/SSH 工具能力证明。

| 检查 | 采集版本与结果 |
|---|---|
| 原 23 场景 + 新增 36 项真实回归 + 9 边界 | 完整候选 a4a7ec1：2 文件 / 68 passed；其中真实验收 59 项。原 18 场景 ID 和原新增 5 项全部保留并复跑。 |
| 原五个独立探针 | 原报告探针仅改本地 import/config 路径，断言保持；修复前 3 failed / 2 passed，完整新候选全部通过。原探针证据不改。 |
| 前端相关 | 完整候选 a4a7ec1：26 文件 / 330 passed。包含新增 12 项关联/隔离兜底。 |
| 受影响 API 单元/契约 | 服务端修复 402b873：23 文件 / 440 passed，6 文件 / 117 tests 按默认环境跳过（含未显式启用的真实验收），退出 0；此后后端产品代码无变化。 |
| 安全回归 | 服务端修复 402b873：35 文件 / 613 passed，退出 0；该安全回归涉及的后端产品和测试无后续变化，复用有效。 |
| API/前端 typecheck、contracts:check、前端 build/CSP、security:scan、source-policy | 完整候选 a4a7ec1 均退出 0；source-policy 0 violations。build 保留原大 chunk 提示。最终文档 head 再核对 diff / source-policy 和祖先关系。 |

真实验收入口与环境变量沿用 [实施文档](./implementation.md#验证入口与证据边界)。本轮固定命令：

```bash
# 通过安全执行环境注入 MAX684_ACCEPTANCE=1、MAX684_MYSQL_PORT=3308
# 及 MAX684_MYSQL_HOST/USER/PASSWORD；不得在日志展开密码。
pnpm --filter slide-api exec vitest run src/auth/chat-authorization.mysql.test.ts src/auth/chat-authorization.test.ts --maxWorkers=1
pnpm --filter slide-api exec vitest run src/auth src/adapter/__tests__/agent-run-service.test.ts src/adapter/__tests__/direct-adapter.test.ts src/chat-database-service src/chat-routes.active-minutes.test.ts --maxWorkers=1
pnpm security:test
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm security:scan
pnpm ci:source-policy 451ab8c9969f18d94f17392a74301294de82b5e1 HEAD
```

前端 26 文件命令、独立探针路径映射和逐场景结果见附件 commands/REPORT/scenarios。测试证据区分集成前后 SHA，未将所有历史全量声称为最终 head 上新跑。复用上一交付的 API 全量 8464 passed / 1928 skipped、前端全量 2352 passed 作为未变化模块证据，本轮以受影响回归覆盖变化；它们不能抵消独立反例。

未新增迁移或扩大权限政策，原迁移空库/159 升级/重复运行/comment 在真实验收中仍复跑。未执行完整 server.ts 部署、外部模型能力、容量基准或环境跳过专项，不新增这些门禁；memory pipeline 保留原证据边界。未重新采集浏览器三尺寸图，DOM/控件未改，复用前端原证据及相关控件回归；刷新焦点回 body 仍是已确认基线，不声称焦点保持通过。不新增人工读屏或 VoiceOver 要求。

## 交接

完整 PR #1010 与证据交 Chief，由 Chief 交原 Reviewer 复审。修复/本地回归通过不解除独立 FAIL，不代表整单完成或放行。原任务保持进行中；不提前启动 Reviewer、不合并 main、不部署、不轮询 CI。证据包与 REPORT 位于统一 outputs 目录，并作为任务评论附件；后端测试、集成和前端已释放文件可供复审，无运行中本任务服务需接管。
