# MAX-147 / T05-A：canonical facts 有界修复与验收

本出口只关闭当前执行路径消费的 FINAL-0614 / PARTIAL-0413。完整 T05 的 watch/evidence/result 不在本次范围；不启动 T04-B，不修改共享 Review 台账，保留父任务独立核验。

## 基线与源码裁定

2026-10-12 默认分支 main 为 `058a316399e3bacaf52e908e4de985c2af463d28`，已包含 T02-C #149、T03-C #150、T04-A #151 和 T07-A #152。当前工作区原有基线分支包含其他本地资料变更，保留在 `codex/MAX-147-workspace-baseline`；实施分支 `codex/MAX-147-canonical-facts` 从 origin/main 创建，原 AGENTS.md 和 .multica 工作区修改不提交。

确认调用链：DirectAdapter.runChat 对 actor-owned Chat 从 canonicalStore.getPage 重建 Session；checkpointCallback 从 checkpointFacts 生成实际工具事实、经 AdapterMessageProjection.document / persistedMessageParts 归一化，再调用 appendToolFacts。该方法锁定 Chat Session，事务写 facts 和 checkpoint。原比较只选取 role/content/tool_calls/tool_call_id/runId/turnId/reasoning/thinking/attachments，遗漏 metadata、timestamp、name、未知字段及完整 Parts；UPDATE 仅看文档 status，导致静默保留旧数据，也允许 completed→partial。

## 完整事实与合法推进契约

- 对**持久化后的完整 JSON 值**进行比较：对象成员次序无意义，数组次序、字段值、metadata、legacy、完整 Parts、额外字段均有意义；同 ID 必须属于同一个 SQL user turn。精确重放不 UPDATE，不改变分页 id/turn_sequence/ordinal。
- 除下述生命周期推进与确定性序列化默认值外，同 ID 不一致报 CANONICAL_ID_CONFLICT。事务内先插入的新事实、合法推进以及 checkpoint 一并回滚；禁止失败后前移 checkpoint。
- 文档/Part status 只允许保持或 partial→completed；generation 只允许 open→ended。工具 phase 按 planned/queued/running/settled/persisted 单调推进；尚未 settled 时可更新显示进度、补齐 startedAt/settlement/outcome/preview，已定义 outcome 保持。settled 后其 preview/progress/settledAt/startedAt/args/name/ID 等保持，persisted 仅增加持久化时间；事件时间不得倒退，settled/persisted 同 phase 不可更改事件时间。SQL 已提交 persistedAt 是存储拥有的确认：恢复 anchor 仅缺少此确认时继承原值，显式改值仍拒绝，其他字段逐项比较；等价重放不 UPDATE。完整字段比较仍拒绝其他变化。
- supplied failed/discarded、runTerminal、错误 durable kind/reference 在 acknowledgement 前拒绝，避免归一化消除冲突。合法工具失败结果仍是已完成的工具执行事实，其 outcome=error 不被伪装成成功。
- 复用原会话锁及实时 Chat append 授权；wrong actor/session、普通 read share 不获得 append。无 auth、迁移、ledger/outbox、executor、公开契约修改。

## 必要的 message-parts 序列化修复

仅改 canonical-store、直接测试及 message-parts；后者有以下真实调用证据，未修改 DirectAdapter/AgentRunner：

