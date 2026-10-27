# MAX-237 / T1：Slide 原生监控模板内部领域实现（未接线）

本目录是 Issue #261（Multica MAX-237）**MAX237-T1 内部实现包**的可审阅交付。准入依据是
`56121dc31:docs/slide/development/MAX-235/gate-intervention-20261027.md`（Chief 依据 Max 卡点干预评论作出的“立即批准”条目）：

- 只允许**新建** `apps/db-ops-api/src/metrics/templates/**` 与 `docs/slide/development/MAX-237/**`；其他产品/共享/契约/迁移/前端文件只读。
- 不注册路由或进程、不写 DB、不加迁移、不调用真实采集/通知/模型、不派子代理、不自建 wakeup。
- 这是“P0 未整体接受时的独立内部实现准入”，**不是**生产放行；整单保持 `in_progress`。

**一句话结论**：一个未挂载的 TypeScript 模板领域模块已经实现并通过 **41 项 focused 测试**；它复用了既有
`PackageRegistry`/builtin releases/`canonicalDefinitions`/`stable()`/`hasPermission()`，也直接复用已接受的
`contracts/metrics/templates.ts` 模板 schema（不再自定义同义 schema），没有新增第二套 catalog、采集器、速率引擎或权限码。
模板触发器执行、持久化、路由/UI、真实三类模板、历史和通知集成仍然全部待办。

> 2026-10-27 补修：Chief 终态复审（`e91b79c84:docs/slide/development/MAX-237/reviews/chief-t1-review-20261027.md`）
> 要求的有界补修 R1–R3 已完成，见 §9。整单仍 `in_progress`。
>
> 2026-10-27 R2-DIM：Chief 复审 `ce8880552` 指出的维度键集合字符串碰撞已按新接续决定补修，见 §10。整单仍 `in_progress`。

