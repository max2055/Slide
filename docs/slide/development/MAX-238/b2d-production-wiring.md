# MAX-238 B2D 之后：生产存储、envelope、receipt 与旧读者接线决定

2026-10-27。基于 B2D 实现提交 `688e9657498630b5eb3e685e2fb8dc5e50bae794`、端口收敛 `f448a00206bdd8929d50be0dbdb891941329482a`（基线 B2C `26859b119`）。本文件是**设计决定与准入材料**，不是已实现能力：没有新增 DDL、没有执行任何 SQL、没有生产写、没有 receipt issuer、没有旧读者修改。行号对应本包 HEAD，接线前必须重新核对。

## 1. 当前真实读者与唯一写者

| 角色 | 现有源码（本包只读） | 模板分支要求 |
| --- | --- | --- |
| 唯一写者（目标） | `policy/service.ts:96 changeBinding` → `tx.saveBinding` + `tx.audit`；`:136 changeGroup` → `tx.saveGroup` + 每成员 `saveBinding`/`audit`；事务入口 `policy/store.ts:76 transaction`、`:92 metric_policy_lock id=1 FOR UPDATE` | 模板 enable 只能由一个写者完成：同事务 operation 占用 + receipt 消费 + binding 保存 + 审计。legacy 单 package 仍由 `changeBinding` 独占，不双写。 |
| 类型/权威 | `policy/model.ts:38 Binding`、`:41 Resolved`、`:54 Applied`、`:55 Published`、`:56 Audit`、`:58 refKey` | 新增显式 envelope 与模板快照；`payload.binding.revision` 仍是唯一 CAS，不新增第二个 `payload.revision`。 |
| 读：预览/生效 | `policy/service.ts:34 resolve`、`:44 binding`、`:52 effective`；`policy/resolver.ts:132 resolvePolicy` | `resolvePolicy` 只接受 package 绑定；模板 envelope 必须先分流到 B2C，禁止把 `package:null` 传给 `registry.get`。 |
| 读：调度 | `scheduler/compiler.ts:57 compilePlan`（单 package）；`scheduler/store.ts:50 compilePlan(published.resolved)`、`:137-139 resolvePolicy+compilePlan`、`:185-192` 观测校验与 `registry.get(published.binding.package)`；`scheduler/service.ts:60 initial compilePlan`、`:73` settings、`:83 runPackage(published.binding.package)`、`:90` | 模板行在调度器必须显式拒绝/跳过，不能当成单 package 执行；多 release 运行器另包准入。 |
| 读：试采/激活 | `config/service.ts:22 ActivationGuard`、`:47 activate`、`:55` “某个 good sample”门禁、`:83 trial`、`:113 before_request`；`config/status.ts:26/52/82` | 模板 enable 不走 `activate/trial` 的单 package 分支；trial 的真实逐项结果由 receipt issuer 映射。status 不能把 pending 当健康。 |
| 读：批量 | `bulk/service.ts:167 next.resolved.settings` | 只接受 package-v1；模板批量变更本阶段拒绝。 |
| 读：消费端 | `consumers/baseline.ts:17/21/22`、`observations.ts:15`、`resource-api.ts:14`、`operational.ts:26/29`、`service.ts:50/71/86` | 这些读者用 `resolved.plan.binding.package`；模板行必须 fence，不能伪造单 package。 |
| 读：推广/正式化 | `rollout/coordinator.ts:135 PackagePinSchema.parse(published.binding.package)`、`:177/184/243/247/295`；`rollout/formalization.ts:71/78/100/118/138/156/159` | 模板行在 rollout/formalization 显式 `*_TEMPLATE_UNSUPPORTED`，不写正式化证据、不改 generation。 |
| 执行 | `packages/runner.ts:45 runPackage` | 仍以 `Selection.package` 为输入；多 release 执行不在本项。 |

结论：模板配置**不能**复用任何一个以 `binding.package` 为输入的读者。必须先加显式 envelope 判别与 reader fence，再谈接线。

## 2. 生产显式模板 envelope / discriminant

