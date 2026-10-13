# T05-B 消息观察、证据与版本化结果验收

2026-10-13，MAX-147。基线 `3269f2062611ce17fe0a6a4623120993492c2901`（T04 #154）；复用已合并 T05-A #153。本文仅描述完整 T05 的实现与证据边界，不代替父独立 Review 或 T12 全 V1 A01–A18 gate。

## 实现与兼容

- 117 additive 迁移由正式 MigrationRunner 自动发现，新增事件/head、capture hash、证据和结果存储。Session→Investigation 锁序与实时授权复用既有实现；sequence、canonical Parts revision、工具证据同事务提交，失败不推进 checkpoint/cursor。
- watch/unwatch 只观察，不取得执行所有权。快照含 watermark，随后从该水位重放持久事件；跨进程观察使用 SQL，轮询逐次执行全部资源 live ACL，发送前再授权，撤权关闭流。异步重新认证不能复活旧 watch 或令旧 unwatch 删除新 watch；每连接最多 8 个调查。断线不取消 Run。
- 无效/过期游标返回 `replay_required`；事件仅允许删除至少 90 日的连续过期前缀，source hash 保留以防重启重新捕获。事件 pruning 是受限显式维护接口；原始证据另有自动清理，不把两种保留策略混为一谈。
- 投影复用 canonical turn/ordinal 与 Message Parts/Projection。快照最近 200 条 canonical 文档，并将文档窗口缩至约 48 KiB（单条文档下限）；`truncated` 明示截断。完整历史从 `/facts` 第一页开始按 `nextBefore` 翻页，snapshot 的 `nextBefore` 是 canonical 200 条页的历史边界，字节窗口内省略的文档应从 `/facts` 第一页读取。hash 对脱敏 display documents 按 ID 排序计算。
- 展示移除 reasoning，工具 payload 用已有有界预览；不输出无约束推理。Evidence 入库前脱敏 SQL 字面量和秘密字段，明确观察窗口与首次 SQL collectedAt；未知观察窗口为 null，不推测时间。
- raw 7 日到期后返回 tombstone，明确请求 raw 时 HTTP 410；即时读取清除到期 raw，服务器每 60 秒最多清理 200 条。metadata/hash/原调查-request-Run 绑定保留，关闭服务器等待正在执行的维护。
- 结果 `schemaVersion=2`，支持/反面证据严格绑定本调查、原 request/Run，实时检查资源权限；版本与幂等冲突原子处理。机器不能写 human/experimental verification、recoveryVerification 或 resolved；bound 仅为引用关联，confidence 不显示为准确率。
- 终态 Run 自动生成保守执行摘要，根因为 unverified、业务问题为 unconfirmed。未持久化模型/提示词版本标为 `unavailable`；不补造 provenance。原 agent_runs 六种状态不变，partial 的未知收据映射 `outcome_unknown`；queued 属 job，并按当前 active request 派生。
- v1 AnalysisEnvelope 及 legacy reader 保留只读行为；新增 HTTP/WS 类型走既有 contracts 生成管线。普通 Chat read share 不能观察调查或 append；viewer 可读但不能调用事实写入口。

## 实际验收矩阵

| 场景 | 证据与结果 |
| --- | --- |
| snapshot/订阅间隙、重复/乱序/reconnect | 真实隔离 MySQL：gap 插入后重放、同 checkpoint 游标不增、重建服务 hash 一致；纯 reducer 拒绝缺口 |
| canonical 事实事务与恢复 | 真实 SQL rollback 后 Parts/证据/游标不推进；partial→completed 去重；T05-A 冲突回归 |
| JWT/HTTP/实际 WS | 正式 ActorContextService、JWT、DirectAdapter socket；unwatch 后不再发送、重新连接 hash 一致、撤权关闭流且 Run 保持 running |
| live ACL | 无新事件也检查 membership/disablement/Profile/全部资源；构建快照后撤权不发送；隐藏证据引用抑制整个结果页 |
| Evidence | 存在的跨调查 Evidence/Run 拒绝，SQL/秘密脱敏，observed window 校验，raw 到期 410/metadata tombstone，维护不删除绑定/hash |
| 版本/unknown/反证 | SQL 并发幂等与原子版本、错误 expectedVersion 拒绝、支持/反面引用原执行绑定、unknown 不升级验证、v1 兼容 |
| 后台链路 | 受控本地 Provider→调查 executor→只读工具 fixture→canonical→证据→V2；恢复后不重复创建版本 |
| 旧 Chat/Run/Parts | 相关模块、权限 gate 与 T04 Chromium 浏览器关闭/退出、OS crash unknown 零重放场景复用运行 |
| 新请求排队 | 真实 MySQL/HTTP：上一轮 completed、新 active request 尚未创建 Run 时显示 queued |