## 1. 实际 base / HEAD / 变更面

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-237`（未切换分支、未 rebase/squash） |
| 交付 base | `06cca0ca8d522f433cd035f14b597d983514bde3` |
| 本包代码提交 | `ac9270324`（9 个新增文件，未修改任何既有文件） |
| R1–R3 补修提交 | `ed501a077`（新增 1 个逐字节提取文件 + 修改本包 6 个文件，仍不触碰任何其他产品文件），见 §9 |
| R2-DIM 补修提交 | `98c6be04b`（仅 2 个实现 + 2 个现有测试），见 §10 |
| 输入基线（只读，不合并） | `afa5b3d25d1bf4f72d017a8cf6a952d7591356b0`：`MAX-236/08`、`MAX-236/14`、候选 `apps/db-ops-api/src/contracts/metrics/templates.ts` |
| 未改 | `contracts/metrics/{definitions,index,observations,configuration,validation,schema,public-api,fixtures,export,bulk,configuration-status}.ts`、`public-api.ts`、`server.ts`、`routes.ts`、`policy/**`、`packages/**`（只导入）、SQL/迁移、前端、`docs/slide/development/MAX-236/**` |

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

机器可读证据见 [evidence/t1-internal-template-domain.json](evidence/t1-internal-template-domain.json)（原始交付）、
[evidence/t1-r1-r3-correction.json](evidence/t1-r1-r3-correction.json)（R1–R3 补修）与
[evidence/t1-r2-dim-correction.json](evidence/t1-r2-dim-correction.json)（R2-DIM 补修）。

## 2. D1 子集字段对照

D1 整体仍未冻结（`MAX-236/08` §0、`MAX-236/14` §8/§10）。下表只列本包获准实现的模板相关子集，并逐项说明落点。
这些字段的 Zod 定义**不在本包内**：`model.ts` 从逐字节提取的 `apps/db-ops-api/src/contracts/metrics/templates.ts`
（见 §9.1）导入并 re-export，本身只保留派生类型别名与领域 helper，不存在第二份模板协议。

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
| `model.ts` | 从 `contracts/metrics/templates.ts` 导入并 re-export 模板 schema/type；只额外提供派生类型别名、`content_hash` 计算、release 引用编解码、占位能力与空草稿 |
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
| `TEMPLATE_PARAMETER_UNDECLARED` / `TEMPLATE_PARAMETER_INVALID` | item 默认值未在模板声明 / 类型或边界不符（按声明类型分支：`boolean`、`string` 参数只接受同类型值，数字不能冒充；`number`、`integer` 参数只接受有限数） |
| `TEMPLATE_ITEM_NOT_FOUND` | 草稿引用了不存在的 `(item_id, version)` |
| `TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE` | 同一 `template_id` + `item_id` 试图改用不兼容的 canonical 指标（`id@semantic_version`）、单位或维度键集合；稳定 item 身份不能换口径，必须新建 `item_id` |
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
| `putItemVersion` | `SELECT … FOR UPDATE` 后校验锁住的最近版本与稳定 item 身份兼容（canonical 指标、单位、维度键集合），不兼容即 `TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE`；随后 `MAX(version)+1` 追加；`UNIQUE(template_id,item_id,version)`；最近版本内容相同则复用不追加 |
| `publish` | 单事务：锁模板行 → 校验模板/草稿 revision → 按 `content_hash` 判幂等 → 插入版本（`UNIQUE(template_id,version)`、`UNIQUE(template_id,content_hash)`）→ 模板 `revision+1` + 指针 → 草稿 `revision+1` + `published_version` |

内存实现的方法体全同步执行，所以读-判-写在单事件循环内原子；**这不是多进程安全**，也没有任何进程锁。模块里不存在锁、单例或全局状态。

## 6. 验证（绑定 R1–R3 补修提交 `ed501a077`）

| 命令（cwd `apps/db-ops-api`，除注明外） | 结果 |
|---|---|
| `npx vitest run src/metrics/templates` | **41 passed / 41**（catalog 6、repository 10、service 25；补修前为 34） |
| `npx vitest run src/metrics` | **47 文件通过 / 24 跳过；483 passed / 121 skipped**（补修前 476/121；跳过的都是需要 `METRICS_TEST_MYSQL_PORT` 等真实后端的用例） |
| `npx tsc --noEmit` | 退出码 0（含逐字节提取的 `src/contracts/metrics/templates.ts`） |
| `npx oxlint apps/db-ops-api/src/metrics/templates`（cwd 仓库根） | 0 warning / 0 error |
| `pnpm contracts:check`（cwd 仓库根） | 退出码 0，生成物无差异：`contracts/metrics/index.ts`、`public-api.ts` 未改，注册图不含本目录 |
| `git hash-object` / `shasum -a 256` 比对提取文件 | blob `bdd455ccc218c9e8543eaee6ad5bc5686f414170`、sha256 `76bcdfeb…79a45`，与 `afa5b3d25d…` 一致 |
| Chief 复审 probe `reviews/chief-t1-probes-20261027.ts`（`e91b79c84`）对本 HEAD 重跑 | **3/3 pass，exit 0**：R2 → `TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE`、R3 → `TEMPLATE_PARAMETER_INVALID`、权限控制 → `TEMPLATE_FORBIDDEN`；补修前为 1 通过 / 2 反例失败 |
| `grep -rn "metrics/templates" apps/db-ops-api/src` | 除本目录外无命中（未挂载） |

focused 覆盖：注册能力选择与自动带入、derived/退役/未注册/未安装 pin 的拒绝、item 改名保持身份、稳定身份拒绝不兼容口径
（顺序、竞态、旧快照不变）、发布后的 raw field 追踪、跨 release 组合、空模板/空名/非法周期/item 级节奏、
四种参数类型正例与“数字冒充 boolean/string”反例（草稿、发布重校验、item 默认值）、单位与维度错配、缺实现、缺映射、
重复指标、草稿与模板 CAS、并发发布只有一个赢家、幂等重发 noop、复制生成新身份且不续历史、current 只动指针、返回值为深拷贝、越权写入被拒。

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
| 名称修改不丢历史，单位/口径不兼容阻止误续接 | **局部已证明**：改名保持 `template_id`/`item_id` 且旧版本快照不变；稳定 item 身份不能换 canonical 指标/单位/维度口径（`TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE`），item 选择与发布两处另有 unit/dimension 校验。模板级“绑定续接”仍需要版本退役与绑定解析（MAX-238），未完成 |
| 从原始输出到指标、项、序列和规则引用可逐项追踪 | **局部已证明**：raw field → canonical → item → 模板版本的 trace 有测试；“序列”和“规则引用”依赖 MAX-239/240 |
| 注册能力选择自动填充；空名、非法周期、重复与缺实现均有阻断和明确反馈 | **本包已实现**（针对模板域）：见 §4 |
| MySQL 使用率、计数速率、Linux MemAvailable、SNMP 接口速率的正常与未知边界有真实证据 | **未做**：需要真实采集与历史，属后续实现/验收 |
| 三类真实模板各贯通采集→最新/历史→触发/保持/恢复 | **未做** |
| 共享读取、不同凭据隔离、只读权限/超时/输出限制及脱敏验证 | **未做**（本包不采集资源） |

因此整单保持 `in_progress`；本文件不代表原 Issue 完成，也不构成生产放行。

## 9. R1–R3 有界补修（提交 `ed501a077`）

依据：Chief 终态复审 `e91b79c84:docs/slide/development/MAX-237/reviews/chief-t1-review-20261027.md` 与
`t1-correction-instruction-20261027.md`。只修 R1–R3，不重做设计、不接持久化、不新增路由/DDL/真实资源，沿用 PR #390。
准确补修基点：`919bc0d29b919e850e2b8b706bdcfe26ddf8dea4`（分支上另有运行时生成的 `42d200204 docs/CLAUDE.md` chore，不在本项交付面内）。

### 9.1 R1 — 复用已接受 schema，删除同义定义

- 目标路径 `apps/db-ops-api/src/contracts/metrics/templates.ts` 补修前不存在，因此按授权**逐字节提取**
  `afa5b3d25d1bf4f72d017a8cf6a952d7591356b0` 的同名文件：

  | 证据 | 值 |
  |---|---|
  | git blob（源与目标） | `bdd455ccc218c9e8543eaee6ad5bc5686f414170`（两侧相同） |
  | sha256（源与目标） | `76bcdfebd5af681e84453fc59e2da05b50f36ca2c8aeadecef8844e80c579a45`（两侧相同） |
  | 行数 | 556 |

  提取文件与源对象逐字节一致；依赖的 `contracts/metrics/definitions.ts`、`index.ts`、`public-api.ts`、
  `metrics/packages/{model,builtins}.ts` 与 `afa5b3d25d` 无差异（`git diff --stat afa5b3d25 HEAD -- <这些路径>` 为空）。
- `metrics/templates/model.ts`（404 → 91 行）删除了与提取文件同义的 schema/type/函数定义
  （`TemplateIdSchema`、`ItemIdSchema`、`HashIdSchema`、`VersionNumberSchema`、`RevisionSchema`、`sortedUnique`、
  `TemplateCapabilitiesSchema`、`Parameter*Schema`、`PackageReleaseRefSchema`、`PackageCompositionEntrySchema`、
  `TemplateItemRefSchema`、`TemplateBaseRefSchema`、`TemplateTrigger*Schema`、`Template{Draft,Published}AggregateSchema`、
  `SourceBaseRefSchema`、`SourceChainSchema`、`TemplateItemVersionSchema`、`TemplateVersion*Schema`、
  `Template{Status,Record,Draft,Pin}Schema`），改为从提取文件 `import` 并 `export`；本文件只保留
  派生类型别名（`MetricRef`/`ParameterValue`/`TemplateStatus`/`TemplateVersionSummary`）与领域 helper
  （`canonicalKey`、`packageReleaseRef`/`parsePackageReleaseRef`、`placeholderCapabilities`、`emptyDraftAggregate`、
  `templateContentHash`）。
- 不复用、也不 re-export 提取文件里的 HTTP 请求/响应与资源绑定 schema（`Create/Update/Preview/Publish/Switch/Retire/List/Detail`、
  `TemplatePin(s)`、`ResourceBinding*`）：它们不属于 T1 模板域；服务仍使用自己的私有请求形状。
- 不新增第二份协议；`contracts/metrics/index.ts` 与 `public-api.ts` 未改，`pnpm contracts:check` 退出码 0。
- 局部语义差异随之消除：`display_name`/`name` 上的 `.trim()` 只保留在服务层 `requireName`（改名/建模板时仍然去空白并拒绝空名）。

### 9.2 R2 — 稳定 item 身份不能再换不兼容口径

- 边界（复用既有语义定义，不造新兼容协议）：`(template_id, item_id)` 的语义 = `canonical_metric` 的
  `id@semantic_version` + `unit` + 维度**键集合**，与发布时对 canonical 定义的三项校验同源。
  改名、改默认参数、兼容的 implementation pin 更新仍在同一身份下追加版本。
- 拒绝码：`TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE`（422），消息明确“须使用新 `item_id`”。
- 位置：`InMemoryTemplateRepository.putItemVersion` 的条件追加内（端口注释同步为生产 `SELECT … FOR UPDATE` 后必须同一条件），
  因此服务读取与仓库写入之间不存在可绕过的窗口；并未把该缺陷推给 MAX-238。
- 反例与证据（`service.test.ts` / `repository.test.ts`）：
  - 顺序：`stable-item` v1 = `db.uptime_seconds@1.0.0 / s` 发布后，同一 `item_id` 选 `mysql.queries.total@1.0.0 / count` → 拒绝；
    `getVersion` 旧快照逐字段不变、`listVersions` 仍 1 条、`latestItemVersions` 仍是 v1。
  - 单位/维度：改 `unit`、改维度键集合同样被拒。
  - 竞态：同一 `item_id` 并发两次选择（不同指标）→ 恰好 1 成功 1 拒绝；仓库层直接并发 `putItemVersion` 也只留 v1。
  - 兼容：改名与换 pin 追加 v2，身份与 canonical 指标不变。
- 生产事务仍只是端口要求；内存实现为同步测试替身，**不冒充**持久化或多进程安全（未新增 DB adapter/DDL）。

### 9.3 R3 — 声明类型决定参数校验分支

- `checkParameterValue` 改为按 `spec.type` 分支：`boolean`/`string` 参数只接受同类型值，`number`/`integer` 参数只接受有限数
  （`integer` 另要求整数）；数字不再能冒充 `boolean`/`string`。
- 反例与证据（`service.test.ts`）：四种类型各一条合法默认值；`{type:'boolean'} + 1`、`{type:'string'} + 0` 在 `updateDraft` 被拒；
  反向（`number` 参数给 boolean）仍被拒；绕过服务直接 `repository.updateDraft` 存入的坏草稿在 `publish` 重校验被拒且不产生版本；
  item 的 `params_default` 数值冒充模板 `boolean` 参数在发布时被拒。
- 非法周期（`TEMPLATE_INVALID_PERIOD`）、item 级 `interval_ms`、未声明参数等既有行为保持不变。

### 9.4 允许清单与文件 hash（`ed501a077`）

允许清单 patch：`evidence/t1-r1-r3-allowlist.patch`（69 424 bytes，sha256 `685d0cd86a80ec7050f230b51b4da1df10bdc9c6b43eae407bbe7247b5bf49b8`）。

| 文件 | 行数 | sha256 |
|---|---|---|
| `apps/db-ops-api/src/contracts/metrics/templates.ts`（新增，逐字节提取） | 556 | `76bcdfebd5af681e84453fc59e2da05b50f36ca2c8aeadecef8844e80c579a45` |
| `apps/db-ops-api/src/metrics/templates/model.ts` | 91 | `d3207eb11ddb727399328690b545128c9f8acadc61de1c2f77563bcb8c85d7d1` |
| `apps/db-ops-api/src/metrics/templates/errors.ts` | 56 | `4f047fc3d92bb079c5bf4fcb952803f033c42adcfb7d5a800b2b9c162321570c` |
| `apps/db-ops-api/src/metrics/templates/repository.ts` | 352 | `05c33d5abe987b4eee27a48a09c6b2e0342ef68829ba83c57b4b9eb3dc806829` |
| `apps/db-ops-api/src/metrics/templates/service.ts` | 591 | `b2190c1c169f40120c0cffdc07efc0a5838c4b330114161585a1ff5d781cf254` |
| `apps/db-ops-api/src/metrics/templates/repository.test.ts` | 229 | `52cb28cce7894b8f6c474f94311d9f8a82acec97eee9b13b0c7818c7204c0071` |
| `apps/db-ops-api/src/metrics/templates/service.test.ts` | 611 | `b97c9f28299cff4545866bb82680314bf559969867a1a2e77b33b9adb96d4ce9` |

未改动、hash 与 §1 一致：`catalog.ts`（`371ac164…`）、`index.ts`（`b63c556b…`）、`catalog.test.ts`（`854c6262…`）。
允许清单之外没有任何修改：路由、进程注册、DB/DDL/迁移、真实资源/通知/模型调用、前端、其他共享 schema 均未触碰。

### 9.5 补修后仍然缺的（不得当成完成）

R1–R3 只闭合复审提出的三项缺陷。§7 的缺口清单（持久化 adapter/迁移/真实事务、base 继承、derived 选择、触发器执行、
绑定/多 pin、历史查询、路由/UI、真实三类模板与速率/未知边界、共享读取与凭据隔离）全部不变，整单保持 `in_progress`。

## 10. R2-DIM 有界补修（提交 `98c6be04b`）

依据：接续决定 `87e70ae3c:docs/slide/development/MAX-235/continuation-v4-20261027.md`（成员评论 `01a17b67-…`）与
Chief 复审 `ce8880552:docs/slide/development/MAX-237/reviews/chief-t1-correction-review-20261027.md` 的 R2-DIM 残留。
只改维度**键集合**比较，不重做已接受的 R1/R3，不改 schema、错误码、canonical/unit 守卫、DB/DDL、公共导出、路由/运行时/前端，沿用 PR #390 不合并。

- 准确基点：`662714321d0b39e303131de9d2eee155dc7150ec`。
- 产品补修提交：`98c6be04b`（4 个文件：2 个实现 + 2 个现有测试；允许清单外零修改）。
- 根因：两处都把排序后的键 `join(',')` 再比较字符串，导致 `{}` 与 `{'': …}` 都序列化为 `''`、
  `{'db,host'}` 与 `{db, host}` 都序列化为 `db,host`。

### 10.1 改动

| 位置 | 改动 |
|---|---|
| `repository.ts` | 新增 `sameDimensionKeys`：两侧 `Object.keys(...).sort()` 后逐项比较长度与每个键；`identityConflict` 改用它（仍挂在条件追加内） |
| `service.ts` | `resolveItems` 把声明的维度键与 canonical 维度名各自排序后逐项比较，不再拼接字符串 |

保留：`TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE` / `TEMPLATE_DIMENSIONS_MISMATCH` 及 422 语义、`DimensionsSchema`
（仍允许空键/逗号键，不靠禁 schema 规避）、canonical 指标与 unit 守卫、键顺序无关。

### 10.2 反例与证据

| 输入/路径 | 结果 |
|---|---|
| 已发布 item v1 `{}`，同 item 追加 `{'': 'unexpected dimension'}` | 仓库条件追加拒绝 `TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE`；直接存入空键 item 时发布重校验拒绝 `TEMPLATE_DIMENSIONS_MISMATCH`；v1 快照不变 |
| 同 item 先 `{'db,host': …}`，后 `{db, host}` | 拒绝（不再是同一键集合） |
| 同一键集合、不同插入顺序 | 兼容（内容相同则复用 v1，不追加） |
| 同一新 item 并发写 `{}` 与 `{'': …}` | 恰好一胜一拒，仅存 v1 |

Chief 三条失败探针（`reviews/chief-correction-boundary-probes-20261027.ts`，`ce8880552`）对本 HEAD 重跑：
**9/9 pass，exit 0**，输出见 `evidence/t1-r2-dim-boundary-probes.json`。

### 10.3 验证（绑定 `98c6be04b`）

| 命令（cwd `apps/db-ops-api`，除注明外） | 结果 |
|---|---|
| `npx vitest run src/metrics/templates` | **46 passed / 46**（catalog 6、repository 13、service 27；补修前 41） |
| `npx vitest run src/metrics` | **47 文件通过 / 24 跳过；488 passed / 121 skipped**（补修前 483/121） |
| `npx tsc --noEmit` | 退出码 0，无诊断 |
| `npx oxlint apps/db-ops-api/src/metrics/templates`（cwd 仓库根） | 0 warning / 0 error |

`contracts:check` 未重跑：本包未触碰任何 contract/public-export 文件，R1 的逐字节复用证据不变。
跳过的套件是需要真实后端的用例，不当作通过；内存仓库仍只是测试替身，不冒充持久化/多进程安全。

### 10.4 文件与允许清单

允许清单 patch：`evidence/t1-r2-dim-allowlist.patch`（10 214 bytes，sha256 `43a0282859680528b0ba87c1e91cb098b383773fcda8e985a86074db666f3855`）。

| 文件 | 行数 | sha256 |
|---|---|---|
| `apps/db-ops-api/src/metrics/templates/repository.ts` | 359 | `8399f2222973b7c91d76bd232d3c24ee8e49a59844820671b67d5a249d864bdb` |
| `apps/db-ops-api/src/metrics/templates/service.ts` | 591 | `d7060b6ca4dc7c436fb4e120eb3c2baed687bae2f2186e7771af65445e77809d` |
| `apps/db-ops-api/src/metrics/templates/repository.test.ts` | 286 | `a303d1a7e331839baccf7f6a3cf712f53553fc364c1917f55c6a7c9684ac2d57` |
| `apps/db-ops-api/src/metrics/templates/service.test.ts` | 649 | `fc3d89daf4854f8a3ad96d303f0d4af467827555bbb9995719ab34a2f644984d` |

`model.ts`、`errors.ts`、`catalog.ts`、`index.ts`、`catalog.test.ts` 与提取的 `contracts/metrics/templates.ts` 均未改（hash 与 §9.4 一致）。

### 10.5 仍然缺的（不得当成完成）

R2-DIM 只闭合维度键集合比较缺陷。§7 的缺口与 §8 的六项验收状态全部不变：持久化 adapter/迁移/真实事务、base 继承、
derived 选择、触发器执行、绑定/多 pin、历史查询、路由/UI、真实三类模板与速率/未知边界、共享读取与凭据隔离仍待后续包。
整单保持 `in_progress`，本文件不构成 T1 或原 Issue 的最终接受。

## 11. 现行入口：T2A 未挂载 MySQL 适配器（2026-10-27）

T1 接受后，`max237-t2a-admission-20261027.md` 准入的 **T2A internal MySQL adapter + 真实独占 MySQL 事务验证**
已交付到 PR #390（base `1d7f9e1f9`，产品提交 `0b60d1f42`，未合并）。详见
[t2a/README.md](t2a/README.md)、[t2a/evidence/t2a-fixture.json](t2a/evidence/t2a-fixture.json)、
[t2a/evidence/t2a-verification.json](t2a/evidence/t2a-verification.json)、
[t2a/evidence/t2a-cleanup.json](t2a/evidence/t2a-cleanup.json)。

- 新增 `apps/db-ops-api/src/metrics/templates/mysql-repository.ts`（未挂载、显式注入 pool、五张既有表、
  父行优先锁序、CAS、回滚与未知提交结果）；`repository.ts` 仅导出既有 `itemContent`/`identityConflict`。
- 真实一次性 MySQL 8.4 容器（`max237_t2a`，utf8mb4_bin）上以两个独立连接验证并发/回滚/commit 丢失；
  focused 73/73、`tsc` 0、`oxlint` 0/0。
- 明确未做：路由/进程接线、共享连接池、应用 migration、真实采集闭环、T2B 存储兼容决定；
  140 候选 DDL 的 INT/VARCHAR/DATETIME 宽度差已记录为 T2A 已知限制，整单仍 `in_progress`。
