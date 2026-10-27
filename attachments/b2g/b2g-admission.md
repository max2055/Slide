# MAX238-B2G-TRIAL-RECEIPT-ISSUER

唯一开发者 15coder1，分支 `agent/15coder1/max-238`，准确 base `d968892b6cea1972d6d1958749a8af6cab5d3301`，只追加。先 fresh 父 policy/watch/handoff、本 Issue/metadata/评论/run。成员新暂停或取消优先。同 phase 已有活跃 run 或准确 callback 不重复。B2F 已有限接受。B1–B2F 未变证据复用，不重审。

目标：在进程内编译一张已接受 host 能读到的 v2 trial receipt，并用同一 policy pool 把它插入候选表 `metric_policy_trial_receipts`。交付真实编译函数、插入函数和 fixture 证明。不交付真实采集、公开路由或生产签发。

## 文件与单写者

逐文件 blob/hash 在 b2g-file-ownership.json。base 上列出的文件全部只读，writer 只有本包新文件。

允许新增：

- `apps/db-ops-api/src/metrics/bindings/trial-receipt-issuer.ts`
- `apps/db-ops-api/src/metrics/bindings/trial-receipt-writer.ts`
- `apps/db-ops-api/src/metrics/bindings/trial-receipt-issuer.test.ts`
- `docs/slide/development/MAX-238/b2g-trial-receipt-issuer.md`

除此之外不得修改。特别是 `transaction-guard.ts`、`mysql-host.ts`、`resolve.ts`、`plan.ts`、`persistence-codec.ts`、`package-reader.ts`、`policy/store.ts`、`policy/template-gateway.ts`、`policy/service.ts`、`config/service.ts`、scheduler、rollout、monitor、公开 contracts、routes、migrations。不得为了导出私有 schema 去改 guard。不得新增依赖，不得 merge/cherry-pick 236/237 整支。

## 1. 编译，不发明第二套协议

host 只执行 `SELECT payload FROM metric_policy_trial_receipts WHERE receipt_id = ? LIMIT 2`（`mysql-host.ts` 的 `receiptRead` / `getTrialReceipt`）。插入行必须能被这句读回。

payload 必须是 guard 私有 `TrialReceiptV2Schema` 能接受的对象，字段仅限：

- `receipt_version: 2`
- `receipt_id`、`resource`、`base_revision`、`target_revision`
- `candidate_digest`、`resolution_identity`、`dependency_digest`
- `issued_at`、`expires_at`
- `items[]`：`template_id`、`item_id`、`item_version`、`phases.read`、`phases.transform`、`phases.unit`
- `optional_exclusions[]`

`candidate_digest` 必须等于导出的 `bindingCandidateDigest(candidate, targetRevision, dependencyDigest)`，格式常量 `BINDING_CANDIDATE_DIGEST_FORMAT = 'max238.binding-candidate.v1'`。`resolution_identity` 必须等于导出的 `templateResolutionIdentity(resolution)`，格式常量 `TEMPLATE_RESOLUTION_IDENTITY_FORMAT = 'max238.template-resolution.v1'`。禁止用客户端传入的哈希、常量或另写一套摘要。

`target_revision` 沿用 guard：候选 `binding.revision` 为 base，target 为 base+1。依赖摘要来自注入的受信输入，不来自请求体。

请求可以提供 receipt id 作为幂等键，不能提供 receipt 正文、items、digest 或 resolution identity。出现这些字段就拒绝并且零写。

## 2. 逐项证据，插入前拒绝

证据来自注入的离线证据端口，按候选里每个选中项给出 read/transform/unit。缺端口时稳定不可用，零连接。

插入前必须拒绝并且零写：

- 用一条合格项代替其余项
- 必选项缺失，或选中项没有显式的非必选排除
- 任一已声明 phase 不为真
- 证据在插入前已是 withdrawn 或 failed
- 客户端 receipt 正文
- `issued_at` / `expires_at` 不能满足 guard：`expires_at` 必须晚于 `issued_at`，且签发时的受信 now 满足 `issued_at <= now < expires_at`

签发后的撤销不在本包。`verifyReceiptTime` 没有撤销字段。禁止新增 revoke 列或 host 不读的状态列。该缺口登记为 `receipt_revocation_host_check`，继续 held。

## 3. 插入

writer 从 `policy/store.ts` 导入已导出的 `withPolicyAdmission`，使用调用方注入的同一个 pool provider。禁止新 pool，禁止在这张事务里 `BEGIN` 嵌套或获取 `metric_policy_lock`，禁止调用 `host.apply`、`templateGateway`、`config.activate` 或 237 的独立连接仓库。receipt 提交与稍后的 apply 是两次事务。

默认或缺失 provider：稳定不可用，零连接。

SQL 只写 host 会读的两列：`receipt_id` 与 `payload`。不执行 DDL，不发明其余列。仓库文档里没有可复制的 `CREATE TABLE`。真实 UNIQUE、collation 和锁等待仍未证明；fixture 必须模拟下列结果，并注明它不是真实唯一索引：

- 同 `receipt_id` 零行：插入一行。
- 一行且 payload 字节相同：replay，零写。
- 一行且 payload 不同：collision，零写。
- 两行或查询失败：失败关闭，零写。

## 4. 必须证明的 fixture

用导出的 `prepareTemplateBindingMutation` 读取刚插入的 payload（端口的 `getTrialReceipt` 返回该 payload，形状与 host 的 SELECT 一致）。合法逐项证据必须通过 guard 自己的 v2 解析、身份、时间和逐项检查。下列输入必须在插入前失败，或在被 guard 读到时失败，并且业务写计数为 0：单条合格样本、缺必选 phase、客户端正文、withdrawn/failed、digest 与 `bindingCandidateDigest` / `templateResolutionIdentity` 不一致、缺 provider。

不要复制一份 `TrialReceiptV2Schema` 来自称通过。不要把 fixture 写成真实 MySQL、CAS、权限或试采通过。

运行新 focused 测试、新文件的 typecheck 与 oxlint。未改的 bindings/policy/scheduler 复用 B2F `FINAL_EXIT=0` 与既有模块证据，不为汇报重跑全量、CI、模型或真实 DB。

## 仍暂停

| wait_kind | next_action | input_owner | minimum_resume_fact |
|---|---|---|---|
| receipt_real_io | 本包只做离线编译和 fixture 插入；真实采集另核授权 | MAX238；资源/权限 owner | 逐项来源、资源/凭据引用、读范围和有效授权 |
| receipt_revocation_host_check | 保持 host 不读撤销；不要加假列 | Chief；MAX238 | host 实际会执行的撤销检查被单独准入 |
| isolated_db_ddl | 不执行两表 DDL | DB owner | schema 版本、备份窗口、真实写授权 |
| template_read_port | 不调用 237 独立 pool 仓库 | MAX237 | 同连接模板读口 |
| s5_and_public_api | 不改 status/formal-store，不加公开试采路由 | MAX240；Chief | 单独的读者和公开契约准入 |
| production_enable | 不默认启用，不 promote applied | 发布 owner | 代码、演练、部署和生产写授权 |

父子 in_progress。不自行建立 wakeup。一条结果评论。禁止子代理、产品模型、MAX224 账本、真实资源、共享部署和 push。