在 `payload.binding` 上新增（仅新写入行）：

```ts
type BindingEnvelope = 'package-v1' | 'templates-v1';

type Binding =
  | { envelope: 'package-v1';  resource: Ref; package: PackagePin;  group_id: string | null;
      overrides: Overrides; revision: number; template_pins: [] }
  | { envelope: 'templates-v1'; resource: Ref; package: null;        group_id: string | null;
      overrides: Overrides & { template_parameters?: Record<string, Record<string, unknown>> };
      revision: number; template_pins: [TemplatePin, ...TemplatePin[]] };
```

规则：

- `templates-v1` 必须 `package === null` 且 `template_pins` 非空；`package-v1` 必须 `package !== null` 且 pins 为空。
- 空 pins + `package:null` 仍由现有契约 `BINDING_PIN_REQUIRED` 拒绝。
- `package !== null` 且 pins 非空是歧义，新增稳定拒绝 `BINDING_ENVELOPE_AMBIGUOUS`，不做“优先 package”的静默选择。
- `Published` 顶层增加同名字段：

```ts
type Published =
  | { envelope: 'package-v1'; binding: PackageBinding; resolved: Resolved;
      published_at: string; application: Applied }
  | { envelope: 'templates-v1'; binding: TemplateBinding;
      template_resolution: {
        effective: { revision: number; resolution_identity: HashId; plan: TemplateCollectionPlan } | null;
        pending:   { revision: number; resolution_identity: HashId; plan: TemplateCollectionPlan;
                     decided_at: string; operation_key: string } | null;
      };
      published_at: string;
      application: Applied };
```

模板变体**不**伪造 `resolved`。任何旧读者在模板行上访问 `published.resolved` 会得到 `undefined`——这必须由显式 fence 变成稳定错误，而不是靠运行时 TypeError 兜底。`application.status='pending'` 时 `effective` 保持上一份已应用计划，新计划只进 `pending`；`applied_revision` 不前进。这正是 B2D 意图中的 `application.applied_revision`/`previous_resolution_identity` 与 `pending.plan` 的落点。

## 3. legacy 无 `template_pins` roundtrip

`normalizeBindingEnvelope(payload)`：

1. 无 `envelope`（历史行）：
   - `package !== null` 且（`template_pins` 缺失或空）→ 归一为 `package-v1`，**内存中不补写** `envelope`/`template_pins`；若本次操作不改 binding，写回保持原字节（JSON 键序由现有序列化决定，不新增键）。
   - 其他组合 → 稳定拒绝，不猜测。
2. `envelope: 'package-v1'` → 必须 package 非空、pins 空；缺 `template_pins` 视为空（与 B2B 守卫一致）。
3. `envelope: 'templates-v1'` → 必须 package `null`、pins 非空。

只有模板分支的新写入会加上 `envelope` 与 `template_pins`；历史 package 行在首次真实变更时由现有写者按原模型写回（是否补 `envelope` 由该写者版本决定，读取两侧都接受两种形态）。

## 4. 旧读者 fence（具体文件与稳定码）

以下每处都必须显式判断 `envelope`/`binding.package === null`，不得依赖空值异常：

| 位置 | 行为 |
| --- | --- |
| `policy/service.ts:34 resolve` | 模板行分流到 B2C preview；`resolvePolicy` 调用前 `rule(binding.package !== null, 'POLICY_TEMPLATE_ENVELOPE')`。 |
| `policy/resolver.ts:132 resolvePolicy` | 入口拒绝非 package envelope（防御性，防止绕过 service）。 |
| `scheduler/store.ts:50/137/139/185` | 模板行 `rule(published.envelope === 'package-v1', 'SCHEDULE_TEMPLATE_UNSUPPORTED')`；调度候选查询直接排除模板行，不进入 `compilePlan`。 |
| `scheduler/service.ts:60/83` | 同上；`runPackage` 永不接收 `package:null`。 |
| `config/service.ts:47 activate` / `:83 trial` | 模板绑定不得走单 package `activate/trial`；模板 enable 只经 B2D adapter 的显式入口，未接线前返回 `CONFIGURATION_TEMPLATE_UNSUPPORTED`。 |
| `config/status.ts:26/52/82` | 模板行读 `template_resolution`；未接运行时前返回“模板运行时未就绪”，不返回健康/已应用。 |
| `bulk/service.ts:167` | 模板行 `BULK_TEMPLATE_UNSUPPORTED`。 |
| `consumers/*`（第 1 节列出的行） | 模板行不暴露单 package engine/interval；需要新消费者契约，另包准入。 |
| `rollout/coordinator.ts:135`、`formalization.ts:71/78` | 模板行 `ROLLOUT_TEMPLATE_UNSUPPORTED` / `FORMALIZATION_TEMPLATE_UNSUPPORTED`；不写正式证据。 |

