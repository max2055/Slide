# MAX238 B2F 终态复审：有限接受

准确开发 run `01a17ca6-2433-7630-8a10-436b0f96d93f` 已完成（2026-10-27T09:30:21Z）。base `90dc2bf861c66323765d51974bd9d70de0787fbe`，实现 `3d5d93ddfda0424af8ed8e835fcd1954871c4ae7`，交付 HEAD `d968892b6cea1972d6d1958749a8af6cab5d3301`。交付评论 `01a17cb2-12a5-7b15-85ea-cd19d74f7f4b`。本复审 run `01a17d36-cf95-7169-bbd5-e5158f562d0f`。

原终态回调 `01a17ca6-602c-791b-83fb-510add38f9f5` 已触发一次并 disabled。它的 last task `01a17cb2-8539-7626-a006-d084426a473f` 因 Provider usage limit 失败，没有留下复审结论。本 run 是该失败的人工恢复：完成这份复审和下一步源码交接。不重新启用该回调，不另开 Chief，不把 usage limit 当成产品预算耗尽，不盲重放 B2F 开发者。

结论：有限接受 B2F 的真实入口 fence 和显式注入 gateway。没有重审 B1–B2E-R1，没有同 phase/head 的已接受结论，也没有另一位 Chief 在复审这个 head。父问题成员评论 `01a17d37-fe3e-7d2c-9ab9-c2921212dbc6` 只询问子任务状态，不是暂停或取消。MAX238 与父 MAX235 保持 in_progress。原五项、A06/A07/A09/A16/A20、全批 A01–A22、四标准、D05/O02/O03 不缩减。

## 源码与边界

相对 base 共 14 个文件，+1371/−49，全部落在 b2f-admission 允许范围内。`policy/service.ts` 与 `policy/model.ts` 的 blob 与准入登记相同，未改。hash 见 reviewed-file-hashes.json。没有 route、公开 contract、migration、frontend 或 DDL。coder 分支只在本地，未推送。

| 准入入口 | 交付 HEAD 上的实际行为 |
|---|---|
| 共用解码 | `readStoredBinding` / `readLegacyPublished` 只走已接受 `decodeBindingPayload`。无 envelope 与 `package-v1` 仍是 `Published`。`templates-v1`、未知 envelope、歧义来源、坏快照失败关闭，不回显 payload/driver。 |
| policy 边界 | 模板行映射为 `PolicyError('TEMPLATE_BINDING_UNSUPPORTED', 409)`，codec 错误映射为 `POLICY_BINDING_INVALID`。`members()` 在 `changeGroup` 写之前抛出。`saveBinding` 在 upsert 前 `FOR UPDATE` 重读并拒绝模板行。`reportApplied` / `reportCapabilities` 先走 `tx.binding`。 |
| audit | `isTemplateAudit` 识别 operation 身份键或 `configuration.template_pins` 后拒绝，不把模板 audit 铸成 legacy configuration。最近 100 条仍不是完整 operation 查询。 |
| scheduler | `scan()` 按行隔离，合法 legacy 继续。`list()` 遇非 legacy 整表失败。`tick` 使用 `scan`。直接 `enqueue` 在 `instanceAccessLifecycle` 之前调用 `readLegacyPublished`。任务处理对模板/坏快照写一条 `metric_schedule_events`（`template_binding_unsupported` / `binding_payload_invalid`）后 return，不抛出重试。`current` / `assertCurrent` / `begin` / `commit` / `recordFailure` 经 `current` → `readLegacyPublished`。 |
| rollout | coordinator 在 pin 之前 `readLegacyPublished`。formalization `accept` 对模板返回 `'template'`，`reconcile` 删除缓存且不写正式化证据；坏快照仍抛出并回滚。 |
| portfolio | 任一模板行使 `list()` 抛出 `PORTFOLIO_TEMPLATE_BINDING_UNSUPPORTED`。公开类型表达不了模板绑定，代码留有产品 TODO。这是准入里的整表稳定拒绝，不是静默过滤。 |
| monitor | 无 binding 行在环境开关和 `assetCollectionEnabled` 之后保持旧的默认 true。模板或任何读异常返回 false，不把异常当成 enabled。 |
| config / bulk / consumer | 产品源码未改。中央 fence 在 `PolicyService` → store。测试证明 `trial` / `status` 在 reserve、credential、runner 之前拒绝；`discover` 在 inventory 之前拒绝；`preview` 拒绝该项且不再增加 policy 写。 |
| gateway | `MysqlPolicyStore(provider, {trustedInputs, trustedNow, registry}).templateGateway()` 调用已接受 `MysqlBindingHost`。同一 pool，导出的 `withPolicyAdmission`。锁序：admission → host BEGIN → `metric_policy_lock id=1 FOR UPDATE` → 行锁。缺 options 的默认 store 抛 `TEMPLATE_GATEWAY_UNAVAILABLE` 且不取连接。只写 pending 候选，旧 effective 与 `applied_revision` 保留。不是第二套事务。 |

