# MAX238-COLLECTION-DISPLAY-E2E-R4：trial 读取到 receipt 持久化的完整授权收口

2026-10-30。**一句话结论**：公开 trial 的 receipt 持久化现在本身就是授权边界——在 admission 队列、连接获取、INSERT 行锁等待之后，都会在写入事务持有的同一连接上重读实时会话与资源边界；撤权/吊销/收窄发生在任一等待之后时，INSERT 被回滚，不产生任何 receipt，也不会“先 autocommit 写入再返回 403”。re-pin 发布事务在 commit 前补上同样的边界。R1 的真实采集展示链与 R2/R3 的请求前围栏、原子 re-pin **原样保留、未重跑、未新增生产采集**。整单仍为 **in_progress**，本包不是 MAX238 完成。

机器证据：[collection-display-e2e-r4-20261030.json](collection-display-e2e-r4-20261030.json)。

## 1. 原反例与修正

R3 复审的受控反例：真实 Fastify handler + 真实 trial service + 真实 receipt writer，在 writer 等待连接时撤权，仍得到 `{status:200,inserts:1}`。原因：最后一次 `authorize` 在 issuer **之前**；writer 为 autocommit，admission/连接/INSERT 行锁等待都没有调用者授权边界。

本包的修正（`apps/db-ops-api/src/metrics/bindings/trial-receipt-writer.ts`）：

| 等待点 | 修正后的检查 | 检查位置 |
|---|---|---|
| admission 队列 | `authorize()`（未持有连接） | 进入队列之后、取连接之前 |
| pool 连接获取 | `authorize(connection)` | `getConnection()` 返回后、INSERT 之前 |
| INSERT 行锁等待 | `authorize(connection)` | INSERT 返回后、COMMIT 之前 |
| 重复键后的读等待 | `authorize(connection)` | replay/collision 结论返回之前 |

writer 现在只用一个连接、一个短事务：`SET TRANSACTION ISOLATION LEVEL READ COMMITTED` → `BEGIN` → 授权 → `INSERT` → 授权 → `COMMIT`；任何拒绝走 `ROLLBACK`。授权错误（401/403/503）原样向上传递，不被改写成 writer 错误码；SQL/凭据不进响应。提交结果无法确认时返回稳定的 `TRIAL_RECEIPT_STORE_UNAVAILABLE` 并丢弃连接，不把未知结果当成功或 absent。离线/fixture 调用不传 `authorize` 时行为保持兼容；公开调用始终传入，且 `reload` 缺失时仍失败关闭（503）。

**为什么用 READ COMMITTED**：授权重读必须在事务内看到“等待期间已提交”的撤权。REPEATABLE READ 的普通 SELECT 会用事务开始时的快照，看不到；`FOR SHARE` 虽能看到最新提交，却会把授权表上的共享锁持有到 commit，撤权 UPDATE 会被阻塞到本事务结束（实测会与行锁等待形成互等）。因此持久化事务设为 READ COMMITTED，重读为普通当前读——撤权可以在 INSERT 等待期间提交，随后被重读发现并回滚。

为避免“持有连接时再从同一池取连接导致池耗尽”，writer 与 re-pin 事务把连接传给授权回调：`reloadOn`（新）在已持有的连接上执行 `ActorContextService.revalidateActorOn`（新），资源存在性走 `MysqlResourceRelationStore.existsOn`（新）。`async` 离线路径仍用既有 `reload`/`exists`。

re-pin：`TemplatePublication.transaction(run, beforeCommit)` 在最后一个写之后、`COMMIT` 之前执行同一授权；`binding-service.ts` 把连接传入。R3 已接受的“每个写入前重读 + 单事务回滚”保持不变。

## 2. 红→绿

新增/收紧的测试先在 R3 生产代码（`d494394b0` 的 5 个生产文件）上运行，再恢复本包实现运行：

| 套件 | R3 代码 | 本包实现 |
|---|---|---|
| `trial-receipt-issuer.test.ts` + `binding-service.test.ts` | **11 failed / 27 passed** | **38 passed** |
| `trial-receipt-persistence.mysql.test.ts`（真实 MySQL） | **3 failed / 1 passed** | **4 passed** |
| `repin-authorization.mysql.test.ts`（含新的 pre-commit 用例） | —（新增用例） | **4 passed** |

失败原因是真实的执行反例：R3 writer 不调用授权（连接等待/行锁等待后仍 200 且写入 1 行），也不开事务；fixture 对 autocommit 与事务两种行为都建模，不靠“插入必须处于事务中”这种夹具断言制造失败。

## 3. 真实 handler 链路（受控 issuer/actor/pool 等待）

