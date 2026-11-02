# MAX-239 / UNKNOWN-SEGMENT — 内部交付说明

范围：在已接受的 `LATE-WATERMARK` 之后，给**纯 episode 迁移**补上「未知区段」的记录。
输入仍是已接受的触发快照身份、该身份的上一条 episode 记录（可为空）和一条 `evaluateTriggerRule` 结果；本包只在记录上多写两个字段，不改判定、不改开闭规则。

方案 A04 的前半（中断不误恢复）已经在 `2bebac247` 的转移里：未知证据不关闭 open episode。本包补后半：未知区段留在记录上，下一次有效判定不会把它盖掉。

本包**未挂载**：不改 `evaluate.ts`、不改 `catalog.ts`、不改 238 codec、alerts writer / `server-alert-evaluator`、不改 MAX-240；不新增路由、公开导出、DB/迁移、3306 写、事件 writer、outbox、worker、通知、ack 或 `eval`。整单 MAX-239 仍为 `in_progress`。

## 1. 文件

| 文件 | 作用 |
|---|---|
| `apps/db-ops-api/src/metrics/triggers/episode.ts` | 新增 `TriggerEpisodeUnknownSegment`、记录的两个字段，以及 open episode 上的区段折叠 |
| `apps/db-ops-api/src/metrics/triggers/episode.test.ts` | 新增 6 个用例，全部由真实 B2C 解析 → 快照 → 纯判定结果驱动 |
| `apps/db-ops-api/src/metrics/triggers/journal.ts` | 记录 schema 接受两个新字段；未知区段按严格对象校验（含 `reason` 的既有枚举） |
| `apps/db-ops-api/src/metrics/triggers/journal.test.ts` | 新增 3 个用例：带区段的读回、缺字段拒绝、区段多余字段拒绝 |
| `docs/slide/development/MAX-239/unknown-segment.md` | 本说明 |

## 2. 记录字段

```ts
unknown_segments: Array<{ from: string; to: string | null; reason: TriggerEvaluationReason }>
unknown_open_from: string | null
```

- `reason` 复用既有的 `TriggerEvaluationReason`，没有新造字符串。
- `unknown_open_from` 是当前仍开放的那段第一次未知证据的 `evaluated_at`，否则 `null`。
- 一段的 `from` 和 `reason` 取**第一次**未知证据；连续的未知判定不会新开一段，也不会改写这段的起点或原因。
- 一段在下一次 `quality !== 'unknown'` 的判定处关闭，`to` 用这次新证据的时间；problem 保持和 recovery 都会关闭它。关闭后区段留在记录上。

### 开放段的表示（本包的解释，供复审）

记录按派工只增加两个字段。要满足「连续多次未知只保留第一次的 reason」，第一次未知的 `reason` 必须随记录一起保存，而 `unknown_open_from` 只承载时间。因此实现把**仍开放的那一段放在 `unknown_segments` 末尾**，`to` 为 `null`，并由 `unknown_open_from` 同步给出它的 `from`；关闭时补上 `to`。

这样 `unknown_segments` 在记录开放期间可能以 `to: null` 结尾，严格意义上的「已经结束的未知区段」只在关闭之后成立。这是两个字段约束下的取舍，没有新增第三个字段，也没有把开放段写成看似结束的区间。

## 3. 行为

