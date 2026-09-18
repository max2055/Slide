# Metric Architecture V2 契约 1.0.0（MAX-64）

本目录冻结语义与数据交换协议；实现入口为 `apps/db-ops-api/src/contracts/metrics-v2/index.ts`。`schemas.json` 为 JSON Schema 2020-12；TypeScript 类型由相同 Zod schema 推导。**结构校验不能替代 `validation.ts` 的跨记录校验**。本项没有注册路由或接入运行时，旧 API 保持不变；以下是下游实现契约，不是已上线功能说明。

前置依据：MAX-63 PR #74，main `2995227f4416460612e3434cfdee1d93dd24b2a4`，盘点在 `docs/slide/metrics-v2/v1/`。`plan.md` 记录执行边界、预算和验收。`fixtures.json` 是合成样例，非生产抓取；`fixtures.ts` 是其可执行源。版本 `1.0.0-candidate.1` 的盘点保留原样，不倒填正式版本。

## 对象职责与关系

|对象|负责|不负责|
|---|---|---|
|CanonicalMetricDefinition|产品稳定语义：ID、含义、单位、资源范围、维度身份、kind、temporality、monotonic、值类型、聚合|SQL/OID、周期、阈值|
|ExtensionMetricDefinition|厂商/自定义命名空间内同等级语义约束|第二套查询接口、绕过质量或精度规则|
|MetricRole|core/diagnostic/capacity/slo 产品用途，可多选|值来源、准确性、kind|
|Resource.attributes|带时间和来源的版本、型号、引擎、OS、接口速率等 inventory|数值指标伪装、版本维度|
|CollectorDefinition|执行器引用、方法、成本级别、timeout、原始字段到指标的版本化转换|动态修改 canonical 定义|
|CollectorPackage|不可变 Monitoring Template 包，包含 collector、映射、适用条件、版本和内容摘要|独立 Template 实体、CoreProfile 列定义|
|CollectionPolicy|启停、周期、超时、并发、新鲜度、counter gap、基数预算|能力、采集结果|
|CollectionBinding|资源绑定一个精确包版本/摘要和策略 revision|直接决定每项来源|
|MetricBinding|资源/维度/指标版本 → 单一 collector 字段或 DerivedMetric，归属 CollectionBinding|隐式 fallback、同项多源同时产值|
|Capability|资源、版本、权限、方法的适用性，带依据、判定时间及有效期|最近一次采集成败|
|CollectionAttempt|一次执行的状态、错误、观测引用|失败生成 0 值|
|DerivedMetric|类型化运算、依赖 DAG、join、时间对齐、质量传播|执行任意用户表达式或额外采集|
|AggregationPolicy|每种指标允许的时空操作、覆盖度、缺失处理|替缺失造值|
|AlertPolicy|指标、阈值单位、持续时间、质量/估算准入、覆盖度|修改指标含义|
|CoreProfile|产品定义的不可变版本化核心列集合|由用户模板添加、替换或删除列|

配置解析顺序：检查包摘要/契约版本 → 匹配资源属性适用条件 → 钉住策略与配置 revision → 验证 MetricBinding 唯一来源 → 检查 Capability 有效期 → 应用启停和策略 → 生成 CollectionPlan。资源可绑定多个包，但有效来源集合内同序列只能一个来源；包括跨包冲突。禁用来源可保留。切源必须新 revision、明确生效边界和 counter 基线重置，不允许静默 fallback。

`validateBindings` 验证绑定、版本、来源和派生 DAG；`resolveDecision` 返回 collect/derive/disabled/unsupported/capability_unknown。执行器还须复核资源真实属性、权限、有效期和预算。成本 low/medium/high 是包声明估计，不代表实测耗时。

## 稳定语义、扩展和版本