## 5. v1/v2 receipt 演进

新增表（仅设计，不执行）：

```sql
CREATE TABLE metric_policy_trial_receipts (
  receipt_id            VARCHAR(128) NOT NULL,
  receipt_version       TINYINT UNSIGNED NOT NULL,     -- 1 | 2
  resource_key          VARCHAR(64)  NOT NULL,
  base_revision         BIGINT UNSIGNED NOT NULL,
  target_revision       BIGINT UNSIGNED NOT NULL,
  candidate_digest      CHAR(71) NOT NULL,             -- 'sha256:' + 64 hex
  resolution_identity   CHAR(71) NULL,                 -- v2 only
  dependency_digest     CHAR(71) NOT NULL,
  items                 JSON NOT NULL,
  optional_exclusions   JSON NOT NULL,
  issued_by             VARCHAR(128) NOT NULL,
  issued_at             DATETIME(3) NOT NULL,
  expires_at            DATETIME(3) NOT NULL,
  PRIMARY KEY (receipt_id),
  KEY idx_receipt_resource (resource_key, expires_at)
) ENGINE=InnoDB;
```

- v1 行：`receipt_version=1`、`resolution_identity=NULL`，只供审计与旧 entry；**不回填**（无法在不重跑历史上下文的情况下推导 identity，回填即伪造）。
- v2 行：`receipt_version=2`、三身份齐全；只有 B2D v2 entry 接受。B2D 的两个 strict schema 已实现互斥：v1 receipt 进 v2 是 `TRANSACTION_RECEIPT_INVALID`，v2 receipt 进 v1 同样因 strict 被拒，不做静默升级。
- 过期/撤销：过期是读取时判断；撤销需要 `revoked_at` 时再扩列（本设计暂不加，避免未授权 DDL 面）。
- 迁移顺序：建表（追加式）→ 部署能写/读 v2 的代码（未挂载）→ 接线 issuer → 挂 enable 入口。回退：撤入口；旧行保留、不读；不影响 v1。
- 保留：receipt 行按审计保留期保留；消费事实在 operation 表（`UNIQUE(receipt_id)`），不依赖 receipt 行是否存在。

## 6. changeGroup 与 receipt 失效

- 现有 `changeGroup` 同时提升 group `revision` 与 `policy_revision`，并给每个成员 binding `revision+1`（`policy/service.ts:136` 起）；组变更后所有成员配置都变。
- `dependency_digest` 必须覆盖：group id + revision + overrides、每个成员资源的权限/可见性版本、模板 pin 集合、inventory 兼容结论、credential-reference 版本。任一变化 → 旧 receipt 在 v2 身份比较处即 `TRANSACTION_RECEIPT_MISMATCH`，无需依赖时间过期。
- B2C `resolution_identity` 已覆盖 group id/revision（经 settings 来源）与逐项 capability 决策；group override 变化会改变它（focused 测试已覆盖）。
- 组变更后旧 `resolved`/`template_resolution.effective` 只作历史快照，不能作为 receipt 仍有效的证据；消费 receipt 时必须在锁内重读 group 与成员权限（B2D 的 `applicationContext` + 最终授权边界）。
- 旧 receipt 与 operation 行**不删除**：删除会把重试变成“新操作”，可能重复应用；`caller_key` 永不复用清理。

