# MAX-239 / EPISODE-TRANSITION — 内部交付说明

范围：在原 `TEMPLATE-TRIGGER-SNAPSHOT` 之后追加的**纯 episode 状态迁移**。
输入是已接受的触发快照身份、该身份的上一条 episode 记录（可为空）和一条 `evaluateTriggerRule` 结果，输出下一条 episode 记录。
本包**未挂载**：不改 `evaluate.ts`、不改 238 codec、不改 alerts writer / `server-alert-evaluator`、不改 MAX-240；不新增路由、公开导出、DB/迁移、3306 写、事件 writer、outbox、worker、通知或 `eval`。整单 MAX-239 仍为 `in_progress`。

## 1. 文件

| 文件 | 作用 |
|---|---|
| `apps/db-ops-api/src/metrics/triggers/episode.ts` | `TriggerEpisodeIdentitySchema`、`TriggerEpisodeRecord`、`nextTriggerEpisode`、身份/幂等 id 推导 |
| `apps/db-ops-api/src/metrics/triggers/episode.test.ts` | 6 个用例，全部用真实 B2C 解析 → 快照 → 纯判定结果驱动 |

该模块不在 `contracts/metrics/index.ts`、`public-api.ts` 或任何运行时消费链中被导出/引用。

## 2. 身份与 id

- 身份即契约给定的四项：`resource`、`rule_id`/`version`、`body_hash`、`scope`。
- `identity_hash = hash({kind:'trigger_episode_identity', …四项})`，复用既有 `model.ts` 的 canonical `hashOf`。
- `episode_id = hash({kind:'trigger_episode', identity_hash, occurrence})`，`occurrence` 从 0 开始，只在已关闭 episode 之后出现新的确定 problem 时加一。
- id 由记录确定性推导，不含随机数或进程内计数器：同一输入重复执行、进程重启后重建都得到同一 id。

## 3. 迁移规则

| 上一条记录 | 判定结果 | 下一条 |
|---|---|---|
| 无 | `business:'problem'` | 新 episode，`occurrence:0` |
| 无 | healthy / unknown / nodata / 单独 recovery | `null`（不建 episode） |
| open | problem（含 `problem_retained`） | 同 id、仍 open、`last` 更新 |
| open | unknown / nodata / stale / 缺测 / 低质量 / 未 applied | 同 id、仍 open、**不关闭** |
| open | `recovery:true` | 同 id、`closed`、`closed_at` 写入、`recovery_count:1` |
| closed | 再次 recovery | 原记录不变（不新开、不第二次关闭） |
| closed | healthy / unknown | 原记录不变 |
| closed | 新的确定 problem | 新 id，`occurrence + 1`，`recovery_count:0` |
| 其它身份的记录 | 任意 | 视为无上一条记录；旧身份记录不被关闭或改写 |
| — | `rule_not_found` | 该身份记录原样返回，不迁移 |

- 只有 recovery 关闭 open episode；`business:'healthy'` 但无 recovery 证据不关闭。
- 快照身份不同（规则体 90 → 95，`body_hash` 不同）不共用 id；新身份从 `occurrence:0` 开始，旧问题是旧身份的历史，不并入新 id。
- 输入没有 acknowledgement 字段；记录也不带确认状态，确认不能关闭或阻止关闭。

## 4. 验证（本 SHA）

在 `apps/db-ops-api` 下，复用已安装依赖（软链，未 `pnpm install`，未改其他 worktree）：

```
./node_modules/.bin/vitest run src/metrics/triggers src/contracts/metrics --maxWorkers=1   # 6 files / 106 tests passed
./node_modules/.bin/tsc --noEmit                                                          # exit 0
./node_modules/.bin/tsx src/contracts/generate-public-api.ts --check                      # exit 0（= contracts:check）
```

未重跑 238 MySQL 与 manifest；单测不冒充持久化、事件、通知或 UI。

## 5. 挂载缺口（不属于本包）

1. episode 记录持久化与按身份读取上一条记录。
2. 与 binding `applied` 同事务的写入围栏；本包只消费判定结果。
3. 唯一事件 writer / outbox / 回执 / 通知；本包不写事件。
4. 身份被新快照取代后旧 open episode 的关闭策略（归档/迁移），本包只保证不共用 id、不改写历史。
5. 模板触发器 UI 与事件中心展示。