- canonical 根命名空间为 db/host/network；Extension 采用可登记且不可冒名的命名空间（mysql/linux/组织名等）。资源版本、型号不成为指标 ID/维度。
- 相同 ID 不得变更含义、unit、scope、resource_type、kind、temporality、monotonic、value_type、维度或聚合规则，即使提升 major 也不能复用旧 ID。`validateCatalog` 拒绝冲突；不兼容含义分配新 ID。描述中的 `meaning` 为规范性定义，不随意润色。
- 注册版本采用稳定 SemVer，拒绝 candidate/legacy-unversioned 冒充正式版本。语义元数据演进（role、废弃状态）产生新版本；包、Profile 同 ID/同 version 不可改写；策略与绑定采用单调 revision + 乐观并发。
- `acceptsVersion(reader, writer)`：相同 major 且 writer 的 minor/patch 不超过 reader 才接受。Major 不兼容，未知更高版本 fail closed；具体指标引用始终精确匹配 semantic_version，不能以可读代替身份相同。
- alias 必须唯一、无现存定义冲突、直接指向一个已登记的精确版本；不允许链和环。只有语义等价才登记 alias。旧单位换算、不同作用域、Queries 与 xact_commit 的差异是迁移转换或拆分，不能 alias。
- 生命周期 active → deprecated；禁止恢复或原地改义。deprecated 仍可读历史，可指定 replacement；不能删除尚被历史引用的定义。replacement 不是自动等价承诺。
- Extension 晋升：产品审核后登记新的 Canonical ID；`validatePromotion` 比较规范性语义；新配置切到 canonical，旧 Extension 标记 deprecated 并保留查询。不能重命名历史或同一采样同时复制两份计入聚合。不同语义拒绝晋升，先拆分。
- 不启用笼统 db.qps/db.size_bytes；连接/会话/进程、逻辑大小/分配空间沿用 MAX-63 的拆分决定。样例 `mysql.cpu.heuristic_percent` 冻结为 Extension 估算，绝不映射 host CPU。

## 观测、精度与身份

序列身份是 `(resource_type, resource_id, metric.id, semantic_version, canonicalized dimensions)`；dimensions 按键的 UTF-16 字典序排序（不依赖 locale），值不大小写折叠、不去掉方向。接口须带稳定世代信息（fixture 使用 interface_epoch），ifIndex 重用不能接续原 counter；mount/device/fs_type 保留文件系统身份。可变名称按具体定义选择：若用作维度，重命名即新序列，不隐式拼接。

`DimensionSchema` 冻结允许/必需键、值长度、可选枚举和每资源最大序列数，未知键拒绝。生产接入需在整个活跃窗口按定义与策略较小上限原子计数；`validateObservationBatch` 检查单批，不能当作跨批基数存储。溢出拒绝该项并记录 cardinality_exceeded，不合并成“other”伪造身份。

单位采用明确枚举：By 是字节，bit/s 是位速率，s/ms 为时间，% 是 0–100 口径而非 0–1，1 为无量纲，count/count/s 是对象计数/速率。相同单位不保证语义相同。新单位需要契约版本升级，不能任意字符串绕过验证。

- int64/uint64 用规范十进制字符串编码，范围分别为 [-2^63, 2^63-1]、[0, 2^64-1]；拒绝前导零、指数、负零和数值型 Counter64。float64 必须有限。单位换算不经 JS Number 截断整数；不能无损表示时标记 precision_loss 与估算准确性，或拒绝输出。
- Histogram 的 bucket count 是**按上界累计**的非负整数，界限严格递增，最后 +Inf 的 count 等于总 count；sum 为有限数。Summary 保存 count/sum/quantiles，但分位值不可合并。分布 kind 独立于累计/区间 temporality，累计分布也需 epoch。
- 时间字段为 UTC ISO 8601，最多毫秒精度，拒绝更细精度以免哈希截断。observed_at 是源值代表的时刻；collected_at 是接收时刻；stored_at 是首次持久化时刻（尚未落库为 null）。要求 observed ≤ collected ≤ stored。源时钟超前时拒绝/隔离该样本并记 clock_skew，不把接收时间伪装成观测时间。
- 每项包含 quality/reason、accuracy、production、source、语义引用、包/转换/契约版本、配置 revision。质量不能从资源状态、模板或同批其他项推断。
- Counter 至少包含累计 start_at 或 discontinuity 的 epoch/时间/原因，位宽明确。首次、reset、wrap、source_change、gap 不可混成零增长；无可靠证据不计算 rate。不能把已求差的 gauge 再求差。

`observationIdentity` 计算 SHA-256：stage、序列、observed_at、source（含 attempt）、版本和 lineage/raw_field。observed_at 在哈希前统一为 UTC ISO 毫秒表示。不含 stored_at，重试使用原 attempt；同 ID 同载荷是幂等重放，同 ID 不同载荷必须冲突，禁止覆盖。服务端首次 stored_at 保持不变。跨次采集新 attempt 产生不同 ID；不以时间相同自动丢掉真实独立样本。`validateObservationBatch` 演示冲突校验，持久化层仍须唯一键与原子比较。