## 7. 同事务唯一性与保留契约

```sql
CREATE TABLE metric_policy_operations (
  operation_key         CHAR(200) NOT NULL,            -- resource:type#target@candidateDigest
  caller_key            VARCHAR(128) NOT NULL,
  resource_key          VARCHAR(64)  NOT NULL,
  target_revision       BIGINT UNSIGNED NOT NULL,
  candidate_digest      CHAR(71) NOT NULL,
  resolution_identity   CHAR(71) NOT NULL,
  dependency_digest     CHAR(71) NOT NULL,
  receipt_id            VARCHAR(128) NOT NULL,
  status                ENUM('committed','unknown') NOT NULL,
  created_at            DATETIME(3) NOT NULL,
  settled_at            DATETIME(3) NULL,
  PRIMARY KEY (operation_key),
  UNIQUE KEY uk_caller_key (caller_key),
  UNIQUE KEY uk_receipt (receipt_id),
  KEY idx_resource_revision (resource_key, target_revision)
) ENGINE=InnoDB;
```

- 完整精确查询：`SELECT ... WHERE caller_key = ? LIMIT 2`（唯一索引保证最多 1 行；`LIMIT 2` 只用于检测损坏）。B2D 的 `findOperationExact` 只有在能由该唯一索引回答时才返回 `{complete:true, ...}`；审计窗口 100 条、`LIMIT 1` request_id 查询都**不能**充当完整性证明。
- receipt 单次消费 = `UNIQUE(receipt_id)`；`findReceiptConsumption` 映射到 `SELECT 1 ... WHERE receipt_id = ?`。消费与 operation、binding、audit 同一事务写入，由唯一键在并发下裁决。
- 唯一键冲突：staging 显式返回 `{status:'rejected', code:'OPERATION_CONFLICT'|'RECEIPT_CONSUMED'}`（B2D adapter 映射为 `rejected`，零写入）；不允许 catch 后当作成功或重试。
- 保留策略：`committed`/`unknown` 行**无限期保留**。容量治理只用归档/分区（按 `created_at` 月分区，冷存保留主键与唯一键），**不删除**。若未来合规强制删除，必须先引入 tombstone `(caller_key, deleted_at)`，使重试稳定得到 `POLICY_OPERATION_EXPIRED` 而不是被当成新操作——该 tombstone 未准入、未实现。
- 容量估算：单行约 0.7KB（含索引），每次 enable 一条；按资源数 × 变更次数增长。失败/重试不新增行（同 key 命中）；冲突来自不同 key 的并发，属预期。

## 8. 锁次序与 issuer / 消费顺序

**试采（锁外）**

1. 现有 `TrialStore.reserve` 占试采槽（已存在的单资源互斥），执行真实 read/transform/unit IO。
2. issuer 在**独立事务**写入 `metric_policy_trial_receipts`（v2 行，三身份 + 逐项结果 + `expires_at`）。
3. issuer **不**获取 `metric_policy_lock`，避免与 enable 形成反向锁序；它读 binding/capabilities 只作快照，最终以 enable 锁内重算为准。
4. 任一项必需项未测或失败 → 不签发 receipt；可选项排除写入 `optional_exclusions` 并在 UI 明示。

**enable（锁内）**

1. `PolicyService.assertAccess` + `ActivationGuard.reloadActor/assertCurrent`（锁外预检）。
2. 进入 `metric_policy_lock id=1 FOR UPDATE`（`store.ts:92`），同一连接读 binding/group/capabilities；模板版本由 `templateVersions()` 在同一事务连接读取。
3. 重跑 B1→B2A→B2C；完整 operation 查询；receipt 读取；receipt 消费查询。
4. 最终授权复验 + 同步 `serverNow`（B2D 已实现，无 await 决策）。
5. 同事务写：binding（原始候选，revision=target）、operation（`uk_caller_key`/`uk_receipt`）、receipt 消费（同 operation 行）、audit。全部失败则整体回滚，不留下“只回滚 binding”的半状态。
6. host 上报 committed/rolled_back/unknown；unknown 只查原 operation，不重发。

