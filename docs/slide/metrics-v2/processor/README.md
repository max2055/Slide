# Counter / Derived Processor（MAX-66）

入口：`apps/db-ops-api/src/metrics-v2/index.ts`。使用 MAX-64 契约 1.0.0；不改 schema、不注册路由、不替换现有采集器。SQL/SSH/SNMP 解析仍由适配器负责；MAX-67 的模板引用此模块，不能复制 counter 算法。

## API 与顺序

|入口|输入|输出|
|---|---|---|
|`normalize(raw, definition, context)`|已解析的 RawObservation、精确指标定义、显式 now/stale_after_ms|Computation|
|`processCounter(input, definition, outputDefinition, operation, state, options)`|Raw 或 Normalized 累计 monotonic counter、目标 gauge、delta/rate、可序列化基线、gap/可选增长上界|`{ state, advanced, output }`，不写状态|
|`executeDerived(nodes, definitions, inputs, execution)`|单资源/维度组的 Normalized Computation、冻结 DerivedMetric DAG、显式目标来源/版本与基线快照|拓扑顺序 outputs 与新的 states Map，不写存储|

调用方先完成绑定/能力/模板校验，传入逐项观测。模块验证观测身份、定义、单位、精度、时间、质量和幂等 ID；不会认证驱动是否真实提供了数据或重启证据。

固定顺序为 decode → 精确单位转换 → counter delta → rate → derived → 最终编码/normalize。counter 内部把源单位因子作用于精确差分，与先精确换算两个端点再相减等价，避免先把累计值编码为 float。若需要对非整数单位换算后的 counter 求差，直接传 RawObservation 给 processCounter；不要先有损 normalize。

### 数值与单位

- 中间值为约分后的 BigInt 有理数；int64/uint64 不经过 Number。float64 解码的是实际 IEEE-754 值，而不是其十进制打印近似。
- 同单位直接通过；转换白名单：s↔ms、By/s↔bit/s、1↔%。rate 支持 By→By/s/bit/s、count→count/s；不做 By→count 等猜测。
- 最终 uint64/int64 只有整数且范围合法才输出，否则 invalid/precision_loss + null。float64 无损可表示则保持 exact；舍入为 partial/precision_loss，accuracy 至少 estimated；溢出返回 invalid/precision_loss + null。
- 此处理器仅计算 scalar；histogram/summary 不进入算术，分布聚合不在本项范围。

### 基线与异常

锁键是 `seriesIdentity`（资源类型/ID、指标 ID/语义版本、排序后的完整维度）。状态保存当前有效来源和累计周期；来源签名包含 collection/metric binding、collector、包/契约/转换版本、config revision、源单位及位宽，不包含 attempt_id。累计周期取 start_at 及 discontinuity。来源 A→B→A 每次重置，绝不恢复旧 A 基线。

`processing_revision` 钉住计算消费方的计划/公式；gap 和增长上界也参与状态签名。直接调用时默认使用输入 transform_version；调用方有独立公式版本时必须显式提供 processing_revision。DAG 自动将同一 counter 的全部 rate 消费者 ID、输出引用、转换版本、目标来源及配置/包版本形成稳定指纹；新增消费者或升级派生转换后，所有共享消费者一致重建基线。attempt_id 不参与该指纹。

|情况|输出|基线|
|---|---|---|
|首样本|unknown/counter_baseline，null|保存样本|
|同时间、重复或更早（包括旧源延迟消息）|unknown/clock_skew，null|不推进；精确重放应先命中 receipt|
|源/版本/位宽/累计起点或 discontinuity 变化|unknown/counter_reset，null|保存新周期样本|
|缺失/unknown/invalid|原最差质量，null|保留有效基线|
|已丢失精度的累计值|invalid/precision_loss，null|不推进|
|时间差大于 max_gap_ms|unknown/gap，null；保留实际窗口|以当前样本重新建基线|
|正常|Δ 或 Δ×1000/elapsed_ms；By→bit/s 再乘 8|推进|
|真实无增长|真实 0，不是缺失补零|推进|
|负差分且无可靠 wrap 证据|unknown/counter_reset，null|重新建基线|

32 位要求驱动提供可信 `max_increment_per_second`（规范非负整数字符串，**原始源单位/秒**）。整段最大可能增长必须小于 2^32，实际差分不得超过该上界。下降恢复还要求当前 discontinuity.reason=wrap、证据时间在 `(前样本, 当前样本]`、start_at 不变，才加一次 2^32；输出 partial/counter_wrap，但算术仍可 exact。缺少上界、上界允许多次回绕、上界被违反或无回绕证据均返回 null；即使数值增加也不能掩盖多次回绕的不确定性。64 位不推测 wrap，下降即 reset。

驱动必须持续携带同一累计周期的证据；不能每次采样伪造新 epoch。回绕后的证据若被删除或改变，保守重建基线。策略/驱动声明不可信时不能开启回绕恢复。

