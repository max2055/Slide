# MAX-239 / OPENING-EVIDENCE — 内部交付说明

范围：在已接受的 `UNKNOWN-SEGMENT` 之后，给**纯 episode 迁移**补上「打开时的证据冻结」。
输入仍是已接受的触发快照身份、该身份的上一条 episode 记录（可为空）和一条 `evaluateTriggerRule` 结果；本包只在记录上多写一个字段，不改判定、不改开闭规则、不改水位线。

12:12 的复审把「详情保存发生时指标身份、命中值/时间」和问题条件、有效阈值、覆盖、revision、通知回执收成同一句，并以「没有事件 writer」结束。后半确实缺输入；前半的输入已经在 `2d63d0709` 的 `TriggerEvaluationResult` 上（`item`、`metric`、`value`、`reason`、`evaluated_at`）。`TriggerEpisodeRecord` 原本只把时间和最新证据留在 `last`，下一次判定就会盖掉命中的值、原因和指标身份。本包只补这个冻结。

本包**未挂载**：不改 `evaluate.ts`（`evaluateTriggerRule` 一个字节未动）、不改 `catalog.ts` 语义、不改 238 codec、alerts writer / `server-alert-evaluator`、不改 MAX-240；不新增路由、公开导出、DB/迁移、3306 写、事件 writer、outbox、worker、通知、ack 或 `eval`。整单 MAX-239 仍为 `in_progress`。

## 1. 文件

| 文件 | 作用 |
|---|---|
| `apps/db-ops-api/src/metrics/triggers/episode.ts` | 新增 `TriggerEpisodeOpening`、记录的 `opened` 字段，以及只在打开时写入的 `openingOf` |
| `apps/db-ops-api/src/metrics/triggers/episode.test.ts` | 新增 3 个用例，全部由真实 B2C 解析 → 快照 → 纯判定结果驱动 |
| `apps/db-ops-api/src/metrics/triggers/journal.ts` | 记录 schema 接受 `opened`；`opened` 及其 `item`、`metric` 按严格对象校验 |
| `apps/db-ops-api/src/metrics/triggers/journal.test.ts` | 新增 3 个用例：带 `opened` 的读回、缺 `opened`/缺字段拒绝、`opened` 多余字段拒绝 |
| `docs/slide/development/MAX-239/opening-evidence.md` | 本说明 |

`catalog.test.ts` 的 7 个既有行为没有改，也没有改夹具：它的记录都由真实迁移产生。

## 2. 记录字段

```ts
opened: {
  item: { template_id: string; item_id: string; item_version: number };
  metric: { id: string; semantic_version: string };
  value: number | null;
  reason: TriggerEvaluationReason;
  at: string; // 与这条记录的 opened_at 相同
}
```

- 五个字段逐项取自**打开这一次**的 `TriggerEvaluationResult`：`evaluation.item`、`evaluation.metric`、`evaluation.value`、`evaluation.reason`、`evaluation.evaluated_at`。
- `reason` 复用既有的 `TriggerEvaluationReason`，没有新造字符串；打开时它由判定给出（`problem`），本包不强行改写。
- `item` / `metric` 用的是评估结果上已有的身份，不是从 scope 字符串反推。
- `opened.at` 与 `opened_at` 由构造保证相等：两者都来自同一次评估的 `evaluated_at`。
- **没有**加问题/恢复表达式、有效阈值数字、覆盖率、config revision、模板版本号或通知回执：这些不在评估结果上，本包不加，也没有去改 `evaluateTriggerRule` 把快照塞进结果。

## 3. 行为

| 上一条记录 | 判定 | 下一条 |
|---|---|---|
| 无 | problem | 新 episode，`opened` 来自这次评估；`occurrence: 0`、`unknown_segments: []` |
| 无 | healthy / 未知 / nodata | `null`，不造记录，也不造 `opened` |
| open | problem 保持 / 未知 / nodata / stale | 同 id，只改 `last`，`opened` 原样保留 |
| open | recovery | 同 id、`closed`、`closed_at` 写入、`recovery_count: 1`、`last` 写恢复证据；`opened` 原样保留 |
| closed | 再次 recovery / 未知 / healthy | 原记录不变；`opened` 不变 |
| closed | 新的确定 problem | 新 id、`occurrence + 1`、新 `opened` 来自这次新评估，不复制上一条；`unknown_segments: []`、`unknown_open_from: null` |
| — | 更早的判定（水位线） | 返回**原记录对象**，`opened` 不变，文件字节不变 |
| — | `rule_not_found` | 该身份记录原样返回 |