锁序：`metric_policy_lock` → `metric_policy_operations` → `metric_policy_audit`（insert）；issuer 只写 `metric_policy_trial_receipts`，不参与 policy 锁，故无环。

## 9. 存储方案、迁移、回退与容量失败

- **绑定**：继续存 `metric_policy_bindings.payload`（JSON），新增 envelope/模板快照字段；**不新增** binding 表、不新增第二 revision。
- **新增表**：上面的 operations 与 trial_receipts。均为追加式 DDL，不改既有列；`metric_policy_audit.payload` 仍是 JSON，新增 `action='template_binding.apply'` 只需 TS `Audit` 联合扩一项（共享类型变更，另一包）。
- **迁移**：无数据回填；历史 package 行读取时归一，写回保持原形态；模板行从第一次 enable 才开始出现。
- **回退**：撤 enable 入口与 issuer；新表停写、不读；已写入的 `templates-v1` binding 行保持原样，旧读者因 fence 稳定拒绝（不得改回“按单 package 解释”）；如需恢复旧配置，用保留的上一份 `effective` 计划 + 现有 package 路径写一个新 revision。
- **容量/失败**：新表不可用或写入失败 → host 抛错 → B2D 返回 `commit_unknown`，不降级到审计窗口或内存 map；唯一键冲突 → 稳定 `rejected`；表满/分区耗尽 → 停止 enable，保留上一份有效配置，不产生“半应用”。
- **审计**：`template_binding.apply` 记录 target/revision/actor/idempotency key/三身份/receipt/受信时间；不改既有 `binding.publish`/`group.publish` 语义。

## 10. 部署授权缺口

| 动作 | 现状 |
| --- | --- |
| 创建 `metric_policy_operations`、`metric_policy_trial_receipts` 及索引 | 未授权（本包只提交设计） |
| 写 `metric_policy_bindings` 模板行 / 生产 enable | 未授权 |
| 生产 receipt issuer、trial 真实 IO 映射 | 未授权 |
| 路由/activation 挂载、权限与发布 | 未授权 |
| 旧读者 fence 的共享源码修改（policy/scheduler/config/bulk/consumers/rollout） | 未授权（另有写者） |
| 真实 DB/SSH/SNMP/凭据、负载、CI/部署 | 未授权 |

## 11. 等待项

| wait_kind | next_action | input_owner | minimum_resume_fact |
| --- | --- | --- | --- |
| `production_storage_admission` | Chief 核实现有 DB/DDL/生产写授权，批准两表与索引、部署窗口、备份/回退演练 | Chief + DB/权限 owner | 获批 DDL 清单、执行窗口、回退步骤 |
| `receipt_issuer_admission` | 定义 v2 receipt issuer：真实逐项 read/transform/unit 结果 → receipt 行；确认试采锁外、消费锁内顺序 | Chief + 试采/MAX-239 接口 owner | issuer API、结果来源、过期/撤销规则、存储位置 |
| `reader_fence_admission` | 按第 4 节逐文件放行 fence 与稳定码，确保旧读者不把模板配置当单 package | Chief + 对应模块 owner | 获批文件清单与稳定码、兼容性检查 |
| `enable_entry_admission` | 挂载 B2D adapter 到显式 enable 入口（非 `activate`、非 `trial`），完成锁内接线 | Chief + 路由/权限 owner | 入口契约、权限复验、部署与回滚批准 |

以上只挂起受影响的真实 DB/生产写/权限动作，不等待 MAX-236 整单 done，也不重复请求常规源码修复授权。

## 12. 明确未实现

未新增/执行 DDL；未改任何共享读者；未实现模板 envelope 的运行时读写；未实现 receipt issuer/表、operation 表、审计 action；未挂载 adapter、路由或 ActivationGuard；未运行 trial 或真实采集；未写正式历史、事件、通知；未完成多 release 运行时/scheduler/runner。B2D 的接受不放行 239–245 的真实集成，也不构成生产 compiler、真实 CAS/权限或“已应用/健康/首样本”结论。
