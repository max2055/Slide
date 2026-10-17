# V2＋V3 数据资格与阶段交付

本报告为 MAX-205/P12 的第一阶段工程和证据盘点，核验日期 2026-10-17。实施依据是 MAX-193 附件 implementation-1.2，SHA256 `459c81c1b67a3867db8ba181e91da6ebe075e8e676f5d77a3ff735ccae48e915`。真实数据资格 **blocked**；全批工程、P11 和 Max 最终接受尚未完成。工程工具可独立审查，不因此关闭 P12。

## 1. 基线、范围与证据效力

独立 worktree 基线 `1c3578f3d7ebace2953117be9dcffa0060a69497`，包含以下准确 head 和 merge（已逐项检查 main 包含性）：

| 前置 | PR / head | merge | 当前可复用结论 |
|---|---|---|---|
| P03/MAX-196 | #205 / `bac0a71bd87db4c2c8de6162b9b6827d1d0a277f` | `ae4cac429d94f2716bd55425fbf4bc291c4e5550` | 父独立审查通过；真实 SQL/JWT/HTTP 21 项，准确 head CI 12 成功/2 路径跳过 |
| P04/MAX-197 | #207 / `2ef6e5c11c9bd7cf0f6013186ed5c355fd0cae2a` | `4d40f1796c22ec292d9e49b126fd0ecdc931f914` | 父独立复审通过，R1 已解决；真实 SQL 60 项，父原反例复验 5 项，CI39003355864 通过 |
| P05/MAX-198 | #210 / `8508ccaadc3cdb402e6fe0bdc7e8ace442d8f3ae` | `1c3578f3d7ebace2953117be9dcffa0060a69497` | 父授权交接已独立复审通过；CI39008852756 12 成功/2 路径跳过，真实 SQL 27 项；父两种授权过期时序等 29 项通过 |
| MAX-192 | #209 / `9c263f66b48cf62a6167d49e9d847b1286a77d33` | `2b804daee7255f154dd1717b6eb43519e8b31464` | Chief 独立审查、14/14 准确 head CI39004223841、实际合并均已核实；来源/迁移证据见下节 |

P12 只新增离线资格工具、专属回归与本报告。工具不连接数据库、HTTP、VM 或模型，不启动采集，不修改资格开关、权限、迁移、历史观测或审批；P03 的产品返回仍为 `not_qualified`。本阶段无视觉变更。真实来源与迁移回退盘点复用上述未修改模块的已审证据；本轮另对隔离 MySQL 执行模块回归，不能将其 synthetic 调查输入描述为真实业务全链。

## 2. 有权限证据盘点

| 对象 | 已取得的可复核证据 | 数量/时长及结论 |
|---|---|---|
| 真实案例 | P03 交付附件 `01a145d5-8346-763e-8e12-f34a7f5a4b32`；明确案例 SQL 为 synthetic，真实 cohort、事故组、真人审核和检索质量未核验 | 全平台可信真实案例数 **unknown**，不是 0，也不是 ≥30 |
| 历史 V1 评估 | implementation-1.2 §1.1 记录 T11 真人定性接受、七维数值 unscored、原失败和盲评未测 | 不等于 30 个发布且独立人审的可信案例，不能迁移计数 |
| 正式来源短时实采 | P04 修复交付附件 `01a14837-78a8-7b50-8316-a6291330de06`：自有隔离 MySQL9.6、4 次固定 SQL、3 次 formal publication、8 条保留观测；调度时钟受控 | 该专属窗口有效日 **0**、coverage=0、missing=336、`unknown/long_gap`；不能推广为全平台时长 |
| P04 合成历史 | 原 P04 temporal-synthetic 和 R1 reaccumulation 报告 | 仅算法/竞态反例，真实有效天数不计入；不能由 14/28 天时间戳跨度推断实采 |
| 外部正式来源 | MAX-192 已审报告复用 MAX-189 正式 MySQL/VM 周期、MAX-190 三周期、MAX-191 R10 正式查询/恢复 | 证明来源闭环和短时有效值；全平台连续 14/28 天有效观测仍 **unknown** |
| 检索和静态质量对照 | 无已冻结并获真人确认的真实查询、相关标签、人工检索结果及同事件时间外比较集合 | precision@5、recall@5、两算法误报率与新增重要漏报均 **unknown**，无改善结论 |

尚未取得限定操作者、权限角色和资源范围的真实 cohort/正式历史导出。本阶段盘点以上已获授权的任务附件和源码，不跨权限扫描业务内容，不读取外部 A 专属秘密，不尝试 VM 认证。上述 unknown 需要受权来源核实，不能由工程测试补齐。

## 3. 唯一来源与迁移资格

