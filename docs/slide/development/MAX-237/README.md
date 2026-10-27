# MAX-237 / T1：Slide 原生监控模板内部领域实现（未接线）

本目录是 Issue #261（Multica MAX-237）**MAX237-T1 内部实现包**的可审阅交付。准入依据是
`56121dc31:docs/slide/development/MAX-235/gate-intervention-20261027.md`（Chief 依据 Max 卡点干预评论作出的“立即批准”条目）：

- 只允许**新建** `apps/db-ops-api/src/metrics/templates/**` 与 `docs/slide/development/MAX-237/**`；其他产品/共享/契约/迁移/前端文件只读。
- 不注册路由或进程、不写 DB、不加迁移、不调用真实采集/通知/模型、不派子代理、不自建 wakeup。
- 这是“P0 未整体接受时的独立内部实现准入”，**不是**生产放行；整单保持 `in_progress`。

**一句话结论**：一个未挂载的 TypeScript 模板领域模块已经实现并通过 **34 项 focused 测试**；它复用了既有
`PackageRegistry`/builtin releases/`canonicalDefinitions`/`stable()`/`hasPermission()`，没有新增第二套
catalog、采集器、速率引擎或权限码。模板触发器执行、持久化、路由/UI、真实三类模板、历史和通知集成仍然全部待办。

