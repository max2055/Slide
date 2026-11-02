# MAX-239 / EPISODE-JOURNAL — 内部交付说明

范围：在已接受的 `TEMPLATE-TRIGGER-SNAPSHOT`、`EPISODE-TRANSITION`、`EPISODE-CATALOG` 之后追加的**文件日记**。
`TriggerEpisodeCatalog`（`e52978b2b`）只在同一进程的内存映射里读上一条；本包补上调用方指定的独占目录这条读回路径：把同一身份的最新记录写进该目录，再用这个目录构造新的目录实例读回已关闭记录。**不重做、不改动纯转移与内存目录的语义。**

本包**未挂载**：日记没有接到任何运行时链路，不是产品库，不写 3306，不新增路由、公开导出、DB/迁移、事件 writer、outbox、worker、通知、ack 或 `eval`；不改 238 codec、alerts writer、`server-alert-evaluator`、MAX-240 的查询/存储/frontend。整单 MAX-239 仍为 `in_progress`。

## 1. 文件

| 文件 | 作用 |
|---|---|
| `apps/db-ops-api/src/metrics/triggers/journal.ts` | 存储端口 `TriggerEpisodeStore`、默认内存实现 `InMemoryTriggerEpisodeStore`、文件日记 `TriggerEpisodeJournal` 与 `TriggerEpisodeJournalError` |
| `apps/db-ops-api/src/metrics/triggers/journal.test.ts` | 10 个用例，全部由真实 B2C 解析 → 快照 → 纯判定结果驱动，目录用 `mkdtemp` 创建并在结束时删除 |
| `apps/db-ops-api/src/metrics/triggers/catalog.ts` | 只改两处：构造函数注入存储端口（默认内存实现），`apply` 在记录变化后调用 `store.write` |
| `docs/slide/development/MAX-239/episode-journal.md` | 本说明 |

该模块不在 `contracts/metrics/index.ts`、`public-api.ts` 或任何运行时消费链中被导出/引用。

## 2. 存储端口

```ts
interface TriggerEpisodeStore {
  read(identityHash: HashId): TriggerEpisodeRecord | null;
  write(record: TriggerEpisodeRecord): void;
  readonly size: number;
}
```

- 按身份哈希读写**一条** `TriggerEpisodeRecord`；写入用记录自带的 `identity_hash` 作键。
- 默认实现仍是内存 `Map`，既有 7 个 catalog 行为不变，既有 catalog 测试不碰文件系统。
- `catalog.apply` 的写回条件不变：纯函数返回 `null` 不写；返回与上一条**同一个记录**（关闭后的恢复重放、关闭后的 unknown、`rule_not_found`）也不写。

## 3. 文件日记

- 调用方传入**独占目录**；日记只在那里工作，不创建目录，不写到别处。
- 目录里只有一个文件 `episodes.json`，内容是 `format` / `version` / `records` 三段，`records` 以身份哈希为键、一份身份一条“最新记录”。
- 写入先落到**同目录**的临时文件，再 `rename` 覆盖正式文件。中断的写入因此留下的是上一版完整文件，而不是可能被当成空日记的半截文件；`rename` 失败时临时文件会被删除，目录仍只剩一个文件。
- 不做 fsync，也不声明崩溃持久性：本包只保证“同一目录内的读回”，不保证掉电语义。

## 4. 读回行为

| 场景 | 日记表现 |
|---|---|
| 新实例从同一目录读回已关闭记录 | episode id、occurrence、`recovery_count: 1` 与写入时相同 |
| 重放同一次 recovery | 不新开、不第二次关闭；文件内容不变 |
| 其后同一身份的确定 problem | 新 episode id，`occurrence + 1`，`recovery_count: 0` |
| 文件不存在 | 按空日记处理：新 problem 从 `occurrence: 0` 起算（见 §5 反例） |
| 文件损坏 / 半截 JSON / 信封不对 | `TriggerEpisodeJournalError('TRIGGER_EPISODE_JOURNAL_UNREADABLE')`，不当成空日记 |
| 文件里出现记录类型没有的字段（含 ack 字段） | `TriggerEpisodeJournalError('TRIGGER_EPISODE_JOURNAL_RECORD')` |
| 记录挂在别人的身份哈希下 | `TriggerEpisodeJournalError('TRIGGER_EPISODE_JOURNAL_IDENTITY')` |
| 另一身份（含同一资源的另一个 body hash） | 互不可见；不改写、不关闭对方仍 open 的记录 |
| 目录不存在 | 原样抛 `ENOENT`：调用方没给目录是调用方错误，不能读成“该身份没有 episode” |

错误是**拒绝读回**，不是自愈：读失败时不写、不覆盖损坏文件、也不从 occurrence 0 另开一条。没有 ack 入参，记录里没有确认状态，也不记录任何通知尝试。

校验是整体的：任何一次读取都会校验整个文件里的每条记录，因此一条坏记录不会只在被读到的那一刻才暴露。

## 5. 空日记反例（不是重启验收）

文件不存在时按空日记处理，新 problem 从 `occurrence: 0` 起算——这与内存目录在进程重启后的表现相同。测试把这条单列成反例。

因此：

- 本包**不能**声称“生产重启已通过”或“已部署进程重启已通过”。新实例读回同一目录只证明**包内读回**：同一身份、同一目录、另一个目录实例。
- 让日记真正跨越进程边界（挂到运行时、由运行中的服务写入和读回、部署后重启验证）不在本包范围。

## 6. 验证（本 SHA）

在 `apps/db-ops-api` 下，复用主检出的已安装依赖（`node_modules` 软链，未 `pnpm install`，未改其它 worktree）：

```
./node_modules/.bin/vitest run src/metrics/triggers/journal.test.ts --maxWorkers=1          # 1 file / 10 tests passed
./node_modules/.bin/vitest run src/metrics/triggers src/contracts/metrics --maxWorkers=1     # 8 files / 123 tests passed
./node_modules/.bin/tsc --noEmit                                                             # exit 0
./node_modules/.bin/tsx src/contracts/generate-public-api.ts --check                         # exit 0（= contracts:check）
```

未重跑 238 MySQL 与 manifest；单测不冒充运行时挂载、事件、通知或 UI。

## 7. 仍开放的挂载缺口（不属于本包）

1. 把日记挂到运行时：由真实评估链路写入与读回；本包不做挂载。
2. 与 binding `applied` 同事务的写入围栏。
3. 唯一事件 writer / outbox / 回执 / 通知；通知重试不重发仍未实现。
4. 身份被新快照取代后旧 open episode 的关闭策略。
5. 模板触发器 UI 与事件中心展示；MAX-240 侧的查询、存储和 frontend 未改。
6. 三类真实资源（SSH/SQL/SNMP 语义）的触发/恢复、正式通知真实到达与回执核对：未做。
