# MAX-238 B2E：未挂载 MySQL host 与严格 payload codec

2026-10-27。实现 + focused tests 提交 `0493096fdfd245b5e30ecffcb1e2a4c97ce53e3a`，边界收敛（`resource_key` 上限对齐既有 255 字节列）提交 `2a9606c00`，基线为已接受的 B2D-R1 交付 HEAD `14af2725831aa8c41a97b85f3fb307d7d10620b3`（只在其上追加；本文件为后续文档提交）。**本包是未挂载的内部存储端口**：没有默认连接池、没有进程注册、没有路由/调度/正式采集、没有 receipt issuer、没有真实数据库、没有 DDL 执行。真实接线见 `wiring-gates.md` 与 `b2e-candidate-schema.sql`。

## 1. 允许文件与实际 diff

| 文件 | 行数 | 变化 |
| --- | ---: | --- |
| `apps/db-ops-api/src/metrics/bindings/persistence-codec.ts` | 472 | 新增：`templates-v1` 顶层 envelope、严格候选/pending/effective 编解码、判别/fence、稳定码。 |
| `apps/db-ops-api/src/metrics/bindings/persistence-codec.test.ts` | 325 | 新增 focused 测试（21 项）。 |
| `apps/db-ops-api/src/metrics/bindings/mysql-host.ts` | 777 | 新增：单 lease MySQL host、同连接读、原子 staging、settle、清理、只读 caller-key 查询。 |
| `apps/db-ops-api/src/metrics/bindings/mysql-host.test.ts` | 975 | 新增 focused 测试（21 项）+ 故障注入 SQL fixture。 |
| `apps/db-ops-api/src/metrics/bindings/index.ts` | 6 | 增加两行内部 export。 |

未改 `transaction-guard.ts`、`transaction-adapter.ts`、`resolve.ts`、`plan.ts`、`preflight.ts`、`compile.ts`、`policy/*`、`packages/*`、`templates/*`、`scheduler/*`、`config/*`、`bulk/*`、`consumers/*`、`rollout/*`、`contracts/*`、路由、server/runner、前端或正式 migrations。没有新增依赖（fixture 只使用现有 vitest，未 import mysql2）。MAX237 T2B `4ed20d4d9` 仅作只读参考，未 cherry-pick，也未把它当作模板 MySQL 读取验收。

文件 sha256（实现最终状态，含边界收敛提交）：

```
1ef08b9a3f75536474c97e481fb3790f7853a6d9443be222648ce53d95394783  persistence-codec.ts
37e4e4117621594e6189a970328d4792c61a3abc1bf250ac9f435f4b193b3a51  persistence-codec.test.ts
e3cf6fbb0f05528e946e9f1a38b168a50ecea47d5e0f19aa29d8d85c263235e9  mysql-host.ts
a58c00523873562ed8722845dc9e143b75bdd1d2e580d3831b8214d408e5de3c  mysql-host.test.ts
96945471e00c9e13dd810c2aa1f5b0b2c167cf989de593a5f1c4e277cf3890e8  index.ts
```

## 2. 存储 payload codec（`persistence-codec.ts`）

### 2.1 两种形态

- **旧 package 行（无 envelope）**：沿用现有 `Published` = `{binding, resolved, published_at, application}`。`binding.template_pins` 缺失或空都合法（`package` 非空）；解码不改键、不补字段，`encodeBindingPayload` 逐字节还原原 JSON。
- **模板行（`envelope: 'templates-v1'` 顶层）**：`{envelope, binding, template_resolution:{pending}, application, effective, published_at}`。`payload.binding` 是原始 `ResourceBindingCandidate`（`package: null`、固定 pins、`revision = target`），不把 envelope 或解析结果交给 strict compiler；`revision` 仍是唯一 CAS 权威，没有第二个 `payload.revision`。

判别顺序与稳定码：

| 输入 | 结果 |
| --- | --- |
| 非 JSON / 非对象 | `BINDING_PAYLOAD_INVALID_JSON` / `BINDING_PAYLOAD_NOT_OBJECT` |
| `envelope` 存在但不是 `templates-v1` | `BINDING_PAYLOAD_UNKNOWN_ENVELOPE` |
| `envelope` + `package` 非空；或旧行 package + 非空 pins | `BINDING_PAYLOAD_AMBIGUOUS_SOURCE` |
| 旧行 package 为空；或模板行 pins 为空 | `BINDING_PAYLOAD_MISSING_SOURCE` |
| 模板行顶层/`template_resolution` 出现未知字段 | `BINDING_PAYLOAD_SHAPE_INVALID` / `BINDING_PAYLOAD_PENDING_INVALID` |
| pending 缺字段、`base+1 ≠ target`、`binding.revision ≠ target` | `BINDING_PAYLOAD_PENDING_INVALID` / `BINDING_PAYLOAD_REVISION_INVALID` |
| plan 的 `kind`/`identity`/`revision`/`resource` 与 base 解析身份不符 | `BINDING_PAYLOAD_PLAN_INVALID` |
| application/effective 互不一致 | `BINDING_PAYLOAD_APPLICATION_INVALID` / `BINDING_PAYLOAD_EFFECTIVE_INVALID` / `BINDING_PAYLOAD_IDENTITY_MISMATCH` |

