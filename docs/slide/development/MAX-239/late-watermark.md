# MAX-239 / LATE-WATERMARK — 内部交付说明

范围：在已接受的 `EPISODE-JOURNAL` 之后，为**纯 episode 迁移**补上延迟/乱序样本的判定水位线。
输入仍是已接受的触发快照身份、该身份的上一条 episode 记录（可为空）和一条 `evaluateTriggerRule` 结果；本包只加一条比较：这次的 `evaluated_at` 是否早于记录里的 `last.at`。

本包**未挂载**：不改 `evaluate.ts`、不改 `catalog.ts` / `journal.ts`、不改 238 codec、alerts writer / `server-alert-evaluator`、不改 MAX-240；不新增路由、公开导出、DB/迁移、3306 写、事件 writer、outbox、worker、通知、ack 或 `eval`。整单 MAX-239 仍为 `in_progress`。

## 1. 文件

| 文件 | 作用 |
|---|---|
| `apps/db-ops-api/src/metrics/triggers/episode.ts` | 新增 `TRIGGER_EPISODE_TIME` 错误码与 `nextTriggerEpisode` 内的水位线比较 |
| `apps/db-ops-api/src/metrics/triggers/episode.test.ts` | 新增 5 个用例，全部由真实 B2C 解析 → 快照 → 纯判定结果驱动 |
| `docs/slide/development/MAX-239/late-watermark.md` | 本说明 |

## 2. 比较对象

- 左侧是已接受评估器写入的 `evaluation.evaluated_at`（来自输入 `now`）。
- 右侧是**本身份自己**记录里的 `last.at`，即上一次被接受的证据时间。
- 记录的身份哈希与本次身份不同时，水位线不适用：另一身份的记录仍按原规则忽略，不关闭、不改写，也不参与比较。
- 没有上一条记录时没有水位线：仍按原规则从 `occurrence:0` 打开，或返回 `null`。

## 3. 行为

| 时间关系 | 结果 |
|---|---|
| `evaluated_at` 严格早于 `last.at` | 返回**原来的那条记录对象**。open 不被这次 recovery 关闭、`recovery_count` 不变；closed 不被这次更早的 problem 打开下一次 occurrence；`last` 不往回拨 |
| `evaluated_at` 等于 `last.at` | 保持已接受的同刻重放：recovery 仍只关闭一次，重放已关闭的 recovery 仍是原记录，之后的确定 problem 仍换 id、`occurrence + 1` |
| `evaluated_at` 晚于 `last.at` | 保持已接受的转移，不做任何抑制 |
| 无上一条记录 | 不使用水位线 |
| `evaluated_at` 或 `last.at` 无法解析为时间 | 抛 `TRIGGER_EPISODE_TIME`，不写入、不从 `occurrence:0` 另开 |

- 旧窗口仍可以在上游算出自己的判定；本模块只是不让它改写存储中的当前记录。
- 返回的是同一个对象引用，所以 catalog 现有的 `next !== previous` 判定为假、不调用 `store.write`，文件日记的字节不变。
- 没有 ack 入参。本包不记录、不抑制、不追补任何通知；首期不追补历史通知。
- 水位线不改变 `evaluateTriggerRule`、身份哈希、`episode_id` 推导、occurrence 规则、scope 或序列报告。

## 4. 验证（本 SHA）

在 `apps/db-ops-api` 下，复用主检出已安装依赖（软链，未 `pnpm install`，未改其他 worktree）：

```
./node_modules/.bin/vitest run src/metrics/triggers src/contracts/metrics --maxWorkers=1   # 8 files / 128 tests passed
./node_modules/.bin/tsc --noEmit                                                          # exit 0
./node_modules/.bin/tsx src/contracts/generate-public-api.ts --check                      # exit 0（= contracts:check）
```

新增用例覆盖：

1. 更早的 recovery：判定本身是 `recovery:true`，返回的仍是原 open 记录，`recovery_count` 仍为 0。
2. 更早的 problem：判定本身是 `problem`，返回的仍是原 closed 记录，不开下一次 occurrence。
3. 更晚的 recovery 仍关闭一次；其后更晚的 problem 仍换 id、`occurrence + 1`。
4. `evaluated_at` 或记录的 `last.at` 不可解析时抛 `TRIGGER_EPISODE_TIME`；无上一条记录时不适用。
5. 另一身份的记录不作为水位线。

未重跑 238 MySQL 与 manifest；单测不冒充持久化、事件、通知或 UI。

## 5. 反例（不能写成已通过）

- 这**不是**「通知重试不重发已通过」：本包没有 outbox、没有投递尝试记录，也不抑制任何通知。
- 这**不是**「已部署进程重启已通过」：水位线未挂到运行时，episode 记录仍只在调用方内存或独占目录里。
- 这**不是**历史通知追补、不是产品库、不是 3306 写、不是 applied 同事务围栏。

## 6. 仍然开放（不属于本包）

1. 把水位线与 episode 记录挂到运行时调用链。
2. 通知重试不重发（需要已获准的持久化投递存储）。
3. 与 binding `applied` 同事务的写入围栏。
4. 唯一事件 writer / outbox / 回执。
5. 触发器 UI 与事件中心展示。
6. 三类真实资源的触发/恢复与正式通知回执。