MAX-192 不是按 `done` 标签解锁。本轮通过 CLI 回读关联 PR，核 GitHub 准确 head/14 个检查、Chief 评论 `01a14848-35a7-79ad-bb2a-49c659661e79` 与实际合并补充 `01a14849-780c-796a-97ba-d77eba579a39`。merge 和 head 均在 P12 基线 main。

下载并复算最终证据包附件 `01a14844-ae12-7a61-89ed-f36479ed6ca7`：139026 字节，SHA256 `87d51f2a7e318b3416b863877a64e957ab8601d8f59aa98e5c6987e4938bd4b2`。内部 migration manifest 的 7 个文件大小/hash 全部吻合，包含旧/新 schema dump、迁移账本、回滚和最终恢复快照。已核对：取消 fence、幂等唯一约束、audit request_id、lineage/revision、unknown/null、原 observed/stored 时间保持；恢复不重放任务。活动 schema 24 表/188 列/50 索引/29 约束审计无未许可代际残留；源码两项历史兼容例外仍显式保留。

效力仅为已审唯一正式来源及**隔离 schema 备份恢复**工程证据。dump 中业务 payload 为 synthetic，不用于真实案例或观测时长。未进行生产部署/生产迁移，不证明任意损坏的原地恢复。真实来源复用表明确记录运行源码与后续变化，不能声称全部服务已运行 MAX-192 最终 head。

Chief 已说明：合并前 main 加入 P04，实际 merge 全树与 CI 候选不完全相同；metrics/迁移/frontend/命名/报告路径未变。CI 候选 `d9917fdeb76bc28b94e58f89f7d1c32435a20d89` 与 head 的 tree 相同，不能用该包认证整个后续 main。PG/Oracle/达梦远端、真实复制多通道及物理 SNMP 未实测；VM counter epoch/磁盘/网络缺口继续保留。P12 不接管 MAX-188～192 或扩大这些结论。

## 4. 离线资格工具

入口 `tests/qualification/operations-readiness.ts`，专属自动回归 `apps/db-ops-api/tests/operations-readiness.test.ts`（由现有 API Vitest/CI 自动发现）。复用 P04 `calculateBaseline`，不另造观测算法或指标存储。

```bash
# 无输入：输出 unknown/blocked；退出码 2 是预期的资格缺口，不是成功准入
pnpm --filter slide-api exec tsx ../../tests/qualification/operations-readiness.ts

# 文件路径相对命令执行目录；预先建立输出目录，输出必须是新文件
pnpm --filter slide-api exec tsx ../../tests/qualification/operations-readiness.ts \
  --input <受权冻结JSON> --review <真人冻结审核JSON> --output <新报告JSON>

pnpm --filter slide-api exec vitest run tests/operations-readiness.test.ts
```

输入/审核格式以导出类型 `ReadinessDataset` / `FreezeReview` 为准，全部时间为毫秒精度 UTC ISO。单输入上限 25 MB。集合上限和完整性检查失败返回退出码 1，只输出固定错误码，不回显输入/文件路径；缺数据或门禁失败为 2。全部机械门禁满足仅返回 `ready_for_independent_review` / 0，**不等于正式资格接受**。

必须由有权限操作者提供以下内容；不得复制秘密或无权限案例全文：

1. `schemaVersion=1`、`frozenAt`、`permission.{role,revision,evidenceRef}`。audit locator 必须能让独立审查者在受保护系统回读原记录；本工具不联网解析 locator。
2. `cases`：准确案例 id/version/contentHash、来源 investigationId、真人归并 incidentGroup、`provenance`、生命周期、有效期、author、来源证据 locator；独立人审包含 kind/reviewer/时间/locator/绑定 version/contentHash。冻结前由操作者与真人审查者选定每调查、每事故的唯一代表，至少 30 个不同真实调查且 30 个不同事故组。工具保守拒绝整个 cohort 中任何重复 investigationId 或 incidentGroup，包括同调查多版本、同事故跨调查近重复、冲突或传递映射、未出现在查询中的副本；不隐式选版本。不合格、自审、过期、撤回、旧 hash 审核不计入可信数量。
3. `queries`：不同事故的真实冻结查询、适用产品/资源版本、角色与权限 revision、visibleCaseIds、**全部** relevantCaseIds、最多 5 个 rankedCaseIds 和人工 humanCaseIds、人工检索/标签 audit locator。四类集合必须引用上述同一独立 cohort；发现重复 cohort 时 B04 返回 `duplicate_investigation_or_incident_in_cohort` / blocked，全部算法与人工质量指标为 null，不按副本计算或在评分后补位。调查/事故 distinct 数仅为诊断，不能覆盖重复门禁。所有标签及结果必须在可见 cohort 中；查询事故不得与参考事故重叠，重复事故查询拒绝。有效独立 cohort 的 P@5 固定分母 5（空位算未命中），R@5 分母是全部相关独立案例；每查询计算后 macro average，两值均 ≥0.80。人工对照使用同一评分边界单独输出，不把其结果复制成模型/算法结果。去重/改代表须重新冻结全部集合并对准确 bytes 重新人审。
4. `baselines`：每个申请系列的 provenance、正式来源 locator、静态规则版本 `staticRuleVersion`、原静态阈值、P04 `BaselineInput` 和完整 `BaselineSourceWindow`。冻结内容包含资源/metric/单位/dimensions/source/binding/configuration/transform/counter epoch、方法和窗口。工具要求日内和周模式均有材料，复算 P04 的 14/28 有效日、90%覆盖、训练槽重复次数、6 小时长缺口、漂移、当前新鲜度和最后 7 天 holdout；无插值。混合桶单位/指标/dimensions、目标不符或过期快照拒绝。结果仅适用于逐系列，不由一个指标外推全部资源支持。
5. `labels` 逐小时绑定同一时间外窗口与真实 audit locator：normal/anomaly/important；与所有可比较 holdout 桶精确对齐，不允许重复、训练期或部分挑样。两算法在同一标签上复算；误报分母为 normal，基线误报率不得高于静态，静态命中而基线漏掉的 important 必须为 0。缺正常/异常标签或静态规则不作改善结论。
6. 数据冻结后，操作者提交独立 `FreezeReview`：schemaVersion、精确文件 bytes 的 datasetSha256、`kind=human`、reviewer、reviewedAt、evidenceRef；审核时间必须介于冻结与当前时间。查询/标签/ACL/阈值/窗口任意 bytes 改动使审核失配。不是让代理把自己的校验报告填成真人审核。