`binding-service.test.ts` 新增 R4 用例，运行真实 Fastify `inject` → `registerMetricTemplateRoutes` → 真实 `TemplateBindingService` → 真实 `writeTrialReceipt`；仅控制 issuer 输出、actor 源和池等待：

- 撤权发生在 **issuer 读取期间** → 403、无 INSERT、无 receipt；
- 撤权发生在 **writer 等待连接期间** → 403、`ROLLBACK`、无 INSERT；
- 撤权发生在 **INSERT 行锁等待期间** → 403、INSERT 之后 `ROLLBACK`、提交行数 0；
- 会话吊销发生在 INSERT 等待 → **401**（`ActorAuthenticationError` 原样传递）；
- 成功路径 → 200、恰 1 行、1 次 COMMIT；相同请求 replay → 200 且仍 1 行；同 id 不同 payload → **409** `TEMPLATE_BINDING_RECEIPT_INVALID`，原行不变；
- `reloadOn` 在事务内的两次检查都收到 writer 持有的连接（没有另取连接）。

这是受控 actor/池等待，不是生产撤权演练；fixture 事务也不是真实 MySQL 回滚的证明。

## 4. 真实 MySQL（一次性，非 3306）

容器：`max238r4-02a374b4f46a7efb`，ID `823f98023e1c8610bb0326fd2c724297ba7e8cd660ab19277c5546dbe12372fc`，nonce `02a374b4f46a7efb`，`127.0.0.1:13342 → 3306`，镜像 `mysql:8.4`（8.4.10）。空库跑完整 migration，真实 `users`/`database_instances` 行，真实 `ActorContextService.revalidateActorOn` 与真实 writer/事务/主键。

1. **行锁等待期间撤权**：另一连接对不存在的 `PRIMARY KEY` 执行 `SELECT … FOR UPDATE` 持锁；writer 的 INSERT 实测阻塞（50ms 标记仍 pending），期间把 `users.session_version` 3→4 并提交，再释放锁 → **`ActorAuthenticationError`**，回读 `COUNT(*) = 0`；随后以当前会话重试 → `inserted`、1 行（证明回滚干净、不影响后续幂等）。
2. **同一行锁路径正常成功**：锁住但不撤权 → 阻塞后 `inserted`、1 行。
3. **INSERT 之后拒绝**：受控授权在第 3 次检查拒绝 → 真实回读 0 行（事务回滚）。
4. **主键幂等**：真实 `INSERT` → `inserted`；再次相同 payload → `replay`；同 id 不同 `expires_at` → `collision`；回读仍 1 行且 payload 为首次值。

清理：`docker rm -f` 返回容器名；清理后对两个精确容器名（含首次因 MySQL 8.4 移除 `--default-authentication-plugin` 而退出的 `max238r4-d72daeb41d6a2fed`）执行 `docker inspect` 均为 `no such object`（exit 1）。首次容器在重启前按精确名称删除，当时未单独留 rm 回执，故这里只记录“清理后不可查询”的事实，不称其清理过程已验证。无共享 3306 写入、无前缀扫描、无按端口猜 owner。

## 5. 本次检查

| 检查 | 结果 |
|---|---|
| focused（4 套件，含真实 MySQL） | **46 passed** |
| `src/metrics src/contracts src/auth src/resources`（无 DB） | **90 files passed / 51 skipped；1275 passed / 223 skipped** |
| `src/metrics/templates src/metrics/bindings`（真实 MySQL） | **19 files passed / 1 skipped；405 passed / 22 skipped**（在最终错误包装前运行；之后 focused 46 全绿） |
| API `tsc --noEmit` | 通过 |
| 公开契约 `generate-public-api.ts --check` | exit 0 |
| 前端 typecheck/build | 未改前端，未运行 |

## 6. 边界与未执行

- 撤权/吊销/资源收窄是受控 actor 源或真实 `session_version` 变更，不是生产撤权演练；未声称分布式授权与 DB 提交绝对同时线性化——实际边界是“最后一次重读紧邻 COMMIT”，COMMIT 往返本身仍是残余窗口。
- 未启动生产 worker、未部署、未停写/复制/切换/回退/解绑；未碰共享 3306 业务数据；未用子代理/产品模型/MAX224 账本。
- R1 真实链、R2/R3 已接受部分、旧 R3/R5/REG/`c14b06a00` 复用，不重采成功链、不重跑未变全包。
- 仍属原范围且未完成：全指标 good、历史阈值、停用/解绑后历史授权、改名/版本身份、SLO/容量、服务器 3、24h、迁移演练、通知恢复与 AI 闭环。

## 7. PR

任务分支 `agent/15coder1/max-238`：实现 + 测试提交 `8f4312ec1`（父 `d494394b0`）。草稿 PR #567 从已安全发布头 `4b7d1a3a7` 追加一个干净提交，base `main`；未 watch/merge/deploy。