- 身份哈希、`episode_id` 推导、occurrence 规则、scope、开闭规则、水位线比较和未知区段折叠都没有改。
- 另一身份的记录仍读不到、写不到（既有用例继续覆盖）。

## 4. 日记

- `opened` 是记录的一部分，按 `TriggerEpisodeRecordSchema`（严格对象）校验；`opened` 本身以及它的 `item`、`metric` 都是 `strictObject`。
- 缺 `opened`、`opened` 缺 `item`/`metric`/`value`/`reason`/`at` 任一项，或 `opened`（含 `item`）多出字段 → `TRIGGER_EPISODE_JOURNAL_RECORD`：不当成空日记从 `occurrence:0` 另开，也不覆盖原文件。回条件、身份哈希、临时文件改名和损坏文件的拒绝码都没有改写。
- 同一目录的新实例读回已关闭记录时，`opened`、episode id、occurrence 和 `recovery_count: 1` 一起回来。

## 5. 验证（本 SHA）

在 `apps/db-ops-api` 下，复用主检出已安装依赖（软链，未 `pnpm install`，未改其他 worktree）：

```
./node_modules/.bin/vitest run src/metrics/triggers src/contracts/metrics --maxWorkers=1   # 8 files / 143 tests passed
./node_modules/.bin/tsc --noEmit                                                          # exit 0
./node_modules/.bin/tsx src/contracts/generate-public-api.ts --check                      # exit 0（= contracts:check）
```

新增用例覆盖：

1. 打开后 `opened` 的 item / metric / value / reason / at 与这次评估一致，且 `at === opened_at`；随后的 problem 保持、nodata、stale、recovery 只改 `last`，`opened` 不变；关闭后仍带着原 `opened`；replay recovery 返回同一对象。
2. 关闭后的新 problem：新 id、`occurrence:1`、新 `opened` 来自新评估（值不同），旧记录的 `opened` 不被复制也不被改写，`unknown_segments` 仍从空数组开始。
3. 更早的判定返回原记录对象，`opened` 不变；无上一条记录且不打开 episode 时仍返回 `null`，不造 `opened`。
4. 日记：已关闭记录由新实例连同 `opened` 一起读回；缺 `opened` 或缺任一子字段被拒且不覆盖原文件；`opened` 与 `opened.item` 上的多余字段同样被拒。

测试只用真实 B2C 解析、真实快照和纯判定；没有手写评估结果冒充打开。日记用例只用本包创建并在结束时删除的临时目录。
未重跑 238 MySQL 与 manifest；单测不冒充持久化、事件、通知或 UI。

## 6. 反例（不能写成已通过）

- 这**不是**「事件详情页已通过」：记录只有 `opened` 这一项字段，没有详情页、没有路由、没有查询，也没有把记录挂到任何运行时调用链。
- 这**不是**「有效阈值、问题/恢复条件、覆盖、revision 已保存」：这些字段不在 `TriggerEvaluationResult` 上，本包明确没有加，也没有改判定去补。
- 这**不是**「通知重试不重发已通过」：没有 outbox、没有投递尝试记录、没有回执，也不抑制或追补任何通知。
- 这**不是**「已部署进程重启已通过」：`opened` 只存在 episode 记录上，journal 的读回是新目录、新实例，不是已部署进程。
- 这**不是** MAX-240 的历史：`opened` 不落历史表、不画图、不提供「当时阈值」对照——它只冻结命中值、原因、指标身份和时间。

## 7. 仍然开放（不属于本包）

1. 把 episode 记录（含 `opened`）挂到运行时调用链，并由事件 writer 落库。
2. 问题/恢复条件、有效阈值数字、覆盖率、config revision 与模板版本快照——需要判定结果或其上游提供这些输入。
3. 通知投递、重试不重发与回执。
4. 与 binding `applied` 同事务的写入围栏。
5. 触发器 UI 与事件中心详情展示。
6. 三类真实资源的触发/恢复与正式通知回执。