工具校验的是导出协议、绑定关系和数值门槛。JSON 自报 `real`/`human` 本身不是可信证明：独立审查仍须回读来源、真实人审、正式查询血缘和当时/当前权限，核 counter reset/目标切换等来源约束；离线权限快照也不能替代产品出站实时 ACL。报告不包含案例文本/查询/原始 ids，不使用或输出业务凭据，不安装 helper；`productQualificationChanged=false`、`finalAcceptance=not_evaluated` 固定保留。产品正式准入装配另由 P10/父任务按审定结果处理。

## 5. B01～B18 当前缺口矩阵

以下为 2026-10-17 阶段盘点，不代替各 owner 最新交付；最终全批矩阵仍等待 P11。

| 门禁 | 工程证据 | 仍须的真实/集成证据 |
|---|---|---|
| B01、B03 | P03 已审 SQL/API/版本/脱敏/参考隔离 | P10 装配、P11 Provider 业务链 |
| B02 | P03 权限/撤权/过期/迟到专项已审 | P09 页面/深链/WS 与 P10/11 端到端 |
| B04 | P12 冻结/去重/检索校验工具 | ≥30 真实独立人审、冻结查询/标签、人工检索与 P/R≥0.80，blocked |
| B05 | P02 已审关系边界 | 正式 UI/消费者联动验收 |
| B06 | P04 已审正式来源/算法/首次目标切换竞态；MAX-192 来源迁移已核 | 全平台 14/28 天与逐系列质量 unknown，blocked |
| B07 | P12 同标签时间外对照校验 | 真实周期/标签/静态规则版本及误报/重要漏报，blocked |
| B08 | P05 已审关联/评分/最终授权过期修复、零额外模型调用 | 正式装配/端到端回放 |
| B09 | P06 已审版本/双人分离/授权边界 | 正式执行链的逐计划真实批准 |
| B10～B12 | P07 候选实现/安全及 CI 不等于真实 helper 验收 | P07 目标信任/只读盘点通道、真实一次性执行/计数/故障/取消/撤权；blocked，不能解锁 P08 |
| B13 | P08 尚未交付 | 效果验证/人工结案真实状态链，等待 P07/P11 |
| B14 | P06/P07 候选安全证据 | 目标/helper 实装及独立安全/产品入口链，等待 P11 |
| B15 | 不属 P12 视觉修改 | P09 准确设计/真实浏览器/适用可访问性；不恢复人工听读门禁 |
| B16 | 不属 P12 性能范围 | P10 同硬件/角色/规模 P95、SQL 计数及评审 |
| B17 | MAX-192 隔离迁移恢复可复用 | P10 operations 增量迁移/在途回退及 V1 完整兼容回归 |
| B18 | 本阶段无产品模型调用 | P10/P11 受限真实 Provider/工具/HTTP/SQL、共享账本 usage 与 unknown 不重放 |

## 6. 接续与停止条件

工程阶段可经父独立审查和必要 CI 合入；只算 P12 的部分交付，不将 P12 或全批置 done。数据申请必须逐系列和真实 cohort 定义范围，不凭 PR 合并、静态报告、短时实采或合成标签自动升级产品资格。

