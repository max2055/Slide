# MAX-239 / TEMPLATE-TRIGGER-SNAPSHOT — 内部交付说明

范围：原 MAX-239 的首个可独立、可安全实施的代码包——**规则定义 → 固定版本解析 → 不可变资源规则快照 → 纯判定**。
本包**未挂载**：不改路由、不改 `payload.binding` 持久化、不写事件/outbox、不发通知、不建 episode、不启动 worker、不触碰 DB/3306。
整单 MAX-239 / MAX-235 仍为 `in_progress`；本包只是内部实现，不等于真实告警、通知、UI 或生产验收。

## 1. 输入与基线

| 项 | 值 |
|---|---|
| 依赖安全提交 | `797ab6b47ca2f49d428563e4185fb3f142f0347c`（草稿 PR #567 head，base `e11f6ba2e`） |
| 集成方式 | 以依赖 merge 方式并入本任务分支，保留任务起点 `faf76b4fa8b779f0c4c0fc0fd231df1b5ebda5fb`；未 merge/push 任何原风险祖先 |
| 任务分支 | `agent/15coder1/max-239` |

producer-inputs.json 的 10 个文件在集成后逐 blob 与 clean release 一致（`git hash-object` 实测）：

| 文件 | blob |
|---|---|
| `src/contracts/metrics/templates.ts` | `bdd455ccc218c9e8543eaee6ad5bc5686f414170` |
| `src/metrics/templates/model.ts` | `5b955b8e7a3d127fdf81e0943b37fd0b425098a5` |
| `src/metrics/bindings/compile.ts` | `821b28ff1fefb1aba5d685951a44233046e67466` |
| `src/metrics/bindings/resolve.ts` | `2f19b806f24cd202e93dcf560d07e88f9acfe1d0` |
| `src/metrics/bindings/plan.ts` | `b480088a9bb1b07d269447c9fb47dd4d59532ee0` |
| `src/metrics/bindings/persistence-codec.ts` | `83e73e9502ac24713925774ea9bdf959104f3dce` |
| `src/contracts/metrics/configuration.ts` | `5ba0f92103c145b9a99ed3fcdf73f602fecc850d` |
| `src/metrics/consumers/evaluation.ts` | `c3c1d3f4161f1aae1939c5164c42403f3ea53ba0` |
| `src/metrics/arithmetic.ts` | `3790d6d6522d6b45e49d72815c04012a0e5ecd8c` |
| `src/alerts/compiled-rule.ts` | `6164431d0b741ffade8f3fee5e54e4d6aa497f7b` |

前置缺口（已核实）：`TemplateTriggerRefSchema` 只有 `rule_id/version/scope=item:<id>`，B2A compile → B2B resolve → B2C plan 把 refs 原样携带，既有 plan/persistence codec 没有已解析的触发阈值/AST。本包补齐这段内部链路，不改动 238 的 codec/schema，也不删除其 unresolved refs 兼容。

## 2. 新增文件

| 文件 | 作用 |
|---|---|
| `apps/db-ops-api/src/contracts/metrics/triggers.ts` | 最小内部 triggers 契约：受限 AST、规则版本、候选/快照、可信应用证据、样本；**不从 `contracts/metrics/index.ts` 导出** |
| `apps/db-ops-api/src/metrics/triggers/model.ts` | canonical hash（规则 body / 规则快照 / 资源快照）、表达式预算、深拷贝冻结 |
| `apps/db-ops-api/src/metrics/triggers/resolve.ts` | 固定 `(rule_id, version)` 解析 + 身份/单位/语义版本/参数/预算校验 |
| `apps/db-ops-api/src/metrics/triggers/compile.ts` | 候选 → 不可变快照、`verifyTriggerSnapshot`、`checkTriggerSnapshotFence` |
| `apps/db-ops-api/src/metrics/triggers/evaluate.ts` | 纯判定：业务状态与证据质量分离、nodata、unknown 不恢复 |
| `apps/db-ops-api/src/metrics/triggers/test-support.ts` | 真实 B2A/B2B/B2C fixture（sealed release + registry + 固定模板版本），非手写 plan |
| `src/metrics/triggers/{resolve,compile,evaluate}.test.ts`、`src/contracts/metrics/triggers.test.ts` | 39 个用例 |

## 3. 契约要点

- **受限 AST**：`compare`（`last` / `avg` / `min` / `max` + `window_ms`）、`all`(AND) / `any`(OR)、`> >= < <= = !=`、常量或参数阈值。没有函数调用、`eval`、`new Function`、SQL/脚本文本、宏、Zabbix 语法。组节点至少 2 个子节点，没有隐式取反——recovery 必须独立书写。
- **硬上限**（`TRIGGER_LIMITS`，规则不可上调）：深度 5、节点 32、窗口 ≤ 1 天、序列 32、参数 16、单快照规则 64。超预算稳定码拒绝，不截断。
- **规则版本**：`{rule_id, version, scope:'item:<id>', metric, unit, parameters, problem, recovery, quality, clock, content_hash}`；`content_hash` 覆盖除自身外全部字段。
- **快照**：资源 type/id、config revision、B2C plan identity、模板 pin + content hash、rule id/version/body hash、item 身份、canonical metric + semantic_version/unit/dimensions、已解参数、独立 problem/recovery、质量/覆盖/时钟策略、canonical snapshot hash。`applied/effective` 恒为 `false`，`status:'candidate'`；没有把候选变成已生效的 setter。