上述工具目标为合成 fixture，Provider 为本地受控实现。没有新增外部模型调用，没有真实目标数据库/设备运维验收；T04 历史真实模型证据仍以其独立交付为准，不计作本次新增验证。

## 命令与结果

真实模块运行（8 文件、221 passed、0 skipped；后续路由新增回归单独 36 passed，存在重叠，不相加）：

```bash
AGENT_RUN_TEST_MYSQL_PORT=62360 AGENT_RUN_TEST_MYSQL_PASSWORD='' \
AUTH_TEST_MYSQL_PORT=62360 AUTH_TEST_MYSQL_PASSWORD='' T04_BROWSER_TEST=1 \
JWT_SECRET_KEY=t05-isolated-fixture-jwt-key-not-for-production-use \
pnpm --filter slide-api exec vitest run \
  src/investigations/observation.mysql.test.ts src/investigations/routes.test.ts \
  src/adapter/__tests__/investigation-canonical.mysql.test.ts \
  src/investigations/execution-recovery.mysql.test.ts \
  src/investigations/stream.test.ts src/investigations/evidence-store.test.ts \
  src/investigations/result-schema.test.ts src/analysis/analysis-evidence-binding.test.ts
```

- Parts/DisplayStream/Analysis/公开契约相关 9 文件 112 passed、0 skipped。其后新增 late append 测试已被上面的 221 模块运行覆盖。
- 最新 `pnpm security:agent`：17 文件 187 passed、0 skipped，覆盖最终 WS strict validation/intent 限制/异步 unwatch 改动。
- 干净 PR 候选：API typecheck、contracts:check、qualification:matrix、前端 typecheck/build、security:scan 通过；lint 261 条 warning、0 error，前端 build 保留既有 chunk 提示。托管工作树先前 contracts:generate 与 diff check 也通过。
- 干净 PR 候选 backend 全量：338 文件通过、40 文件跳过；3288 passed、578 skipped、0 failed。agent-core 全量 33 文件/675 passed，前端全量 93 文件/757 passed。测试集合有重叠，不合计用作独立验收数量。
- 托管工作树第一次 backend 全量：3287 passed、576 skipped、1 failed；唯一失败为 docs structure 看到了托管起始快照自带 `docs/reviews`，该资料不在 main，原用户资料保留，不删除、不更改断言。干净候选已通过该断言及全量回归。
- 普通 backend 全量未开启所有历史 SQL 环境，其 skip 不用于替代本任务的真实 SQL/JWT/WS/浏览器验收。本任务必需模块已显式开启且 0 skip；最终 CI 现有 browser-qualification 也执行该模块。

测试 MySQL 为短生命周期、只绑定 loopback 的独立 mysql:8.4 容器，各套使用随机隔离 schema 与正式迁移，afterAll 删除 schema；无生产数据迁移。交付时停止本任务夹具，不停止其他服务。

## FINAL-0084 消费裁定与交付门禁

既有 DisplayStream 已拒绝终态后帧；T05 reducer 的 end 后 late append 可以推进外层游标但不会修改 displayed Parts，新增测试已验证。未改共享 Review 矩阵、message-parts 或 generic Chat 事实算法。只进行了本 owner 对触达调用链的有界自查；这不能称为父独立 Review。

独立 MAX-147 PR 在准确 head CI 与父独立 Review 齐备前保持待验收，不自动释放下一阶段。T12 全 V1 gate 尚未完成。无子代理、新 Issue、生产操作、外部模型新增调用；任务 token/费用遥测不可用，未编造统计或将内部上下文计数作为实测。