### DAG、窗口、质量和血缘

只支持契约中的 sum/difference/scale/ratio/rate，无任意脚本。最多 256 节点、1024 条输入边；拒绝重复依赖引用（重复加同一项请使用 scale）、未知依赖、循环、重复来源和非 scalar 运算。采用 `validateCatalog` / `validateDerived` 冻结语义，拓扑计算。

普通运算严格同资源和全部维度匹配；输入时间差超过 max_skew_ms 返回 unknown/clock_skew。区间运算的全部输入必须有相同窗口，不能把不同时间窗口的 rate 相除，也不隐式把瞬时 gauge 当作区间值；不匹配返回 unknown/gap。ratio 分母为零返回 unknown/invalid_denominator，缺依赖返回 unknown/missing_input；失败沿下游传播。百分比 ratio 乘 100；精确 derived 不自动 estimated。

输出 observed_at/collected_at 取实际输入最大时间，stored_at=null。NormalizedObservation 保持冻结结构；Computation 携带 `{window, freshness, input_provenance}`：

- window 为输入覆盖窗口；counter 使用前后采样的真实时间。普通 DAG 继承完整窗口。
- freshness 单独传播，fresh < stale < unknown；按显式求值时间重新检查窗口起点，不能用派生时间把旧输入刷新。stale 不伪写成质量 reason。
- quality 按 good < partial < unknown < invalid，accuracy 按 exact < estimated < unknown。已有失败不得被 missing/zero/precision 检查升级；同等级算术错误可成为输出 reason，原始输入仍可从血缘定位。
- observation.lineage 是直接输入引用，input_provenance 还保留传递的输入 ID、stage、metric、来源及全部版本。target 显式指定派生来源、配置及转换版本，必须等于 DerivedMetric.transform_version。
- 所有依赖都缺失时，由经过契约验证的真实 anchor 提供资源/维度、求值触发时间及血缘，输出 missing_input；anchor 不被当成运算值。没有真实 anchor 的采集失败只记 CollectionAttempt，不制造观测。
- 同一批多个 rate 节点读取同一初始基线快照，各自计算完成才返回新状态；不会第二个节点看到已推进基线而产生伪空值。

## 多 worker、事务和重放契约

`state.ts` 的 CounterStateAdapter 只定义适配边界。生产调用方必须满足：

1. 同一 logical series 只允许一个当前 owner；使用单调 fencing token。取快照 revision，纯计算，再原子核验 owner/fence 和 revision。
2. CAS 事务同时保存基线、**该输入的全部计算 outputs**、input receipt。多个 rate/delta 消费者同批计算，不各自独立推进同一基线。丢弃竞争失败的候选，重新读 receipt/快照再算。
3. receipt 键为 `(replayNamespace, inputId)`，payloadDigest 覆盖规范化时间及除 stored_at 外的完整不可变输入；执行计划/策略必须钉住版本。相同 ID/载荷返回原始 outputs，不能重算成 clock_skew 或改写 freshness；不同载荷返回 payload_conflict。
4. commit 内也要检查 receipt，不能只在事务前查询。相同 receipt 返回 replayed 且不推进 revision；旧 owner 返回 fenced，旧 revision 返回 revision_conflict；绝不覆盖原输出。
5. 冷启动恢复持久化基线（全部值为 JSON 字符串，未存 BigInt），没有基线则产生首样本 null；驱动/计划变更需要新 revision。receipt 保留时间至少覆盖允许的重试范围，超出保留期不能声称完全重放保证。
6. 历史重算使用独立 `replay:<job/version>` namespace、独立状态，按 observed_at 排序并确定同时间样本选择；同时间不同 attempt 仍不推进第二次。不得写 online 基线/receipt；升级转换后显式新 namespace，不覆写旧观测。
7. 多个 counter 输入的 DAG 发布还需调用方保证输入快照一致性、结果幂等及原子提交/事务 outbox；CAS 接口不提供跨序列事务或外部副作用 exactly-once。

`state.test.ts` 是单线程内存协议模型，只证明 CAS/fencing/receipt/隔离语义。真实数据库、租约接管、并发调度和外部副作用验收归 MAX-70，跨链路归 MAX-76；本项不以这些未实现能力宣称上线。

## 验证、接入与回退

确定性 counter 样例在 `fixtures.json`，测试从 import.meta.url 解析，不依赖 cwd。完整覆盖索引在 `processor.test.ts`、`state.test.ts`；MAX-64 的 validator 同时校验生成结果。

接入时导入上述入口，复用模板和契约定义；不要复制测试 fixtures 作为生产指标目录。当前仅新增模块与文档，无数据库迁移、配置写入或已有路径行为改变。回退为撤回本项提交；将来接入后的回退需明确新的配置 revision 并重建相应基线，不能跨转换版本接续旧状态。
