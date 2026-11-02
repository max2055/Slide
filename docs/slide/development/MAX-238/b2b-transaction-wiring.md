# MAX-238 B2B：应用前事务接线图（只读设计，未接线）

2026-10-27。本文件逐项标出 B2B 内部守卫与当前生产源码之间**尚未建立**的连接。共享文件在本包中全部只读；本包没有改动 `policy`、`store`、`config`、`scheduler`、运行时、路由、DDL 或生成契约，也没有提前运行 DDL 或写入服务。行号对应本包 HEAD（B2A 接受基线 `78c841e7c45cacb42fcfc6fd16fc2076700ccd0d` 之上仅追加本包文件；R1 补修只改守卫/测试/本目录文档，共享文件行号不变），后续接线前必须重新核对。

## 接线总表

| 现有入口 | 后续同一事务接线要求 | 最小恢复事实 |
| --- | --- | --- |
| `apps/db-ops-api/src/contracts/metrics/templates.ts:462` `PackagePinSchema`、`:468` `TemplatePinSchema`、`:489` `ResourceBindingCandidateSchema`；`apps/db-ops-api/src/metrics/policy/model.ts:38` `Binding`、`:55` `Published` | 缺 `template_pins`/空 pins 走原 single-package 分支；多 pins 走独立显式分支。保持现有 JSON `payload.binding` 唯一事实与 `revision` CAS，禁止用 `as` 断言掩盖 `package` 可空与 legacy 消费者不兼容。精确列出新增字段及其读者，不先放宽全局类型。 | 字段级兼容决定：`Binding` 是否内联 `template_pins`、`Published.resolved` 是否保持 opaque、遗留 payload 缺失字段的读取规则；现有读者清单逐个确认。 |
| `apps/db-ops-api/src/metrics/policy/service.ts:96` `changeBinding`（`:14` `candidateFingerprint`、`:24` `assertAccess`、`:101` revision CAS、`:119` `expectedCandidate`） | 复用其 `expected_revision` CAS、事务与审计；现权限检查在事务外（`:97`），模板分支还必须在异步读/试采后重验，R1 起 legacy 也走同一最终边界。现 `candidateFingerprint`（`:14`）只覆盖单 package 结果，**不能**当作多模板受测 digest。预览、保存不启用、启用、测试凭证入口必须分别标明，不能混为 publish。 | `prepareTemplateBindingMutation` 的准确 API/HEAD 被接受；模板分支的权限复验点、`candidateFingerprint` 与 `bindingCandidateDigest` 的边界（前者是解析后执行输入，后者是候选身份）由 Chief 决定。 |
| `apps/db-ops-api/src/metrics/policy/store.ts:6` `PolicyTransaction`、`:14` `saveBinding`、`:15` `audit`、`:74` `MysqlPolicyStore`、`:76` `transaction`、`:92` `metric_policy_lock id=1 FOR UPDATE` | 模板分支的 binding 变化、服务端 receipt 校验/消费、幂等回执、审计必须在同一 `transaction` 内、同一连接视图完成。receipt/操作信息的候选位置是现有 payload 的内部附属元数据，**不新增 binding 权威**；最终类型、保留期与现有读者兼容验证通过后才准入适配器。 | 操作回执/审计的准确存储位置与保留期；旧 payload 读取兼容验证；事务内“读-校验-保存-回执-审计”顺序与幂等键唯一约束。 |
| `apps/db-ops-api/src/metrics/config/service.ts:22` `ActivationGuard`、`:47` `activate`、`:83` `trial`、`:113` `before_request` 检查、`:55` “some good sample” 门禁 | 复用 `guard.check`/`reloadActor`/`assertCurrent` 生命周期，试采 I/O 位于锁外；之后进事务重验前述事实。现 `:55` 只要求“某个 good sample + 某次 succeeded/partial”，**不足以**作为多模板全部必需项通过证明，不可复用为 receipt 签发依据。新受信 receipt issuer 必须来自既有采集执行结果，不接受 HTTP 客户端提交的成功结果。 | receipt issuer 的准确来源、逐项必需项语义与过期/撤销规则；试采执行结果到 receipt 的映射；`ActivationGuard` 与模板事务入口的组合顺序。 |
| `apps/db-ops-api/src/metrics/scheduler/compiler.ts:19` `compilePlan`；现有 runner | 现 `compilePlan` 只支持单 release（`registry.get(binding.package)`），B2A 输出是 unresolved candidate；后续必须先有完整 resolver/兼容性/参数与 multi-release 执行计划，再接调度。正式 runner/历史/事件写路径本包禁止，前一份有效配置必须继续保留。 | 完整 multi-release resolver 的契约与文件唯一写者；`Resolved`/`CollectionPlan` 的多模板表示；失败时保留上一份有效配置的回退路径。 |

## 本包已经证明与尚未证明的边界

**守卫内部已覆盖（focused tests，见 `b2b-transaction-guard.md`）**：

- 受信视图是唯一当前状态来源；请求只能给 `receipt_id` 与 `caller_key`，不能携带 `compiled`、`candidate_digest`、`passed` 或 receipt 内容。
- 候选身份 `bindingCandidateDigest` 覆盖资源、base/target revision、固定 pin/hash/release、qualified item、collector/mapping、完整 `package`/`group_id`/`overrides`、B2A unresolved 来源与受信配置依赖摘要。
- 权限在候选/receipt 读取前读取一次，全部异步工作后再经同一最终边界复验一次；legacy/replay/unknown/prepared 四种成功返回路径都覆盖 allowed、cancelled 与依赖摘要不变，撤权、取消、依赖身份变化均拒绝。
- 受信时钟 `BindingTransactionPort.serverNow()` 为**同步**契约：最后一次异步授权后再同步读取，随后到决策构造不再 `await`；Promise/thenable/缺失/抛错/非法时间均拒绝。该契约留给未来受信适配器实现。
- 幂等键 `resource + target_revision + digest`；caller key 参与碰撞检查；已提交精确重试 replay，未知结果只返回“需查原操作”。
- 拒绝/取消/异常不改变任何输入，且本模块没有任何写入口。

**尚未证明（不得据本包宣称通过）**：

- 真实 MySQL `metric_policy_lock` 串行化、`saveBinding` CAS、回滚与 receipt/审计同事务原子提交。
- 真实资源权限在事务提交瞬间不变；本包只把可变端口用于 TOCTOU 反例。
- 真实受信时钟适配器仍不存在；`serverNow()` 的同步契约只定义未来适配器必须满足的形状，不证明提交瞬间的时钟一致性。
- 试采凭证的真实签发、持久化、撤销与过期；`BindingTransactionPort.getTrialReceipt` 目前仅是端口契约，没有任何生产实现。
- 多模板 resolver、兼容性/参数最终值、multi-release `CollectorPlan`、调度、正式应用、健康/首样本与解绑流程。
- 解绑/空绑定由未来显式流程接线；本包既不实现，也不删除历史。

## 放开前的最小条件

后续放开这些精确共享源码的前置是：接受本包准确 HEAD/API（含 R1 的最终边界与同步时钟契约）；确定 receipt 信任边界与存储表示；确定唯一 revision 并在同一事务内兼容旧 payload；事务内幂等/审计/权限复验；完整 resolver 及文件唯一写者。Chief 在终态复审中据源码制定下一准确包；不要求 MAX-236 整单 done，也不以本设计通过称生产能力存在。需要新 DB/共享 DDL/生产写/负载/额外权限时先核现授权，仅挂起受影响动作。