## 数据流与质量传播

固定顺序：decode → unit_convert（需要时）→ counter_delta → rate（需要时）→ derive（需要时）→ normalize → aggregate。单位换算必须声明白名单且输出单位匹配定义；rate 前必须有 delta。派生只能引用已验证输入，先拓扑排序，拒绝未知依赖、重复输出和环。禁止同 metric 在 collector 与 derived 同时拥有有效来源。

RawObservation 是类型化的**逐项源值**，不是必须永久保存的 SQL/SSH/SNMP 全响应；可以只保留血缘引用和所需证据，原始响应按单独留存策略丢弃。Raw 可用 input_unit；Normalized 必须匹配定义单位/值类型。`validateObservation` 检查单项，`validateLineage` 检查引用及质量不能升级；下游必须联合使用，不能只验 schema。

- measured/derived 表示产生方式，exact/estimated/unknown 表示准确性。精确输入和无损运算的 derived 仍为 exact；不是自动 estimated。启发式原始 gauge 可以是 measured + estimated。
- good 配 reason=none 且有值；partial 必须有具体 reason 且有值；unknown/invalid 必须具体 reason 且 value=null。缺失不补零，真实零则 good + 实际来源证据。
- 传播按 good < partial < unknown < invalid；准确性按 exact < estimated < unknown。取最差输入，只可进一步降级；无输入为 unknown/missing_input。禁止历史 legacy_unknown 升级 good/exact。历史旧值保留旧接口和审计来源，不伪造 Raw 或把行级 is_estimated 拆成逐项精度事实。
- derived 的 sum/difference 同单位；ratio 输入同单位，输出 1 或 %（% 乘 100）；scale 保持单位且 factor 显式；rate 使用同序列前后 counter，Δ/elapsed_seconds，By→bit/s 乘 8。rate 运行时要取同 counter epoch 的两个样本，并应用 max_counter_gap_ms；声明 DAG 的单个 counter 输入表示序列依赖，不表示只需一个采样。
- 默认 join 同资源且维度完全相同，max_skew_ms 约束普通派生输入。输出 observed_at 为输入最大时间；规范化时间不得早于所有输入。ratio 分母为 0/缺失、rate baseline/reset/gap 输出 null 并记录相应 reason。禁止跨维度广播和隐式 join。`validateDerivedObservation` 校验普通派生实例；rate 的双样本/epoch 算术由后续 Counter processor 实现。
- network traffic fixture 表示 MAX-63 的 (7000−1000)×8/60=800 bit/s；host filesystem ratio 为 268435456/1073741824=0.25，精确二进制可表示。不要求本项实现计算器。

聚合先检查定义允许操作和输入类型，再检查覆盖度/质量。累计 counter 不 sum/mean；summary p95 只能保留单样本，禁止 avg(p95)、跨序列加权 p95；histogram 在边界兼容、单位相同且时窗一致时先 merge 再 quantile，累计 histogram 必须先按 epoch 差分避免重复计数。缺失保持 null；覆盖率=有效采样槽/预期采样槽，重放只算一次，未达到 min_coverage 输出 unknown 或 partial（仅有足够定义的部分值时）。分布边界不兼容时拒绝聚合，不能自动插值宣称精确。

## 正交状态与转移

|状态轴|转移与触发|明确禁止|
|---|---|---|
|Capability|unknown → supported/unsupported，基于资源/版本/权限/方法证据；属性/权限变化重新判定；过期按 unknown 使用，保留旧证据|timeout 将 supported 改 unsupported|
|启停配置|enabled ↔ disabled，由新 revision 生效；policy/binding/metric 任一关闭均 disabled|关闭时删除历史、能力变 unsupported|
|Attempt|running → succeeded/partial/failed/cancelled；terminal 不可改（同内容重放除外），重试新 ID|把失败覆盖成成功、失败造观测|
|Freshness|无可信 observed_at 为 unknown；age≤stale_after 为 fresh，否则 stale；新样本可恢复 fresh|按最近尝试时间刷“新鲜”|
|Quality/accuracy|每项不可变，派生/聚合传播最差输入；新记录可有不同质量|补写旧行 good、以 unsupported 推断 0|
|Definition|active → deprecated；新语义新 ID|复用旧 ID 改语义|
|Package/Profile|每版本不可变；升级/回退均显式指向已登记版本|修改原包、模板改变产品列|
|Alert evaluation|disabled；有效连续命中 → pending → firing；有效不命中 → normal；缺失/不准入 → unknown，并保留 last_known_state|unknown 当 normal，缺失满足恢复条件|

