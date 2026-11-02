# MAX-239 / EPISODE-CATALOG — 内部交付说明

范围：在已接受的 `TEMPLATE-TRIGGER-SNAPSHOT`、`EPISODE-TRANSITION` 之后追加的**调用侧目录**。
`nextTriggerEpisode`（`2bebac247`）本身要求调用方带上同一身份的上一条记录；本包补上这个调用侧：按快照身份读取上一条、调用已接受的纯函数、写回该身份的最新记录。**不重做、不改动纯转移的语义。**

本包**未挂载**：目录只是进程内内存映射，不是已发布生产者，也不是持久化存储。不新增路由、公开导出、DB/迁移、3306 写、事件 writer、outbox、worker、通知或 `eval`；不改 238 codec、alerts writer、`server-alert-evaluator`、MAX-240 的查询/存储/frontend。整单 MAX-239 仍为 `in_progress`。

## 1. 文件

| 文件 | 作用 |
|---|---|
| `apps/db-ops-api/src/metrics/triggers/catalog.ts` | `TriggerEpisodeCatalog`：按身份读上一条、调用 `nextTriggerEpisode`、写回该身份最新记录 |
| `apps/db-ops-api/src/metrics/triggers/catalog.test.ts` | 7 个用例，全部用真实 B2C 解析 → 快照 → 纯判定结果驱动 |
| `docs/slide/development/MAX-239/episode-catalog.md` | 本说明 |

该模块不在 `contracts/metrics/index.ts`、`public-api.ts` 或任何运行时消费链中被导出/引用。

## 2. 目录语义

- 键是**完整快照身份**经 `triggerEpisodeIdentityHash` 得到的哈希：`resource`、`rule_id`/`version`、`body_hash`、`scope` 五项全参与；每个身份只保存一条“最新记录”（上一条）。
- `get(identity)` 只按该身份读取上一条；identity、scope、resource 不同的查询互不可见。
- `apply(identity, evaluation)` = 读取 → `nextTriggerEpisode({identity, previous, evaluation})` → 写回。没有其它步骤。
- 不推导判定输入：`previous: 'problem'` 等输入仍由上游调用方提供；目录只负责记录本身。
- 没有 acknowledgement 入参，记录也不带确认状态；确认既不能关闭，也不能阻止关闭。
- `apply` 返回纯函数的结果：`null` 表示判定没有产生记录，此时目录**内容不变**；返回原记录（关闭后的恢复重放、关闭后的 unknown、`rule_not_found`）时不做重写。

## 3. 行为（与纯转移一致，由目录保证读回后仍成立）

| 场景 | 目录表现 |
|---|---|
| 同一身份重复 problem | 读回上一条，episode id 不变 |
| 同一身份的 unknown / nodata / 过期 / 缺测 / 低质量 / 未 applied | 读回上一条，仍 open，不关闭 |
| recovery | 关闭一次，`recovery_count:1` |
| 再放一次同一恢复结果 | 读回关闭记录，不新开、不第二次关闭，目录不变 |
| 关闭记录读回后出现新的确定 problem | 新 id，`occurrence + 1`，`recovery_count:0` |
| body hash 不同（90 与 95） | 两条独立记录；新身份不改写、不关闭旧身份上仍 open 的记录 |
| 纯函数返回 `null` | 不写入，目录内容与大小不变 |

## 4. 空目录与进程重启（反例，不是验收通过）

内存目录在进程内有效；进程重启后就是一个空目录。测试把空目录单列成反例：空目录上的 problem 从事先的 `occurrence: 0` 起算，并**得到与第一次 occurrence 0 相同的推导 id**——因为 id 只由身份与 occurrence 推导，而空目录没有可读回的关闭记录。

因此：

- 本包**不能**声称“进程重启已通过”或“重复评估/重启只有一个 episode”。验收要求中的重启语义需要持久化目录读回才能成立。
- 内存目录只是为后续持久化包固定调用侧契约（读上一条 → 调纯函数 → 写回最新记录），不是已发布生产者。

## 5. 验证（本 SHA）

在 `apps/db-ops-api` 下，复用主检出的已安装依赖（`node_modules` 软链，未 `pnpm install`，未改其它 worktree）：

```
./node_modules/.bin/vitest run src/metrics/triggers/catalog.test.ts --maxWorkers=1   # 1 file / 7 tests passed
./node_modules/.bin/vitest run src/metrics/triggers src/contracts/metrics --maxWorkers=1  # 7 files / 113 tests passed
./node_modules/.bin/tsc --noEmit                                                     # exit 0
./node_modules/.bin/tsx src/contracts/generate-public-api.ts --check                 # exit 0（= contracts:check）
```

未重跑 238 MySQL 与 manifest；单测不冒充持久化、事件、通知或 UI。

## 6. 仍开放的挂载缺口（不属于本包）

1. 目录持久化：把内存映射换成可按身份读写的事务存储；本包不写 DB。
2. 与 binding `applied` 同事务的写入围栏。
3. 唯一事件 writer / outbox / 回执 / 通知；通知重试不重发仍未实现。
4. 身份被新快照取代后旧 open episode 的关闭策略。
5. 模板触发器 UI 与事件中心展示；MAX-240 侧的查询、存储和 frontend 未改。
6. 三类真实资源（SSH/SQL/SNMP 语义）的触发/恢复、正式通知真实到达与回执核对：未做。