`bindingPayloadSource(raw)` 是给旧读者的最小 fence：返回 `'package' | 'template'`，歧义或损坏一律抛稳定码。本包只提供 helper，**未修改任何旧读者**。

### 2.2 pending 与 identity 映射

`template_resolution.pending` 显式保存 `base_revision`、`target_revision`、`resolution_identity`、B2C 原始 plan、`decided_at`、`operation_key`。校验要求：

- `plan.identity === resolution_identity`、`plan.revision === base_revision`、`plan.resource` 与 `binding.resource` 相同；
- `binding.revision === target_revision` 且 `base_revision + 1 === target_revision`；
- **不**改写 `plan.revision` 来伪造 target identity；base→target 的映射只由 pending 显式表达。

### 2.3 effective 与 applied_revision

- `application.applied_revision` 与 `effective` 完整保留；写入新的 pending **不覆盖** `effective`、**不提升** `applied_revision`、**不标健康**（`status` 为 `pending`）。
- 旧 package 行只有在 `applied_revision === binding.revision` 时才能证明 `resolved` 属于已应用 revision，此时给出 `{source:'package', revision, resolution_identity:null, resolved}`。
- `applied_revision` 非空但旧行只保留了更新中 revision 的 `resolved` 时，解码返回 `effective_missing: true` 且 `effective: null`：**报告缺失事实**，不把当前 pending 当旧 applied（host 在 staging 前拒绝，见 §3.4）。
- `applied_revision === null` 时允许 `effective === null`；模板 effective 形态为 `{source:'template', revision, resolution_identity, plan}`，同样受 identity/revision 交叉校验。

### 2.4 输入隔离与错误

`decodeBindingPayload` 对对象输入先 `structuredClone`，`encodeTemplatePendingPayload` 对 binding/plan/effective 深拷贝，并在返回前自检解码；输入或解码结果之后的变异都不影响已产生或已存储的值。所有错误只携带稳定码，`error.message === code`，不回显 payload、参数或 driver 文本（测试含敏感值反例）。

## 3. MySQL host（`mysql-host.ts`）

### 3.1 注入与信任边界

- `pool: () => BindingSqlPool | null`：显式注入；`null`/`getConnection` 抛错 → `HOST_UNAVAILABLE`，不 fallback 到 `dbConnection`、不读 env、不注册服务。
- `trustedInputs(connection)`：**只在事务内调用**，返回 `authorize` / `applicationContext` / `mandatoryItems` / `templateVersions` 的同连接视图；四项缺一 → `HOST_INPUTS_UNAVAILABLE`。
- `trustedNow()`：同步受信时钟，直接交给 B2D 守卫；host 从不调用 `Date.now()`。
- host 自己从该连接读取：`payload`（binding + application）、trial receipt、operation（完整 caller-key 查询）、receipt 消费。

### 3.2 SQL 映射（真实语句，参数化）

| 用途 | 语句 |
| --- | --- |
| 策略锁 | `SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE`（恰 1 行，否则 `HOST_LOCK_UNAVAILABLE`） |
| 当前 binding | `SELECT payload FROM metric_policy_bindings WHERE resource_key = ?` |
| staging 前 CAS 读 | `SELECT payload FROM metric_policy_bindings WHERE resource_key = ? FOR UPDATE` |
| receipt | `SELECT payload FROM metric_policy_trial_receipts WHERE receipt_id = ? LIMIT 2` |
| operation 精确查询 | `... WHERE caller_key = ? LIMIT 2`（0 行才 `complete:true, null`；2 行 = 损坏） |
| receipt 消费 | `SELECT caller_key FROM metric_policy_operations WHERE receipt_id = ? LIMIT 2` |
| operation 写入 | `INSERT INTO metric_policy_operations (caller_key, receipt_id, resource_type, resource_id, resource_key, target_revision, candidate_digest, resolution_identity, dependency_digest, status) VALUES (?,?,?,?,?,?,?,?,?,?)` |
| binding CAS | `UPDATE metric_policy_bindings SET payload = ?, group_id = ? WHERE resource_key = ? AND JSON_EXTRACT(payload, '$.binding.revision') = ?`（受影响行必须恰 1） |
| 审计 | `INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)`，payload 为自有模板审计形状 |