解除数据阻塞的最小输入是：有权限操作者的 cohort/查询/人工标签/正式历史的受保护导出及准确文件 hash 人审记录，含上述角色和资源范围；或指定现有可用的受控只读盘点通道与同等范围。无需重新提供已有相同凭据。缺真实时长时等待实际累积，不重写 observed_at、缩短窗口、复制记录或重复运行同一准备表。

P11 完整交付后再汇总全批工程/行动/设计/数据/独立审查、准确 head CI、实际 merge 和 main 包含性；由父协调按 completionPolicy 处理普通工程包，由 Max 保留全批最终接受。任何未满足项继续列为 blocked/unknown。回退先停新派发、核对在途/unknown，撤入口/worker而保留历史、证据和审计，不 DROP、不重放动作。

本阶段产品模型请求 0，不创建或重置 AI-Operations-V23 canonical 账本；编码 token/费用实测不可用。无子代理。

## 7. 初始候选验证（P12-R1 修复前的历史证据）

Node24.18.0 / pnpm11.19.0。专属工具类型检查（扩展现有 API tsconfig、将 rootDir 设为仓库根并包含工具/专属测试）通过；API/前端 typecheck、前端 build/CSP、contracts:check、qualification:matrix 37/37、安全扫描、14 项 CI 选择器测试、两文件 lint 和 diff 检查通过。保留既有前端体积/动态导入提示。

自建回环隔离容器 `slide-max205-readiness`，MySQL9.6.0，ID `955d692275c0a24e3a232a02d7c405d6299e8cedc93bfde94d0f15e0e54334fa`，label `slide.task=MAX-205`，端口58971。执行 `OPERATIONS_TEST_MYSQL_PORT=58971 P04_REAL_REPORT=<专属输出> pnpm --filter slide-api exec vitest run tests/operations-readiness.test.ts src/operations --maxWorkers=1`，25文件/317项通过，无跳过；包含18项专属资格协议测试及实际SQL/JWT/HTTP/撤权/过期/unknown/保留回退测试。初次未配SQL端口时的60项跳过已由本次实际通过取代。调查、长窗口和人审身份均为 synthetic 测试输入，不能计入 B04/B06/B07 的真实数据。只停止本任务已核label/ID的容器，测试随机库自动清理；未触及共享产品服务或VM。

真实业务盘点无新数据输入：命令无input时实跑退出2，输出案例数和检索质量null、各数据门禁blocked、productQualificationChanged=false。准确head完整CI和父独立审查/merge由任务交付记录接续，不以本地检查代替。

## 8. P12-R1 修复与当前验证

父独立审查针对初始 head `571fa7ad2fee866f7800ae42bd46d3bec55a990b` 提出 P12-R1：调查/事故仅在30例阈值去重，quality 按 case id 计分；30个独立调查/事故外增加4份副本，仍能让5份同源结果得到 P/R@5=1。原18项测试和 CI39011201311 的14绿未覆盖此反例；初始候选不构成独立审查通过。

当前选择保守拒绝重复的整个冻结 cohort，在评分入口同时约束 visible/relevant/ranked/human；拒绝时不产生算法或人工数值质量声明。未改 P03/P04、产品路径、权限、指标、迁移或CI。原字节审核绑定、实时权限外部门禁、事故隔离、固定分母5、完整相关集 recall、macro average 与0.80均保留。

真实执行 `inspectEvidence` 的红绿回归：修改实现前19通过/9失败/0跳过，实现修复后28通过/0失败/0跳过。新增10项覆盖两个父原反例、超过30例独立cohort的有效0.80及完整相关集、同调查不同事故冲突、同事故不同调查冲突、无查询引用的副本、四类查询集合以及跨查询传递冲突。所有 real/human 字段均为 synthetic 协议值，不是真人或真实长期数据；报告的 null 表示因重复而未计算，不是0分。

原父附件的18项加两个原始反例未改断言重放20/20通过；这是owner重放，不能代替父独立复审。当前受影响Operations检查157通过/170条件跳过，未配置实库门禁；不将跳过计作通过，未变SQL/HTTP证据沿§7复用。工具与专属测试的TypeScript检查、两文件lint、diff检查通过；仓库未配置该工具行覆盖率，本轮未额外安装覆盖率依赖，未声称覆盖率百分比。

受影响检查与新准确 head 的完整CI结果见本次任务交付附件和PR；父非实现上下文独立复审继续保留。无新增SQL/HTTP产品路径，§7及前置包未变的真实SQL/HTTP证据按原范围复用，不声称本次重新实测VM或长期观测。B04/B06/B07真实数据资格仍blocked，可信案例/有效时长/质量unknown；最终汇总仍等P11。部分PR合入不得自动关闭P12：当前平台PR关联仍有auto_complete等待配置，未经受支持方式保证不会误关整包前保留PR，不移除真实关联。