## 4. 稳定拒绝码（节选）

解析：`TRIGGER_RULE_MISSING / INVALID / IDENTITY / HASH_MISMATCH / CONFLICT / READ_FAILED`、`TRIGGER_TEMPLATE_*`（来自 B1 复验）、`TRIGGER_RESOLUTION_MISMATCH`、`TRIGGER_ITEM_UNKNOWN / AMBIGUOUS / MISMATCH`、`TRIGGER_METRIC_MISMATCH`、`TRIGGER_SEMANTIC_VERSION_MISMATCH`、`TRIGGER_UNIT_MISMATCH`、`TRIGGER_PARAMETER_UNKNOWN / UNRESOLVED / TYPE / RANGE`、`TRIGGER_EXPRESSION_BUDGET`、`TRIGGER_RULE_BUDGET`。
编译：`TRIGGER_CANDIDATE_INVALID`、`TRIGGER_SNAPSHOT_INVALID`、`TRIGGER_SNAPSHOT_HASH_MISMATCH`。
围栏：`TRIGGER_FENCE_EVIDENCE_INVALID / NOT_APPLIED / RESOURCE_MISMATCH / REVISION_MISMATCH / PLAN_MISMATCH`。

不 fallback `latest`、不按 metric/display 名称猜规则、不把 pending 当 applied。

## 5. 判定语义

- 业务状态 `problem | healthy | unknown` 与证据质量 `good | partial | unknown` 分开返回。
- 95 → `problem`；85（此前 problem）→ `problem_retained`；60 → `healthy` + `recovery:true`。
- `>90` / `<70` 边界精确（90 不触发、90.5 触发；70 不恢复、69.5 恢复）。
- 缺测、过期、不连续窗口、低覆盖、单位/语义版本不符、时钟偏斜、超序列预算、未 applied：均为 `unknown`，`recovery:false`，已开问题保持 `problem_open:true`。
- 显式 nodata 由 `now` + `last_seen_at` 按时钟判定，无需新样本；独立触发（`nodata:true`），问题期间不恢复。
- 恢复需要“恢复表达式成立且问题表达式已不成立”；两个表达式重叠也不会关闭在线问题。
- 旧样本不会冒充恢复：`last` 受 `stale_after_ms` 约束，窗口聚合只取窗口内样本。
- 输入没有 ack 字段，任何确认信息都无法传入，因此确认不可能改变判定或触发操作。
- 数值比较复用 `metrics/arithmetic.ts` 的 rational 工具；质量/覆盖/精度门控沿用 `metrics/consumers/evaluation.ts` 语义。

## 6. 验收映射

| 原始验收 | 本包覆盖 | 说明 |
|---|---|---|
| 95 触发、85 保持、60 恢复，90/70 边界准确 | ✅ `evaluate.test.ts` | 纯判定层 |
| 中断保留问题并显示未知，nodata 独立触发，确认不恢复/不执行操作 | ✅（nodata/unknown/ack 不可入参） | episode/确认持久化不在本包 |
| 重复消息/评估/重启只有一个 episode 和一次恢复；通知重试不重发 | ❌ 未实现 | 需事件 writer/episode/outbox，属后续挂载包 |
| 当前阈值 90→95，历史事件仍用 90 快照 | ✅ `compile.test.ts` | 快照独立复制、hash 不变、旧快照仍可重验 |
| 三类真实资源触发/恢复、正式通知回执、权限/脱敏负例 | ❌ 未实现 | 需真实采集与通知链 |
| 事件无重复规则编辑入口、聚合/AI 只引用原记录 | ❌ 未实现 | UI/事件中心属其他包 |

## 7. 验证（本 SHA）

在 `apps/db-ops-api` 下，复用已安装 `node_modules`（未 `pnpm install`，未改其他 worktree）：

```
./node_modules/.bin/tsc --noEmit                       # exit 0
./node_modules/.bin/tsx src/contracts/generate-public-api.ts --check   # exit 0（= contracts:check）
./node_modules/.bin/vitest run src/metrics/triggers src/contracts/metrics \
  src/metrics/bindings src/metrics/consumers/service.test.ts src/alerts \
  --maxWorkers=1                                       # 19 files, 444 tests passed
```

新增用例 39（resolve 10、compile 7、evaluate 14、contract 8）。单测/内存目录不冒充真实采集、episode、UI 或正式通知。

## 8. 明确的挂载缺口（不属于本包）

1. **规则目录持久化**：本包 catalog 是显式内存 port，不声称生产者已发布到 DB；需表结构、发布流程、内容 hash 幂等与权限。
2. **事务 applied fence**：快照写入与 `payload.binding` 的 applied revision/plan identity 必须同事务绑定；本包只提供纯校验接口，不改 238 codec/存储。
3. **唯一事件 writer / episode**：开闭转换、去重、重启不重建、重复消息幂等属事件域。
4. **通知 outbox/回执**：投递渠道、对象引用、状态与回执。
5. **UI 与权限/脱敏**：模板触发器编辑、历史快照跳转、事件中心四标签。

以上需要真实输入与证据，owner 为 MAX-239 + MAX-238 + 既有 alerts/通知 owner；本包不把这些写成需成员补字段的外部阻塞。