1. checkpointFacts 首次构建 legacy tool Parts 时，turn 默认为 run；DirectAdapter 随后绑定实际持久化 user turn，但旧 Parts 的默认 turn 未同步。下次 projection.document 才补齐 turn/projectionMessageId/sourceMessageId/generation。先在首次 checkpoint acknowledgement 将明确符合 legacy 默认形态的文档归一化，避免后续重写已提交身份；任意不一致 legacy turn 不会被覆盖。
2. projectionMessageParts 从原 Parts 重建文档时遗漏文档层 attempt/sourceRequestId，但各 Part 保留原边界。只有文档字段缺失且所有 Part 对应值一致时才从 Parts 派生；显式值不覆盖，冲突值拒绝。原 canonical-history 真实恢复脚本在严格比较的首轮因此失败；新增 RED reproducer 后修复，原脚本八个场景全部 GREEN。
3. projectionDocuments/displayPart 将原始工具结果转换为紧凑、脱敏/截断的显示摘要；下一 checkpoint 的 projection.document 会携带该摘要。若 tool Part 的 call ID 匹配，外层原始 content 与 legacy.content 相同，且 Part.content 精确等于现有 buildToolPreview 转换，则在首次/后续序列化恢复完整原始 Part；任意其他 Parts 内容仍逐项比较并拒绝。针对结构化 JSON、10KB 截断及100KB/多迭代 WS 输出新增 RED 后修复（`194e9e5c`），原结果不丢失、等价重放不 UPDATE。同函数的另一个已确认转换是 tool_call.arguments 的 boundedToolValue 裁剪/脱敏；仅在 raw call 与 legacy call 的 ID/type/name/arguments 一致，且输入 Part.arguments 精确等于该转换时恢复原参数，其他值继续拒绝（RED `9166869a`）。两个转换分支均已覆盖，没有修改投影 reducer 或 raw tool content。
4. 已提交的旧格式默认值允许与 getPage 的同一确定性兼容视图等价重放，**不回填、不 UPDATE 原 JSON**；其他变化仍冲突。对原 legacy 数据无生产迁移或清理。

这些默认值只是现有 Parts v1 的序列化规则，不是新增事实版本，也不允许删除 metadata 或未知 Parts 内容。v1 reader/schema 保持。

## 可复现验收与结果

使用本任务独立 MySQL 8.4 容器、随机独立数据库、生产 MigrationRunner、CanonicalStore、ChatDatabaseService、ActorContextService/JWT、真实 SQL 事务和 WS 网络帧。pool 的隔离注入不替换 SQL/授权；失去 COMMIT acknowledgement 的 hook 在真实 COMMIT 后抛错。provider 是可控本地 fixture，无付费调用；退出等待 handler 完成，关闭 adapter/socket、连接，删除独立数据库和临时目录。

新 suite 和既有 T04-A suite 按仓库惯例用端口 opt-in；默认单测 skip 不算验收。下列模块命令提供端口，实际 **0 skip**。

```bash
AGENT_RUN_TEST_MYSQL_PORT=<isolated-port> AGENT_RUN_TEST_MYSQL_PASSWORD=<test-fixture> \
  pnpm --filter slide-api exec vitest run src/adapter/__tests__ \
    src/auth/chat-ownership.test.ts src/chat-history-page.test.ts
DB_HOST=127.0.0.1 DB_PORT=<isolated-port> DB_USER=root DB_PASSWORD=<test-fixture> \
  SLIDE_MEMORY_PIPELINE_ENABLED=false pnpm --filter slide-api exec tsx ../../tests/qualification/canonical-history-mysql.ts
DB_HOST=127.0.0.1 DB_PORT=<isolated-port> DB_USER=root DB_PASSWORD=<test-fixture> \
  SLIDE_MEMORY_PIPELINE_ENABLED=false pnpm --filter slide-api exec tsx ../../tests/qualification/agent-runtime-mysql.ts
pnpm --filter slide-api typecheck
pnpm --filter @slide/agent-core exec vitest run src/__tests__/message-parts.test.ts src/__tests__/message-projection.test.ts
pnpm contracts:check
pnpm security:agent
pnpm security:scan
pnpm exec oxlint apps/db-ops-api/src/adapter/canonical-store.ts \
  apps/db-ops-api/src/adapter/message-parts.ts \
  apps/db-ops-api/src/adapter/__tests__/canonical-store.mysql.test.ts
DB_HOST=127.0.0.1 DB_PORT=<isolated-port> DB_USER=root DB_PASSWORD=<test-fixture> \
  pnpm --filter slide-frontend exec playwright test --config playwright.streaming-live.config.ts
git diff --check
```