所有键参数以 `Buffer.from(value,'utf8')` 传入 VARBINARY 列，比较逐字节；不回退到可能忽略大小写/尾空格的 collation。operation 的 `caller_key` 与 `receipt_id` 各一个全局 UNIQUE，receipt 消费**就是** operation 行上的 `UNIQUE(receipt_id)`：四类逻辑状态（operation / receipt 消费 / binding / audit）对应**三个物理写入**，不另建消费账本。无分页/截断窗口、无内存生产 map。

### 3.3 stage → settle

1. 在写前完整校验 intent：strict schema、`base+1 === target`、binding revision、plan 身份、三身份与 receipt/audit 交叉、UTF-8 字节上限、payload/audit JSON ≤ 1 MiB。
2. `SELECT payload ... FOR UPDATE` 重读当前行；解码失败或 revision 不符 → 回滚后 `rejected`（`REVISION_CONFLICT` / `UNAVAILABLE`）。
3. `effective_missing` → 回滚后 `rejected UNAVAILABLE`（既有存储缺口，不伪造历史）。
4. intent 的 `applied_revision`/`previous_resolution_identity` 与当前行不一致 → `DEPENDENCY_CHANGED`。
5. 依次写 operation、CAS 更新 binding、写 audit；任一步失败先**确认整体 rollback**，再返回 `rejected`。唯一冲突不解析 driver 文本：回滚后按 `caller_key`/`receipt_id` 复查，区分 `OPERATION_CONFLICT` 与 `RECEIPT_CONSUMED`。
6. `settleApplication` 只接受 stage 返回的**同一对象句柄**，且只消费一次：`commit` 成功才报 `committed`（revision 必须等于 target）；commit 抛错/ack 丢失一律 `unknown` 并 `destroy` 连接，不尝试把可能已提交的事务说成 `rolled_back`。

### 3.4 连接生命周期矩阵

| 路径 | 事务处理 | 连接 |
| --- | --- | --- |
| `getConnection` 失败 | 无 | 无连接 |
| `beginTransaction` 失败/状态不明 | 不回滚（状态未知） | **destroy** |
| 锁缺失/锁查询失败 | 回滚 → 失败则 destroy | release / destroy |
| trusted factory 缺失/抛错 | 回滚 | release / destroy |
| 守卫拒绝（legacy/replay/lookup/各稳定码） | 回滚（只读） | release / destroy |
| stage 校验失败/读失败/编码失败 | 回滚 | release / destroy |
| stage 写失败（含唯一冲突） | **恰一次**回滚；未确认 → `commit_unknown` | release / destroy |
| settle commit 成功 | 已提交 | release |
| settle commit 失败/ack 丢失 | 不再回滚 | **destroy** |
| 任一写完但回滚未确认 | — | **destroy**，不重投池 |

没有重试、死锁自动 rerun、第二 lease 或后续隐式提交；unknown 只允许调用方按 `caller_key` 查询原 operation。

### 3.5 只读 caller-key 查询

`lookupOperation(callerKey)` 取一个连接做一次完整精确查询后 release：不发 `BEGIN`、不加锁、不写 unknown 行、不重发 mutation。`complete:false`（2 行）和查询失败都**不**等于“可以安全重放”；零行才是 `complete:true, operation:null`。

## 4. 验证（实现提交 `0493096fd`，Node v24.18.0 / pnpm 11.19.0）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings/persistence-codec.test.ts src/metrics/bindings/mysql-host.test.ts` | 2 files / 42 passed | 0 |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings` | 8 files / 258 passed | 0 |
| `pnpm --filter slide-api exec vitest run src/metrics/bindings src/metrics/policy src/metrics/scheduler src/metrics/packages src/contracts/metrics` | 18 passed + 4 skipped files；454 passed + 36 skipped | 0 |
| `pnpm --filter slide-api typecheck` | 无错误 | 0 |
| `pnpm contracts:check` | 无差异（未改契约） | 0 |
| `pnpm exec oxlint apps/db-ops-api/src/metrics/bindings` | 0 warnings / 0 errors | 0 |

focused 覆盖要点：