| 上一条记录 | 判定 | 下一条 |
|---|---|---|
| 无 | 未知 / nodata | `null`，不建 episode，也不建区段 |
| 无 | problem | 新 episode，`unknown_segments: []`、`unknown_open_from: null`（打开本身不写成未知区段） |
| open | `quality === 'unknown'` 且当前无开放段 | 同 episode，追加 `{from: 本次时间, to: null, reason: 本次原因}`，`unknown_open_from` 写本次时间 |
| open | `quality === 'unknown'` 且已有开放段 | 同 episode，保持第一次的 `from` 和 `reason`；后续未知原因只进 `last` |
| open | `quality !== 'unknown'`（problem 保持 / healthy / recovery） | 关闭开放段：补 `to = 本次时间`，`unknown_open_from: null`；recovery 同时按规定关闭 episode |
| open | recovery（`quality` 不再是 unknown） | 同 id、`closed`、`closed_at` 写入、`recovery_count: 1`，区段保留在记录上 |
| closed | 再次 recovery / 未知 / healthy | 原记录不变；closed 上的未知证据不新增区段 |
| closed | 新的确定 problem | 新 id，`occurrence + 1`，`unknown_segments: []`、`unknown_open_from: null`，旧区段不复制 |
| — | 更早的判定（水位线） | 返回原记录对象，不增加区段，也不改 `unknown_open_from` |
| — | `rule_not_found` | 该身份记录原样返回 |

- 没有 ack 入参。区段是 episode 历史，不记录通知、不抑制通知、不追补通知。
- 水位线比较、身份哈希、`episode_id` 推导、occurrence 规则、scope 和序列报告都没有改。

## 4. 日记

- 新字段是记录的一部分，按 `TriggerEpisodeRecordSchema` 严格校验。
- 缺 `unknown_segments` 或缺 `unknown_open_from` → `TRIGGER_EPISODE_JOURNAL_RECORD`：不当成空日记从 `occurrence:0` 另开，也不覆盖原文件。
- 记录级和区段级都拒绝多余字段；区段的 `reason` 必须是既有枚举值。
- 同一目录的新实例读回已关闭记录时，区段、episode id、occurrence 和 `recovery_count: 1` 一起回来。

## 5. 验证（本 SHA）

在 `apps/db-ops-api` 下，复用主检出已安装依赖（软链，未 `pnpm install`，未改其他 worktree）：

```
./node_modules/.bin/vitest run src/metrics/triggers src/contracts/metrics --maxWorkers=1   # 8 files / 137 tests passed
./node_modules/.bin/tsc --noEmit                                                          # exit 0
./node_modules/.bin/tsx src/contracts/generate-public-api.ts --check                      # exit 0（= contracts:check）
```

新增用例覆盖：

1. 没有未知证据的 episode（open / problem 保持 / closed）保持 `unknown_segments: []`、`unknown_open_from: null`。
2. problem → 未知 → 再未知 → 恢复：只有一段，`from` 和 `reason` 取第一次未知，`to` 是恢复判定的时间；关闭后区段仍在记录上。
3. 未知之后问题保持：段在 problem 保持的判定处关闭，episode 仍 open、id 不变。
4. 关闭后的新 problem：新 id、`occurrence:1`、空区段；旧记录区段不复制。
5. 更早的未知判定：返回原记录对象，不加段、不改 `unknown_open_from`。
6. 无上一条记录或 episode 已关闭时，未知与 nodata 都不建段。
7. 日记：带区段的已关闭记录由新实例读回，字段与 id / occurrence / `recovery_count` 一致；缺字段和区段多余字段都被拒绝且不覆盖原文件。

未重跑 238 MySQL 与 manifest；单测不冒充持久化、事件、通知或 UI。

## 6. 反例（不能写成已通过）

- 这**不是**「通知重试不重发已通过」：本包没有 outbox、没有投递尝试记录，也不抑制或追补任何通知。
- 这**不是**「已部署进程重启已通过」：区段只存在 episode 记录上，未挂到运行时，也不是产品库。
- 这**不是** MAX-240 的历史曲线：区段不画图、不查询、不落历史表。

## 7. 仍然开放（不属于本包）

1. 把 episode 记录与区段挂到运行时调用链。
2. 通知重试不重发（需要已获准的持久化投递存储）。
3. 与 binding `applied` 同事务的写入围栏。
4. 唯一事件 writer / outbox / 回执。
5. 触发器 UI 与事件中心展示。
6. 三类真实资源的触发/恢复与正式通知回执。