|证据|结果|
|---|---|
|原生产代码 RED|22项：17 failed / 5 passed / 0 skip；失败为遗漏 payload、非法回退、错误 turn；测试先完成 typecheck。RED checkpoint `fcebdab9`。|
|序列化新增 RED|旧记录等价重放、任意 legacy turn、文档 provider 边界缺失分别复现，补齐兼容规则后 GREEN。`c7df9503`、`2e734040` 保存额外 reproducer。单例过滤的其他案例未执行，未计入实际验收。|
|最终受影响模块|18文件 **216 passed / 0 failed / 0 skip**，含新 canonical MySQL **35项**和 T04-A MySQL/JWT/WS **25项**；兼容生命周期、Chat、memory、projection 和 history。|
|既有真实 canonical-history|八个场景通过；505事实稳定分页/JSONL/hash、partial→completed、legacy rollback、真实提交 ack loss、并发 service 恢复、JSONL 故障下 SQL 恢复、整 turn 保留策略。|
|当前执行恢复 gate|`agent-runtime-mysql.ts` 退出0；普通 Chat 真实 SQL/JWT/WS、OS-process-exit-before-commit、OS-stream-crash-durable-tool-anchor-restored、unknown settlement、取消与 effective snapshot fixtures通过。首次 PR head `998476a8` 的 browser-qualification 在崩溃 anchor 缺 persistedAt 时失败（CI run 38224615641）；新增 RED `fd2bd391` 后修复，重新核验新 head CI，不使用旧结果。|
|真实浏览器 Chat 兼容 gate|未改动的 `streaming-live.spec.ts` **1 passed / 0 skip**，真实 MySQL→Adapter→WS→Gateway→reducer→UI，100000字节/100次工具执行、活动连接刷新、唯一最终回答、重新刷新已完成投影和性能断言全部通过。前一 head `2e6972cd` 的 CI 38225872357 在此 gate 失败：Parts 显示摘要与 raw 不一致导致 canonical conflict，保存大体积错误回答又触发 TEXT 超长（次生错误）；上述序列化修复解除初因，未改 schema/Chat错误存储或门禁。|
|核心 Parts/Projection|2文件 **30 passed / 0 failed / 0 skip**；未修改 agent-core 的公共 Parts schema。|
|权限与静态|security:agent 187 passed / 0 skip，security:scan、API typecheck、contracts:check、focused lint（0 warning/error）、diff check passed。安全全套与模块存在重叠，不累加冒充独立案例。|

新35项包括完整同 ID 并发重放、数组次序差异、metadata/Parts/未知字段冲突、合法 status 和工具生命周期、终态拒绝、事务回滚且 checkpoint 不前移、wrong actor/session/read-share、实际 COMMIT ack loss、冷 service/history/投影 hash 一致、真实 JWT/WS 四工具/多迭代及100KB输出后冷 adapter 读取 SQL 历史且不重复执行工具、旧格式只读重放及 generating boundary 保留。

最终 head、准确 head CI、PR/merge SHA 和 main 包含关系在 MAX-147 交付附件记录，不能用旧 head CI 代替。未修改 CI 或绕过其门禁。

## 有界审查与限制

已按调用链复核：写入前拒绝被归一化掩盖的终态/引用冲突；完整比较覆盖 metadata/Parts/legacy；只有显式单调字段可 UPDATE；事务内同 turn 绑定与 Session 行锁保留；任何冲突均 rollback/release；exact/旧默认等价重放保持原 SQL 行；getPage 继续使用原 owner/read share 谓词与 v1 兼容 reader。普通 read share 和服务主体无新增权限。没有再次派生代理或运行全仓 Review。

没有覆盖全部历史损坏数据或自动修复；非法同 ID 内容需要上层明确处理，不能忽略错误继续推进。上述 fixture 验证普通 Chat 的真实 OS 进程退出恢复，不冒充完整调查跨 Worker 执行/取消验收。真实浏览器证据只覆盖上述既有 Chat streaming fixture；没有声称真实付费 provider、完整 Investigation 产品浏览器 E2E 或完整 V1 已验收。最终完整 V1 gate 仍归 T12；T04-B/T05 完整功能需父任务另行准入。本出口正常合并后仍保持 in_review 等父核验，不标完整 T05 done。实际 token/费用遥测不可用，未设置硬预算。
