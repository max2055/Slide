# MAX-684：run 44120566197 上游首错闭环

本轮只处理原 PR #1010 必需门禁暴露的两个上游首错，不合并、部署或关闭 #1009。政策合同仍为 `58abcdbb4683532430f447c32a47e87b3b603dd4`。

## 版本和原红证据

- main base：`451ab8c9969f18d94f17392a74301294de82b5e1`。
- 本轮起点/run head：`2c1659659fdc307090766f9a687cdff69a703dec`。
- 实际 CI checkout：`4e0e2610a1640ed9098ed49c02640f47123838bb`。完整 checkout 日志与 Git commit API 均确认，parents 按顺序为上述 base、head；这是 PR 测试合成提交，不是已合并。
- 产品修复：`0355444c48bbc1dae7cac43824c0d94c5200c395`；真实观察测试及最小权限断言补齐：`04731ad2047fcef6ef85acdf66b3fe7177eed5b5`。后续仅追加本文。
- 原 run completed/failure；workspace shard 2 job `134170618710`、browser job `134170618843` 的失败步骤均退出 1。release-artifact `134175322126`、ci-gate `134175488344` 均在包装阶段报告 browser-qualification 非 success，是传播而非另外两个产品根因。

完整 run.log、原始 run/jobs/artifacts/checkout JSON 和相关原始 ZIP 随本轮证据包保留。workspace ZIP `14344349444` 为 5,637,283 字节、SHA256 `563d114610bdafcf21b0d88e52924e9c92e5fdf6ff88d963f87a2befb2a0fb75`；browser ZIP `14345411504` 为 956 字节、SHA256 `76a793f80822d1c8cac151b692ca2139d6d5f239798344419db0de89911905a0`。两者与 GitHub artifact digest 一致，CRC 通过。browser artifact 仅含 TLS 结果，运行时红证据来自完整步骤日志；不假称存在独立 runtime artifact。

## 首错 A：撤销调查资源权限误发全局凭证失效

原断言在 `frontend/e2e/workbench-repair.spec.ts:72`：撤权后返回列表，焦点不应为 BODY，等待 5000ms 失败。原 trace 同时出现“登录已失效”，网络中调查详情/facts/results 为真实 404；相应 WS 日志为已认证 user101 的 4001、reasonBytes31（`Investigation authority revoked`）。这不是刷新回 body 的已接受基线，也不是 ECONNRESET 的推测归因。

调查观察已有 `authority_revoked` 分类，只代表该资源或操作权不可用；DirectAdapter 将其关闭为 4001 后，普通聊天客户端依据凭证失效合同清除全局身份和页面状态。MAX-684 新增的全局失效清理使这一错误信号实际触发了页面清空。

最小修复在服务端观察适配层：仍先退订该 peer 的全部调查观察，再使用现有 `investigation.error / INVESTIGATION_NOT_FOUND` 帧清理调查视图，保留有效认证连接。初次 watch 被拒绝本来就使用同一错误合同；不新增协议字段、不改客户端或 UI 实现。身份失效、原 token 到期仍走 4001，观测基础设施故障仍走 1011。当前调查正文、facts/results/evidence 和观察必须清理，既有 Run 不取消；普通聊天权限不因资源恢复而扩张，后续命令仍实时复核。

回归保留三尺寸原焦点、分页/筛选及无未授权模型/工具调用断言，追加有效登录保留和授权列表 HTTP200；未删除或放宽焦点检查。真实 WS 回归将原“等4001断连”更新为拒绝帧、socket OPEN、观察已撤、Run仍running，并在恢复原资源授权后用同一连接再次获得 snapshot。改旧断言的依据是上述资源/身份分离，不是为了隐藏原红灯。新增单元回归映射到原 2c165965 产品实现时 1 FAIL/58 SKIP、退出1；相同断言在新实现通过。

## 首错 B：旧运行时夹具未满足普通聊天认证与恢复绑定

原 `agent-runtime-mysql.ts:71` 15000ms 超时发生在认证阶段：连接后约6ms关闭4001、userId null，没有 auth_ok、run.started 或模型消息。旧夹具 authenticateAccessToken 返回手工 actor，没有验证凭证元数据，SQL 中也没有 chat:view 角色。没有依据把它归为握手网络超时、消息执行或清理问题。

夹具改用真实 ActorContextService、签发/验证的测试 JWT、独占 schema 内唯一角色且仅授 chat:view，默认 viewer 与生产种子不改。持久化恢复用的普通 Run claim 传入同一有效 actor，保存真实授权绑定；受控流崩溃子进程验证同一测试凭证及 actor ID。否则旧无绑定 staged Run 按新政策应取消，不能以保留旧预期为理由绕过恢复校验。

socketExchange 对 terminal 前关闭立即报告 command/code/已见事件类型；保留15000ms预算并在超时报 command/terminal/事件类型，不记录 token、正文或私有凭据。模型与目标工具仍为本地受控端点/handler，未知工具结果保留待核对，无外部动作重放。

## 验证入口与证据边界

环境：macOS、Node24.22.3、pnpm11.19.0、冻结锁依赖；显式 mysql-test 配置的 mysql3308，随机独占 schema。两个原首错的 Linux 实证保留；本轮本地结果不冒充当前 Linux CI。下面的检查结果及测试/观测/清理输出在附件 REPORT 中逐项列出：

```bash
bash scripts/qualification/run-agent-runtime.sh --mode mysql
pnpm --filter slide-api exec vitest run src/adapter/__tests__/direct-adapter.test.ts src/investigations/stream.test.ts
pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts workbench-repair.spec.ts --workers=1
pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts workbench-authority.spec.ts investigation-recovery.spec.ts --workers=1
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm ci:source-policy 2c1659659fdc307090766f9a687cdff69a703dec HEAD
```

真实环境通过显式 DB/AGENT_RUN_TEST_MYSQL/AUTH_TEST_MYSQL/T06_TEST_MYSQL 配置注入；完整 runtime 包装器自行设置 JWT 和浏览器开关。默认自动测试不读取本机私有凭据文件。报告中保留直接误选入口缺 JWT、缺显式配置导致的失败/跳过，不用它们计验收通过。

MF-I1/I2/I3 未变部分、G1 Linux TLS 和既有前端键盘/控件证据按原复核覆盖范围复用；不重跑全量本地测试或 TLS。startup 阶段证据、历史401/fatal因果未知及成功路径内部观测未导出的限制仍有效。刷新回 body 基线保持原记录，不恢复人工读屏/VoiceOver。新产品变化需原 Reviewer 增量复核；当前 head 的必需 ci-gate 成功前整体验收继续 BLOCKED，MAX-684 保持 in_progress，不轮询或新增订阅。