## 1. 实际 base / HEAD / 变更面

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-237`（未切换分支、未 rebase/squash） |
| 交付 base | `06cca0ca8d522f433cd035f14b597d983514bde3` |
| 本包代码提交 | `ac9270324`（9 个新增文件，未修改任何既有文件） |
| 输入基线（只读，不合并） | `afa5b3d25d1bf4f72d017a8cf6a952d7591356b0`：`MAX-236/08`、`MAX-236/14`、候选 `apps/db-ops-api/src/contracts/metrics/templates.ts` |
| 未改 | `contracts/metrics/**`、`public-api.ts`、`server.ts`、`routes.ts`、`policy/**`、`packages/**`（只导入）、SQL/迁移、前端、`docs/slide/development/MAX-236/**` |

| 文件 | 行数 | sha256 |
|---|---|---|
| `apps/db-ops-api/src/metrics/templates/errors.ts` | 55 | `2ac869e712f3017cf01187f39a4aced2adeccb94078d223c0b7478a0a152bfb7` |
| `apps/db-ops-api/src/metrics/templates/model.ts` | 404 | `c1222df8eb37a872c1fb804a98bc2f19a3e9aa3c0d3c8b3a537c8f82ff750cf3` |
| `apps/db-ops-api/src/metrics/templates/catalog.ts` | 239 | `371ac1648425eeead47ace8a2f467a388a83a74b7a1b90f829e4a2f74a45174d` |
| `apps/db-ops-api/src/metrics/templates/repository.ts` | 325 | `e9c70b629b6d1549ff0ec055b7d11bbdb625977f8e88c5c52623958b53bcf608` |
| `apps/db-ops-api/src/metrics/templates/service.ts` | 585 | `ddcfdae1a0d3eaa919cf168572bf22119870f40cebe86633d905e5589f2faa5f` |
| `apps/db-ops-api/src/metrics/templates/index.ts` | 14 | `b63c556b9e9e393541cb8c25cccd6aa37f5afd18c2d865c98c454947b2a7097c` |
| `apps/db-ops-api/src/metrics/templates/catalog.test.ts` | 142 | `854c62626334a5c6c8a85428e02cc3d9c99d254694993378fe2aa1630e0b7e05` |
| `apps/db-ops-api/src/metrics/templates/repository.test.ts` | 177 | `87715b2304bbe90cac8fbf358ff12e80200777a8926a613a67e0c8833ec051d9` |
| `apps/db-ops-api/src/metrics/templates/service.test.ts` | 478 | `a62c7fb48e222b83f4d2d42207e60c2d0b58fe9b4e4d6883788a6059cea6ca2c` |

机器可读证据见 [evidence/t1-internal-template-domain.json](evidence/t1-internal-template-domain.json)。

## 2. D1 子集字段对照

D1 整体仍未冻结（`MAX-236/08` §0、`MAX-236/14` §8/§10）。下表只列本包获准实现的模板相关子集，并逐项说明落点。

| 本模块字段 | 来源 | 本包状态 | 说明 |
|---|---|---|---|
| `template_id`、`item_id`、`rule_id`（仅引用） | 08 §0.1、候选 `TemplateIdSchema`/`ItemIdSchema`/`RuleIdSchema` | 实现 | 服务端生成 `template_id`；`item_id` 客户端可给且**改名不变** |
| `(template_id, item_id, version)` 不可变 | 08 §0.1 | 实现 | 仓库 append-only，只增不写 |
| `(template_id, version)` 不可变、`version >= 1` | 08 §0.1/§1.1 | 实现 | 版本号由仓库按 `MAX+1` 分配；同版本不同内容不可能写入 |
| `revision` 从 0 起、CAS | 08 §7.3 | 实现 | 模板 `revision` 与草稿 `revision` 分开 CAS |
| `canonical_metric = {id, semantic_version}` | 08 §0.1、14 §8-4 | 实现 | 显式映射，绝不按显示名/数组顺序匹配 |
| `unit` | 14 §8-4 | 实现 | 必须等于 canonical definition 的 unit，否则 `TEMPLATE_UNIT_MISMATCH` |
| `dimensions`（Record<string,string>） | 14 §8-3 | 实现 | 键集合必须等于 canonical 维度名集合；值取 canonical 维度含义，不参与语义判定 |
| `collector_ref = {package_release, implementation_id}` | 候选 `TemplateItemVersionSchema` | 实现 | `package_release = id@version#digest`；digest 由 `PackageRegistry.get` 校验 |
| `params_default` | 候选 | 实现 | 必须是模板已声明参数；`interval_ms` 逐 item 设置被拒（见 §4） |
| 模板 `parameters {schema, defaults}` | 08 §1.1 | 实现 | 默认采集周期在此声明，边界与 `SettingsSchema.interval_ms` 一致（1000–86 400 000） |
| `capabilities.discovery/graphs` 占位 | 14 §2.7 | 实现（仅占位） | `executable` 恒为 `false`；参与 hash；不声称可用 |
| `source_chain {actor_id, request_id, base, created_at, published_at, retired_at, migration_ref}` | 14 §2.3 | 实现 | item 版本 `base` 用 `{kind:'item', template_id, id, version}`；模板版本用 `{kind:'template', id, version}` |
| `content_hash = sha256(stable(aggregate))` | 08 §1.1 | 实现 | 复用 `packages/model.ts#stable`，不另写规范化 |
| `package_composition` | 08 §1.1、14 §2.2 | 实现 | 发布时按 pinned release 分组派生，item 恰被一个 release 覆盖 |
| `base` 继承展开 | 08 §1.1 | **不实现** | 合并规则（自有 item 与基础 item、参数、触发器的组合）未冻结；发布遇非空 `base` 直接 `TEMPLATE_BASE_INHERITANCE_UNAVAILABLE` |
| 资源绑定 `template_pins`、多 pin 解析 | 08 §1.2 | 未实现 | 属 MAX-238 |
| 触发器规则版本、执行、恢复条件 | 08 §1.3 | 未实现 | 属 MAX-239；模板只保存 `{rule_id, scope, version}` 引用并做结构校验（scope 必须指向本聚合 item） |
| 影响预览、退役版本、公开路由 | 08 §1.1/§6 | 未实现 | 本包无路由；退役版本表结构未落 |

### 2.1 两处需要写清楚的实现决定

1. **item 版本由 `selectMetric` 创建。** 候选的草稿聚合只携带 `{item_id, version}` 引用，没有 item 内容，也没有定义 item 版本写入面。本包把“从注册能力选择指标 → 生成不可变 item 版本”做成独立写操作，草稿聚合再引用它。这是候选形状下唯一自洽的落地方式，没有扩展任何字段。
2. **`raw_field`/转换步骤不复制进 item 快照。** item 只钉住 `package_release`（含 digest）与 `implementation_id`；原始字段、输入单位、转换版本与步骤在发布时从该 release 解析，并以 `publish.mapping_trace` 返回。这样追踪链是
   `raw_field → mapping → canonical metric → item(item_id,version) → 模板版本 → content_hash`，且不会与 release 内容漂移。发布时会重新解析并逐项比对 item 的 unit/dimensions/implementation，任一项不一致即拒绝。

## 3. 模块结构

| 文件 | 职责 |
|---|---|
| `model.ts` | D1 子集 Zod schema 与推导类型、`content_hash` 计算、release 引用编解码、占位能力 |
| `catalog.ts` | 只读视图：从 `PackageRegistry` 列出**真正可采集**的指标（含 release/pin/raw field/转换/默认周期/维度），并解释不可选项的原因 |
| `repository.ts` | 持久化**端口**（每个写方法都是一次条件写）+ 仅测试用的 `InMemoryTemplateRepository` |
| `service.ts` | 草稿创建/编辑/复制、item 版本创建、发布、`current` 指针切换、读取；权限与拒绝判定 |
| `errors.ts` | 稳定错误码与 HTTP 状态映射 |
| `index.ts` | 模块导出；显式声明未挂载 |

`grep -rn "metrics/templates" apps/db-ops-api` 除本目录外无命中：没有路由、进程注册、迁移加载器或运行时消费者引用它。

## 4. 发布拒绝与错误码

| 码 | 触发条件 |
|---|---|
| `TEMPLATE_NAME_EMPTY` | 创建/改名/选指标后名称为空或全空白 |
| `TEMPLATE_EMPTY` | 草稿既无 item 也无 trigger（不产出空壳模板） |
| `TEMPLATE_BASE_INHERITANCE_UNAVAILABLE` | 草稿声明了非空 `base` |
| `TEMPLATE_INVALID_PERIOD` | `interval_ms` 非 integer 类型、声明边界越出平台区间、默认值越界或非整数 |
| `TEMPLATE_ITEM_CADENCE` | item 自己设置 `interval_ms`（既有 `compilePlan` 一个资源只有一个节奏） |
| `TEMPLATE_PARAMETER_UNDECLARED` / `TEMPLATE_PARAMETER_INVALID` | item 默认值未在模板声明 / 类型或边界不符 |
| `TEMPLATE_ITEM_NOT_FOUND` | 草稿引用了不存在的 `(item_id, version)` |
| `TEMPLATE_METRIC_DUPLICATE` | 同一 canonical 指标被两个 item 选择 |
| `TEMPLATE_PIN_NOT_FOUND` | release pin 未安装或 digest 不匹配 |
| `TEMPLATE_MAPPING_MISSING` | 该 release 没有这个实现/指标映射，或 item 钉的实现与 release 不符 |
| `TEMPLATE_MAPPING_AMBIGUOUS` | 同一指标在同一 release 被多个 collector/raw field 映射 |
| `TEMPLATE_UNIT_MISMATCH` / `TEMPLATE_DIMENSIONS_MISMATCH` | item 单位/维度与 canonical 定义不符 |
| `TEMPLATE_METRIC_UNKNOWN` / `TEMPLATE_METRIC_DEPRECATED` / `TEMPLATE_METRIC_NOT_COLLECTABLE` | 指标未注册 / 已退役 / 无可采集映射（例如 derived 指标） |
| `TEMPLATE_RESOURCE_TYPE_MISMATCH` | 指标资源类型与 release 采集的资源类型不一致 |
| `TEMPLATE_DRAFT_CONFLICT` / `TEMPLATE_REVISION_CONFLICT` | 草稿/模板 revision CAS 失败 |
| `TEMPLATE_DRAFT_IDENTITY` | 草稿聚合的 `template_id` 与路径不一致 |
| `TEMPLATE_EXISTS` / `TEMPLATE_NOT_FOUND` / `TEMPLATE_VERSION_IMMUTABLE` | 身份冲突 / 不存在 / 已退役版本不能再成为 current |
| `TEMPLATE_FORBIDDEN` | 缺少 `metric:view`（读）或 `metric:manage`（写） |
| `TEMPLATE_INVALID_INPUT` | 请求形状不合法（Zod 失败转成同一错误面） |

**未实现项的解释**：`catalog.unavailable()` 为每个不可选指标给出精确原因——derived 指标（`mysql.queries.per_second`、`linux.filesystem.used_ratio`）当前不能直接选择，因为 D1 没有冻结 derived 引用类型；这是本包的明确缺口，不是“已支持”。

## 5. 持久化与并发：端口表达的必要条件

`TemplateRepository` 的每个写方法都是一次**条件写**，注释中给出生产 SQL 条件；内存实现只是测试替身：

| 方法 | 生产条件 |
|---|---|
| `create` | 一个事务插入模板、草稿、（复制时）全部 item 版本；`template_id` 主键拒绝复用 |
| `updateDraft` / `updateTemplate` | `WHERE template_id=? AND revision=?`；0 行受影响即冲突 |
| `putItemVersion` | `SELECT … FOR UPDATE` 后 `MAX(version)+1` 追加；`UNIQUE(template_id,item_id,version)`；最近版本内容相同则复用不追加 |
| `publish` | 单事务：锁模板行 → 校验模板/草稿 revision → 按 `content_hash` 判幂等 → 插入版本（`UNIQUE(template_id,version)`、`UNIQUE(template_id,content_hash)`）→ 模板 `revision+1` + 指针 → 草稿 `revision+1` + `published_version` |

内存实现的方法体全同步执行，所以读-判-写在单事件循环内原子；**这不是多进程安全**，也没有任何进程锁。模块里不存在锁、单例或全局状态。

## 6. 验证（绑定 `ac9270324`）

| 命令（cwd `apps/db-ops-api`） | 结果 |
|---|---|
| `npx vitest run src/metrics/templates` | **34 passed / 34**（catalog 6、repository 8、service 20） |
| `npx vitest run src/metrics` | **47 文件通过 / 24 跳过；476 passed / 121 skipped**（跳过的都是需要 `METRICS_TEST_MYSQL_PORT` 等真实后端的用例，本包未触碰这些模块） |
| `npx tsc --noEmit` | 退出码 0 |
| `npx oxlint apps/db-ops-api/src/metrics/templates` | 0 warning / 0 error |
| `grep -rn "metrics/templates" apps/db-ops-api` | 除本目录外无命中（未挂载） |
| `pnpm contracts:check` | **未运行**：未改任何公共契约文件，注册图不变，该检查看不到本目录 |

focused 覆盖：注册能力选择与自动带入、derived/退役/未注册/未安装 pin 的拒绝、item 改名保持身份、发布后的 raw field 追踪、
跨 release 组合、空模板/空名/非法周期/item 级节奏、单位与维度错配、缺实现、缺映射、重复指标、草稿与模板 CAS、
并发发布只有一个赢家、幂等重发 noop、复制生成新身份且不续历史、current 只动指针、返回值为深拷贝、越权写入被拒。

## 7. 代码已实现 / 未接线 / 仍然缺的

**已实现（有测试）**：§2 表中标记“实现”的全部字段与行为；`metric:view`/`metric:manage` 判定；稳定身份与不可变版本；发布拒绝面。

**已实现但未接线**：整个模块——不挂路由、不注册进程、不接真实 MySQL、不接 scheduler/evaluator/通知/AI。

**未实现 / 缺口（不得当成完成）**：

1. 持久化 adapter、迁移（140/141 未批准）与真实事务；当前只有内存仓库。
2. 模板继承 `base` 的合并语义（D1 未冻结）→ 明确拒绝而非猜测。
3. derived 指标的 item 选择（需要 D1 之外的引用类型决定）。
4. 触发器规则版本与执行、恢复条件（MAX-239）；本包只保存引用。
5. 资源绑定/多 pin 解析、测试→应用→首样本（MAX-238）。
6. 最新/历史查询与图表数据（MAX-240）。
7. 公开 API/路由/UI、影响预览、版本退役、真实 ACL 对象与审计接线。
8. 真实三类模板、速率边界（MySQL 使用率、计数速率、Linux MemAvailable、SNMP 接口速率）、名称修改历史链路、共享读取与凭据隔离：全部保持待办。

## 8. 原 Issue 六项验收的当前状态

| 验收项 | 状态 |
|---|---|
| 名称修改不丢历史，单位/口径不兼容阻止误续接 | **局部已证明**：改名保持 `template_id`/`item_id` 且旧版本快照不变；单位不兼容在 item 选择与发布两处拒绝。模板级“口径不兼容阻止误续接”需要版本退役与绑定解析（MAX-238），未完成 |
| 从原始输出到指标、项、序列和规则引用可逐项追踪 | **局部已证明**：raw field → canonical → item → 模板版本的 trace 有测试；“序列”和“规则引用”依赖 MAX-239/240 |
| 注册能力选择自动填充；空名、非法周期、重复与缺实现均有阻断和明确反馈 | **本包已实现**（针对模板域）：见 §4 |
| MySQL 使用率、计数速率、Linux MemAvailable、SNMP 接口速率的正常与未知边界有真实证据 | **未做**：需要真实采集与历史，属后续实现/验收 |
| 三类真实模板各贯通采集→最新/历史→触发/保持/恢复 | **未做** |
| 共享读取、不同凭据隔离、只读权限/超时/输出限制及脱敏验证 | **未做**（本包不采集资源） |

因此整单保持 `in_progress`；本文件不代表原 Issue 完成，也不构成生产放行。