Attempt partial 表示同 collector 仅部分项成功，成功项各自正常存储，失败项缺失；不能将所有成功项一律估算。timeout 的 fixture 与 Capability 分开，保持 supported。Capability 不存 observed value；Attempt 不存指标零值。

## API 契约（待下游实现）

统一 `/api/metrics/v2`，Canonical/Extension 共用入口和 MetricRef。所有响应声明 contract_version；未知 ID/version 返回明确错误，不 fallback 到近似指标。现有旧路由不重定向至新语义。

|接口|请求/响应与约束|
|---|---|
|GET `/definitions?category=&resource_type=`|MetricDefinition[] + contract_version；按精确版本查询；扩展同接口|
|POST `/definitions`|MetricDefinition；schema + validateCatalog（含已有全部定义）；冲突 409|
|GET `/profiles/:id/versions/:version`|CoreProfile；只有产品发布可新增版本，模板无写权限|
|POST `/packages` / GET `/packages/:id/versions/:version`|CollectorPackage；内容摘要由服务端对 canonical JSON（不含 digest）计算核对；已存在版本不同内容 409|
|PUT `/policies/:id`|CollectionPolicy；If-Match 前一 revision，缺少 428，不匹配 412；revision 严格递增|
|PUT `/bindings/:id`|CollectionBinding + 该 binding 的 MetricBinding[]；If-Match config_revision，事务检查全资源唯一来源与包/策略 pin|
|GET `/bindings/:id/plan`|CollectionPlan；对应精确配置 revision、Capability 和解析时间|
|POST `/derived` / PUT `/alerts/:id`|DerivedMetric / AlertPolicy；校验全 DAG 或阈值单位；告警更新 If-Match revision|
|GET `/capabilities?resource_id=`|Capability[]；重评估产生新证据，不能写失败尝试为能力|
|POST `/attempts` / PUT `/attempts/:id`|CollectionAttempt；validateAttemptTransition，terminal 不可变|
|POST `/observations`|RawObservation[] 或 NormalizedObservation[]；联合结构/语义/来源/血缘校验，幂等重复 200，新建 201，冲突 409|
|POST `/query`|MetricQuery → MetricQueryResponse；精确资源/指标/维度、[from,to)、limit/cursor；同一授权模型；返回逐项质量与 freshness|
|POST `/aggregate`|AggregationRequest → AggregatedObservation；请求内含资源和维度选择器，拒绝违规聚合 422|

结构无效 400；未知定义/版本 404；语义/单位/循环/质量违规 422；身份/版本/来源冲突 409；能力不确定/不支持返回明确 plan decision 而非空成功数值。授权仍使用现有资源访问控制，契约不是新增权限豁免。上述 URL 冻结对象操作意图，路由落地必须带对应 DTO/schema；GET/query 和写入需同一资源身份解析。

## 样例与验收索引

- 三类资源、属性、Canonical/Extension、估算 gauge、精确 derived：`fixtures.json`；例值来源与 MAX-63 一致，Extension 的正式命名不对旧接口静默改名。
- Raw/Normalized、Counter64 超 2^53、超时仍 supported：同文件；focused cases 在 `contracts.test.ts`。
- 非法单位、语义冲突、同项多源、派生循环、质量/缺失、兼容版本、avg(p95)、精度边界、基数、包/profile 不可变、晋升、attempt 转移：测试逐项拒绝。
- 重建产物：`pnpm --filter slide-api exec tsx src/contracts/metrics-v2/export.ts`。
- focused：`pnpm --filter slide-api exec vitest run src/contracts/metrics-v2/contracts.test.ts`；完整证据见 `validation.md`。

下游必须实现并验证：跨批 cardinality/幂等原子性、真实来源/包摘要鉴别、Counter/Derived 算术及 epoch、DAG 执行、分布聚合、告警状态机、授权/路由与存储。此清单不阻塞本契约独立验收，但不得把纯契约测试当作这些运行时集成已完成。
