# V2＋V3 当前功能交付与历史资格记录

当前规则 **functional-delivery-1**（Max决定 `01a158e3-e259-796a-b2df-722b012b74e4`）替代下方历史记录中的长期案例、观察天数、真实质量阈值、生产/shared Edge、MAX-192资格及先merge要求。产品权限、不可变版本、双主体、once、审计和unknown不重发保持。开发交付in_review，done及全批最终接受由Max确认。

## 当前候选与范围

沿PR211保留旧工具head `552fdb0d11d887af8b87997b2c29d9ad4383eae7` 全部历史，普通merge纳入已审P11 head `42b2dfb9bb141620bb6e804773c67eb940bb1c4c`。下列P01–P10准确候选逐一核实为P11祖先。PR211改以P11分支为base，增量仍仅本包工具、直接测试和本报告三个文件。准确最终head/CI见任务交付及矩阵附件，不在本文嵌入自身提交hash。

P01–P06已历史合入；P07–P11是已审开放候选，不称已merge/部署。P10为MAX-203部分归档＋MAX-207唯一承接，203的done不代表完整P10已合并。

| 包 | 实现范围 | 准确代码候选 | CI | 独立审查定位 |
|---|---|---|---|---|
| P01/MAX-194 | 内部契约/权限/flags/schema | [PR201](https://github.com/max2055/Slide/pull/201) @ `09193e6f6f130a981be082f610d76647b37af938` | [准确候选](https://github.com/max2055/Slide/actions/runs/38933826940) | `01a145a7-4e46-775d-bdf9-c668be5314fc` |
| P02/MAX-195 | 可信资源关系 | [PR203](https://github.com/max2055/Slide/pull/203) @ `e15d2146b9ea0085938a40932deeb85f0ef53482` | [准确候选](https://github.com/max2055/Slide/actions/runs/38945689535) | `01a145fc-effe-789d-b85c-549dc6a52123` |
| P03/MAX-196 | 案例治理/检索/引用 | [PR205](https://github.com/max2055/Slide/pull/205) @ `bac0a71bd87db4c2c8de6162b9b6827d1d0a277f` | [准确候选](https://github.com/max2055/Slide/actions/runs/38940769842) | `01a145d5-de5a-7469-935d-3f5d02c62a75` |
| P04/MAX-197 | 语义指标基线/正式来源 | [PR207](https://github.com/max2055/Slide/pull/207) @ `2ef6e5c11c9bd7cf0f6013186ed5c355fd0cae2a` | [准确候选](https://github.com/max2055/Slide/actions/runs/39003355864) | `01a14838-7aad-7c86-a2fb-81172b925aef` |
| P05/MAX-198 | 多事件关联/评分 | [PR210](https://github.com/max2055/Slide/pull/210) @ `8508ccaadc3cdb402e6fe0bdc7e8ace442d8f3ae` | [准确候选](https://github.com/max2055/Slide/actions/runs/39008852756) | `01a1488a-78f4-7f36-a6c8-8723836cda5b` |
| P06/MAX-199 | 不可变计划/准确审批 | [PR204](https://github.com/max2055/Slide/pull/204) @ `67853ceb20db48f7f365a96872e4771a40b7f128` | [准确候选](https://github.com/max2055/Slide/actions/runs/38947190261) | `01a14605-8e3d-75f9-a2c1-9a9494015446` |
| P07/MAX-200 | 独立执行/固定helper/once | [PR206](https://github.com/max2055/Slide/pull/206) @ `89435614b8cba11b5cfb48bfb2f60b760fa884ff` | [准确候选](https://github.com/max2055/Slide/actions/runs/39411420893) | `01a15902-e35c-76d2-b00e-cd1c0b5ab1fb` |
| P08/MAX-201 | 效果验证/人工结案 | [PR213](https://github.com/max2055/Slide/pull/213) @ `af2637a0084a9458bdc3c36acffdc1976877838d` | [准确候选](https://github.com/max2055/Slide/actions/runs/39427910847) | `01a15980-c5cf-795e-97a4-0db3dd93e30e` |
| P09/MAX-202 | 真实页面/资源上下文/导航 | [PR214](https://github.com/max2055/Slide/pull/214) @ `f1839a8eddcd6ff7e3bfd070e6015711e6ddc706` | [准确候选](https://github.com/max2055/Slide/actions/runs/39448727895) | `01a15a0f-6587-76f2-b9a0-fb7f5dd882b3` |
| P10/MAX-207 | 迁移/装配/性能/模型引用 | [PR212](https://github.com/max2055/Slide/pull/212) @ `c9fe7452c27e8f9f13d12d12847afbbe699e936e` | [准确候选](https://github.com/max2055/Slide/actions/runs/39403377567) | `01a158f3-5352-777e-99e8-554bf1df488a` |
| P11/MAX-204 | 正式server/独立worker/受控全链 | [PR215](https://github.com/max2055/Slide/pull/215) @ `42b2dfb9bb141620bb6e804773c67eb940bb1c4c` | [准确候选](https://github.com/max2055/Slide/actions/runs/39456896283) | `01a15a3a-2dd5-7ce3-b767-06b76b25a61d` |

审查定位为Chief独立run或评论UUID，在对应Multica任务可回读。数量有交叠不相加，路径/环境条件跳过不计通过。

## B01–B18 功能矩阵

| 项目 | 已实现功能及owner | 回归与已审证据 |
|---|---|---|
| B01 | P03：作者/审者分离、准确版本、脱敏canary | `apps/db-ops-api/src/operations/knowledge/knowledge.mysql.test.ts`；P03独立21项SQL/JWT/HTTP；P11案例闭环 |
| B02 | P03/P09/P10：实时撤权/过期、WS/深链/计数及迟到响应 | `apps/db-ops-api/src/operations/knowledge/knowledge.mysql.test.ts`、`frontend/e2e/operations-ui.spec.ts`；P09真实服务浏览器9；P10持久引用出站撤权33项 |
| B03 | P03/P10：固定来源/版本/hash，referenceOnly与当前证据分离、tombstone | `apps/db-ops-api/src/operations/composition-evidence-scope.mysql.test.ts`；P03/P10独立审查；P11重开案例失效 |
| B04 | P12：全cohort去重、固定分母5/完整相关集recall/macro、标签/版本/权限绑定 | `apps/db-ops-api/tests/operations-readiness.test.ts`；42项受控协议回归，5例synthetic可验功能；真实质量unknown |
| B05 | P02：双端权限、过期/循环/2跳100边、legacy hosts | `apps/db-ops-api/src/operations/relations/store.test.ts`；P02 39项/真实SQL21，独立R1反例复验 |
| B06 | P04：正式source身份/单位/dimensions/reset及不足窗口unknown | `apps/db-ops-api/src/operations/baselines/baselines.mysql.test.ts`、`apps/db-ops-api/src/operations/baselines/calculator.test.ts`；P04 SQL60/父5项R1；P10提交后实时授权19项 |
| B07 | P12：同holdout标签、两算法误报分母/重要漏报及unknown空值 | `apps/db-ops-api/tests/operations-readiness.test.ts`；原28项+功能模式14项；synthetic对照不是业务改善结论 |
| B08 | P05：确定性关联/评分/拆分/分页、unknown区间、零额外LLM | `apps/db-ops-api/src/operations/attention/attention.mysql.test.ts`；P05 43项/SQL27/父29项及授权过期时序 |
| B09 | P06/P11：不可变全字段hash、独立主体/once/过期撤权与范围 | `apps/db-ops-api/src/operations/actions/plan-service.mysql.test.ts`；P06 SQL86；P11正式composition/JWT/HTTP准确审批 |
| B10 | P07/P11：并发/重复/双worker、持久intent/outbox、副作用一次 | `apps/db-ops-api/src/operations/actions/execution.mysql.test.ts`、`apps/db-ops-api/src/operations/actions/verification.mysql.test.ts`；P07 Q01–18；P11双worker磁盘计数1 |
| B11 | P07/P11：发送前后故障/崩溃、unknown不重发、原回执只读恢复 | `apps/db-ops-api/src/operations/actions/execution.mysql.test.ts`、`apps/db-ops-api/src/operations/actions/adapters/restart-demo-service.test.ts`；helper子进程SIGKILL/磁盘回执；P11丢SSH后reconcile计数仍1 |
| B12 | P07/P11：取消/撤权发送竞态、flags停新写/保留审计 | `apps/db-ops-api/src/operations/actions/execution.mysql.test.ts`；前后边界0/1副作用；P11正式composition回归 |
| B13 | P08/P11：120/60/300/10，exit0非resolved、缺样本/无改善、不可变报告和人工重开 | `apps/db-ops-api/src/operations/actions/verification.mysql.test.ts`、`apps/db-ops-api/src/operations/actions/evidence-adapter.test.ts`；P08行动反馈234；P11报告→关闭→发布→重开→tombstone |
| B14 | P06/P07/P11：固定host/unit/pin/helper，签名/文件权限/注入/普通工具旁路 | `apps/db-ops-api/src/operations/action-environment.test.ts`、`apps/db-ops-api/src/operations/actions/runtime-ports.test.ts`、`apps/db-ops-api/src/operations/actions/adapters/restart-demo-service.test.ts`；P07工具威胁/R1审查；P11独立配置/公开契约13项 |
| B15 | P09/P11：四入口/三类资源/调查上下文，明暗/1600/1024/390/键盘/a11y | `frontend/e2e/operations-ui.spec.ts`；P09已批R1对照95项证据；P11真实Lit/SQL/JWT/HTTP浏览器9 |
| B16 | P10：同机同角色/规模聚合分页、避免N+1 | `apps/db-ops-api/src/investigations/list-aggregation.test.ts`；1万调查/10万synthetic事件，780样本，六组P95 173.99–252.80ms≤500ms；cold仅重建服务/连接池 |
| B17 | P10/P11：128/129/130增量/重入/保留回退、旧Chat/审批/unknown/WSS | `apps/db-ops-api/src/migrations/operations-upgrade.mysql.test.ts`、`frontend/e2e/investigation-tls.spec.ts`；P10 SQL迁移/装配23；V1兼容CI；P11正式server/独立worker |
| B18 | P10/P11：受限案例→Provider草案、实时出站ACL、usage/noReplay、不可跳审批 | `apps/db-ops-api/src/operations/knowledge/knowledge.mysql.test.ts`、`apps/db-ops-api/src/investigations/execution-recovery.mysql.test.ts`；P10受控Provider/SQL/HTTP33；历史真实deepseek主链/恢复按准确版本复用；P08修复未发送清理时序 |

每行按owner关联上表准确候选、CI与独立审查；当前P12新组合候选的CI和Chief独立审查见任务交付，owner不自签通过。

## 工具模式与兼容性

`inspectEvidence`及显式`--mode qualification`保留原冻结协议和历史真实资格算法。CLI默认`--mode functional`使用相同去重/检索/基线/对照算法，要求输入provenance全部synthetic、案例/冻结审核kind为agent且主体分离，不接受real/unknown/human冒充。准确bytes hash、版本/权限/标签/事故/有效期校验、固定脱敏错误、输出wx不覆盖原件均保留。

`functionalEvidence`仅表示这份受控fixture协议/算法材料可独立审查，不能替代全批CI/代码审查/最终接受。默认CLI退出0/2依此字段，qualification模式依历史dataEvidenceStatus；缺输入为2，格式/输出错误为1。五个synthetic案例足以验证功能；固定分母5、全部相关集recall、macro不变。低于0.80及对照无改善仍如实输出，取消其作为本批结束阈值。基线仍用P04的14/28天语义算法，合成时间窗立即运行，不等待真实天数；缺测/reset维持unknown。

历史顶层`dataEvidenceStatus/B04/B06/B07`单独保留，`productQualificationChanged=false`、`finalAcceptance=not_evaluated`不变。synthetic的真实计数为0、真实有效天数为null，不改写真实资格通过。pnpm可能包装退出2为1；从API目录直接`node --import tsx ../../tests/qualification/operations-readiness.ts`可取得原码。

## 验证、边界与接续

原28项历史回归保留，新增14项功能模式/CLI检查：5例synthetic、低P/R数值、重复cohort零评分、标签/权限/版本/hash/主体/事故/单位/过期/reset及bytes绑定。最终受影响模块、准确head完整CI、产物hash在交付附件记录；未变产品/UI/模型/真实现场证据按准确代码复用。

2026-10-17只读盘点中的真实可信案例0、有效观察日0、真实质量unknown原样保留。原生VM三次40条、3308三次16/16及恢复见历史评论`01a14979-6d27-7d02-8d2e-f0ae926207dc`，仅为当时短时采集/恢复，本轮不重采、不注入、不操作旧对象。

P11真实部分为隔离MySQL/JWT/HTTP/Lit/持久worker/SSH2/签名adapter/helper源码与磁盘副作用；身份、环境验证器、健康事实及虚拟等待为synthetic。root/固定路径/systemctl仅fixture替换，不声称VM/systemd生产资格。部署者仍须提供受保护签名材料和独立持续健康采样源，不属于本批部署或长期质量承诺。

当前矩阵记录已实现功能；本P12增量的Chief独立审查与Max全批确认尚待接续。长期数据/生产现场不是待补工程项。没有merge/deploy/生产行动授权；回退停新派发、核在途/unknown、撤入口/worker、保留数据/审计，不DROP或重放。无人工读屏/VoiceOver门禁。

本轮产品模型调用0、子代理0，canonical预算和历史unknown/保守计入不清零；编码token/费用实测不可用。

---

下方为 **2026-10-17历史记录**：保留原始数字/失败和当时规则，不再用作当前结束或接续条件。
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

上述退出码指工具进程本身；pnpm11 的 `--filter ... exec` 可能将子进程退出2包装为1。需按退出码区分缺口和格式错误时，从 `apps/db-ops-api` 直接执行 `node --import tsx ../../tests/qualification/operations-readiness.ts`（其余参数相同），或读取报告的门禁状态；不要把pnpm包装码当作工具输入错误。

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