- **codec**：旧行无 pins 逐字节 roundtrip、显式空 pins、两种 envelope、严格 raw candidate、歧义/缺身份/未知 envelope、pending base→target、plan 身份与资源、旧 applied/effective 保留与缺失事实、application/effective 交叉、输入输出变异隔离、错误不含敏感值。
- **SQL fixture**（离线，非 MySQL）：记录每条语句的真实参数、连接 id 与时序；建模两张新表的两个唯一约束、commit/rollback、`affectedRows`。
- **host**：完整成功序列 `begin,lock,bindingRead,operationRead,bindingRead,receiptRead,consumptionRead,bindingLock,operationInsert,bindingUpdate,auditInsert,commit,release` 且全部在同一连接；4 类状态一致（3 个物理写）；参数为 UTF-8 Buffer 且 CAS revision = base；capabilities 列未改；legacy/replay/unknown 零 staging；CAS 冲突、caller/receipt 冲突、大小写/尾空格变体、operation 损坏、receipt 读失败、v1 receipt；commit ack 丢失 → `commit_unknown` + destroy + 只查原 operation + 无第二次 `begin`；begin 失败/锁缺失/最终 CAS 读失败/audit 失败/回滚未确认/输入工厂缺失的连接清理；旧行 effective 缺失拒绝且行不变；只读查询零写、零事务。
- **反例**：`treats the stage acknowledgement as no commit at all`（commit 抛错时若把 stage ack 当 committed 会失败）与 `reports commit_unknown ... when a failed write cannot be rolled back`（若省略清理/回滚确认会失败）。

## 5. 共享读者 wiring-gates 逐项状态

本包只交付可复用的 codec/SQL host，不修改下列任何入口；`wiring-gates.md` 中的下一包（B2F）仍需按准确 HEAD 登记单写者。

| 接线对象 | 本包状态 | B2E 提供 / 仍缺 |
| --- | --- | --- |
| `policy/store.ts` / `model.ts` / `service.ts` | **未接线** | 提供严格 payload 编解码与 staging SQL 形状；缺同 lock/lease 的模板 writer、完整 operation 查询与 receipt 消费接线、旧 package writer 共存。 |
| `scheduler/store.ts`（list/current/enqueue）、`scheduler/service.ts` / `compiler.ts` | **未接线、未 fence** | 仅提供 `bindingPayloadSource` 判别入口；这些入口仍直接 SELECT/compilePlan，遇到模板行没有稳定 skip/reject。 |
| `config/service.ts` activate/trial、`status.ts` | **未接线** | pending 不健康/不提升 applied 的存储语义已固定；缺逐项 receipt 与真实 issuer 结果。 |
| `bulk/service.ts`、`consumers/*` | **未接线** | 无模板分流；仍按单 package `resolved.plan.binding.package` 假设。 |
| `rollout/{coordinator,formalization}.ts` | **未接线** | 无模板 fence；PackagePinSchema 与正式化证据仍是单 package。 |
| `templates/mysql-repository.ts` @`4ed20d4d9` | **只读参考** | B2E 的 template reader 通过注入 factory 绑定当前连接；未集成 237 的仓库/事务 adapter，不声称模板 MySQL 读取已验收。 |
| receipt issuer、route/server/contracts | **未实现** | 只读 `metric_policy_trial_receipts` 的受信行；不签发、不从客户端或单 good sample 伪造 receipt，也未改公共 schema/路由。 |

## 6. 明确未证明（不得折算为完成）

- 未连接真实 MySQL，未执行任何 DDL/迁移，未验证真实 InnoDB 唯一键、锁等待、deadlock、`JSON_EXTRACT` 行为或 commit-time 语义；fixture 只证明本模块的 SQL 文本/参数/生命周期契约。
- 未接线任何读者：`policy/store.ts`、`scheduler/*`、`config/*`、`bulk/*`、`consumers/*`、`rollout/*` 仍按单 package 处理模板行；`bindingPayloadSource` 只是给下一包的 fence，未提供保护。
- 未实现 receipt issuer、正式试采逐项结果、真实授权/inventory 端口（由注入 factory 提供，fixture 不是权限保证）。
- 未做真实 CAS 演练、真实事务回滚演练、负载/部署或生产启用；`metric_policy_operations`/`metric_policy_trial_receipts` 只在候选 SQL 文档中，未进入正式 migrations。
- 判读后的 `BINDING_PAYLOAD_*` 只在读取路径出现；旧读者尚未捕获，因此本包不能声称旧读者已安全。

MAX238 与父 MAX235 保持 `in_progress`；原五项 / A01–A22 / 四标准 / D05 / O02 / O03 保留。