`bindings/index.ts` 只增加 `export * from './package-reader.js'`。已接受 codec/host/guard/adapter 不在 diff 中。

## 非阻塞记录

这些不推翻有限接受，下一包不要顺手改它们：

- `valid()` 对 instance 仍先调用 `instanceAccessLifecycle.assertAvailable`，然后才 `current()`。任务处理里第一次 `current()` 在 credential resolve 和 `runPackage` 之前，模板拒绝发生在采集和 applied UPDATE 之前，事务在抛出时回滚。credential resolve 与 `begin` 之间的替换最多多一次 `assertAvailable`，随后仍在写之前拒绝。
- portfolio 拒绝的是整份 inventory，不是单资源。
- bulk `preview` 仍 `store.create` 一条草稿任务；确认路径只排队 eligible。测试看到的 policy 写计数停在种子数据。
- `publishedOf` 是 codec 已证明 legacy 之后的类型转换，不是第二套 resolver。
- `isTemplateAudit` 是键启发式。fixture 里真实 host audit 会使 `audits()` 抛 `TEMPLATE_BINDING_UNSUPPORTED`。
- gateway 包装层没有重跑 B2E 的 collision/cleanup 矩阵。host `apply` 未改，不要求在包装层复制该矩阵。
- 提交后的受影响套件是 `FINAL_EXIT=0`（9 files，45 passed / 60 skipped，17:29:51，含 scheduler 与 rollout，因此包含 portfolio 拒绝）。模块 740、operations 349、tsc 与 oxlint 记在 portfolio 这次只加整表拒绝的编辑之前。Chief 没有为汇报重跑它们。operations 源码不在 diff 中。

未挂载、本包不声称已接完：`rollout/formal-store.ts`、`config/status-store.ts`、`src/consistency-checker.ts`（S5/MAX-240）、operations baselines 仍只哈希 binding，legacy-write-fence 仍只查存在。生产启用、真实 DB、两表 DDL、真实写、权限、负载、237 同连接模板读口、真实逐项采集仍暂停。

fixture 不是 MySQL，也不是 CAS、权限、试采应用或正式样本通过。

## 复用证据

读取准确 run 的工具输出，详见 reused-checks.json。Chief 没有重跑这套测试，没有全量、CI、模型或真实 DB。

## 立即接续

接受后推进 `MAX238-B2G-TRIAL-RECEIPT-ISSUER`：离线编译已接受的 v2 receipt，并用 fixture 插入 `metric_policy_trial_receipts`。见 b2g-admission.md 与 b2g-file-ownership.json。只新增签发文件。不改 host/guard/codec/gateway/store。不伪造客户端 receipt，不用一条合格样本代替逐项证据。不执行 DDL，不调用真实采集或 `config.activate`，不接 237 的独立连接仓库，不把 pending 提升为 applied。

签发后的撤销仍暂停：`verifyReceiptTime` 只有签发/过期，没有撤销字段。不要加一列 host 不会读的 revoke 列。真实试采 IO、生产写、公开路由和默认启用继续按各自门槛暂停，不泛等 MAX-236 整单完成，常规源码不再向 Max 重要授权。
