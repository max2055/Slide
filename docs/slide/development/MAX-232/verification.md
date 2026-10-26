# MAX-232：文件系统 ratio 阈值迁移指引修正（GitHub #256）

日期：2026-10-26。任务分支 `agent/15coder1/max-232`（`e73dc8be2` 之上合并当前 main
`0148688b5`），PR [#350](https://github.com/max2055/Slide/pull/350)。

## 本轮修复（Chief review：publication `68c04d956` 41 passed / 4 failed）

根因：PR 发布在**当前 main** 上，而 #226 已把 `ServerAlertEvaluator` 的恢复路径改成
`alertDatabaseService.findActiveServerAlerts()`（复数，按告警自身完整维度逐条恢复）。
任务分支旧的测试 fixture 只 mock 了单数 `findActiveServerAlert`，于是评估器在
`findActiveServerAlerts is not a function` 处抛错并被自身 `try/catch` 吞掉：

- 4 个状态链用例直接失败（预期 create/touch/resolve 都没有发生）；
- 更严重的是 **unknown 不写用例在异常路径下也会“通过”**——它只断言“没有写”，没证明评估真的完成。

本轮以当前 main 的依赖为准修正：

- 任务分支合并 `origin/main`（`0148688b5`），不再用任务分支里的旧评估器快照做验证。
- fixture 的 `findActiveServerAlerts` 返回**带完整维度**（mount/device/fs_type）的活跃告警行列表；
  恢复按每条告警自己的维度独立判定：一个挂载恢复只 resolve 它自己的行，其他 firing 挂载保持
  open 并 touch（不回退到 #226 之前的“全部挂载健康才恢复”聚合语义）。
- unknown 用例把真实 `evaluateOperationalRule` 包一层 spy 记录调用结果，断言至少发生一次恢复
  评估和一次语义评估、最后一次结果为 `{state:'unknown', value:null, recovery:false}`、
  `metricQuery` 已调用且 `console.error` 未被调用——证明走的是有效评估而不是异常退出。
- 变异校验：把 fixture 的复数方法删掉后，5/5 状态链用例全部失败（此前只有 4 个失败）。

同时按 Chief 授予的串行 SQL 授权补做了真实 MySQL 持久化验证（见验收 2）。

## 目标与范围

修正 #243 迁移指引中的单位错误：`linux.filesystem.used_ratio` 是 0–1 比率，80%/90%/95% 必须写成
0.80/0.90/0.95；库大小仍用 `By` 绝对字节阈值；保存时拒绝把旧百分比原值直接搬到新指标，
同时不影响其他无量纲指标。

排除项：

- 不重新执行 #243 的生产迁移，不改动已上线规则与旧规则 85/104 的审计记录。
- 不重启共享 MySQL、不使用平台数据库配置；SQL 验证只用一次性容器（迁移完成后删除）。
- 不改动 MAX-225 负责的 `alert-database-service` / `rca-investigation-bridge` /
  `event-aggregator` / `qualify-automatic-alert` 实现；本轮只读取其真实 SQL 行为。

关键假设：

- “预览/保存”分别指迁移 CLI 的 `plan`（预览）/ `disable|delete --apply`（保存），
  以及 `/api/alert-rules` 的 `POST`/`PUT` 保存接口；前者由 `validateReplacementDefinition`
  校验，后者由本轮新增的 `validateAlertThresholdUnits` 校验。
- 真实基线最高比率为 `/` 0.371783，0.79/0.81 只能在与真实挂载分母配对的 replay 中验证，
  不能表述为生产已发生的使用率事件。

## 改动

| 文件 | 内容 |
| --- | --- |
| `apps/db-ops-api/src/alerts/threshold-units.ts` | 比率校验只作用于 `linux.filesystem.used_ratio`；`unit=By` 要求整数绝对字节；移除全局宏限制 |
| `apps/db-ops-api/server.ts` | `POST/PUT /api/alert-rules` 保存前调用上述校验，返回 400 + `code`；PUT 仅在写入阈值相关字段时校验 |
| `apps/db-ops-api/src/metrics/alert-metric-catalog.ts` | 目录条目补充 `unit`（旧注册表与语义指标都返回） |
| `apps/db-ops-api/src/alerts/threshold-units.test.ts` | 比率边界、load/oper_up 非回归、宏语义、字节绝对阈值 |
| `apps/db-ops-api/src/alerts/filesystem-ratio-boundary.test.ts` | 真实挂载分母边界 + 生产消费者评估 + 当前 main（#226 逐维度）状态机 replay |
| `apps/db-ops-api/src/alerts/filesystem-ratio-alert-lifecycle.mysql.test.ts` | 一次性 MySQL 上的真实告警行 create/touch/resolve、逐挂载独立恢复、unknown、规则/快照隔离、旧 80/90/95 误恢复 |
| `apps/db-ops-api/src/alert-rule-metric-target.test.ts` | 复用真实路由处理器，覆盖 `POST`/`PUT` 的拒绝与接受路径 |
| `docs/slide/reviews/2026-10-25-legacy-template-migration-243.md` | 单位换算、保存校验、逐维度恢复与真实 SQL 证据 |
| `docs/slide/reviews/2026-10-25-eight-issues-followup.md` | #6 表补充保存校验说明 |

## 验收逐条

### 1. 文档与 #243 实施输入明确 ratio/百分比转换

- 243 文档“单位换算（#256）”：`ratio = used_bytes / size_bytes`；`80% = 0.80`、`90% = 0.90`、
  `95% = 0.95`；百分比指标必须保留自身指标标识和 `%` 单位。
- 迁移定义仍为 `{ warning: 0.8, error: 0.9, critical: 0.95 }`；
  `validateReplacementDefinition` 对 80/90/95 抛 `RATIO_THRESHOLD_RANGE`（既有用例）。
- 保存校验：`POST`/`PUT` 对 `linux.filesystem.used_ratio` 的 80/90/95 返回 400
  `ALERT_THRESHOLD_RATIO_RANGE` 并提示改写；0.80/0.90/0.95 返回 200。
  `linux.load.one_minute >= 4`、`network.interface.oper_up = 0` 在两条路径都返回 200。

### 2. 真实 used/size 配对、逐挂载边界与独立恢复、unknown 不当 0

数据来源：server:3，2026-10-25T13:24:52Z，11 个挂载的真实 used_bytes/size_bytes 配对
（`outputs/legacy-template-migration-243/verify-final.json`，证据目录不入库）。

派生与评估（生产实现，只替换采集查询）：

- 11/11 挂载经 `executeDerived` 得到的 ratio 与采集值一致（14 位小数内），真实值全部 < 0.80、healthy。
- 边界（真实分母 + 构造分子）：`floor(size × 0.79)` → < 0.80 → healthy；
  `ceil(size × 0.81)` → > 0.80 → warning；0.89 warning、0.90 error、0.94 error、0.95 critical。
- used 缺失 → `value=null` / `quality=unknown`（unknown，不当作 0/healthy）；size 缺失 →
  `missing_input`；真实 0（`/dev`）→ `value=0` / `quality=good`。

真实 MySQL 告警行（`filesystem-ratio-alert-lifecycle.mysql.test.ts`，一次性容器，只替换采集查询与
策略绑定；派生、消费者评估、`ServerAlertEvaluator`、`alerts` 行读写均为生产实现）：

- firing 挂载 `/boot/efi` 创建 1 条 `alerts` 行：`status=unread`、`threshold_value='0.80'`、
  `metric_value` 为该挂载真实分母下的 0.81 比率、`tags.dimensions` 为完整
  `{mount, device, fs_type}`。
- 逐挂载独立恢复：`/boot/efi` 恢复（0.79）而 `/` 仍 firing（0.81）时，`/boot/efi` 的告警行
  `status=resolved` 且写入 `resolved_at`；`/` 的告警行保持 `unread`、`resolved_at` 为空并被
  touch 到新值。这是 #226 的逐维度恢复语义，不是“全部挂载健康才恢复”。
- unknown 不当 0：`/` 缺失 used 时，其活跃告警行保持 `unread`、`metric_value` 不变、不 resolve，
  也不产生新行；同时采集查询确实执行且 `console.error` 未被调用（有效评估，不是异常退出）。
- 规则与快照隔离：同一 server/metric/mount 上规则 42（0.80）与规则 43（0.90）各自持有
  `threshold_value='0.80'` / `'0.90'`；比率 0.85 时规则 42 继续 touch、规则 43 只 resolve 自己的行。
- 旧 80/90/95 规则：在 0.81 比率下把自己的活跃告警行判为恢复（`status=resolved`）而不是触发，
  复现原指引的漏报风险。

### 3. 库分配字节使用 By 绝对值；旧规则处置保留审计

- 真实 1,278,853,120 By 为 healthy；101/501/1001 GiB 分别为 warning/error/critical；
  同一评估链路 `evaluateOperationalRule` 结果一致。
- 0.8/0.9/0.95 被 `ALERT_THRESHOLD_BYTES_ABSOLUTE` 拒绝，避免与文件系统使用率混用。
- 旧规则 85/104 的禁用/删除审计与删除前快照沿用 243 文档记录，本次未改动。

## 验证命令与结果

```bash
pnpm --filter slide-api exec vitest run \
  src/alerts/threshold-units.test.ts \
  src/alerts/filesystem-ratio-boundary.test.ts \
  src/alert-rule-metric-target.test.ts \
  src/metrics/alert-metric-catalog.test.ts
# 4 files / 48 tests passed

pnpm --filter slide-api exec vitest run src/alerts/filesystem-ratio-alert-lifecycle.mysql.test.ts
# 1 file / 5 tests passed（一次性 MySQL，容器随 fixture 关闭删除）

pnpm --filter slide-api exec vitest run \
  src/alerts src/metrics/consumers src/metrics/alert-metric-catalog.test.ts \
  src/alert-evaluator.test.ts src/server-alert-evaluator.test.ts \
  src/alert-rule-metric-target.test.ts src/alert-rule-template-service.test.ts \
  src/server-alert-isolation.mysql.test.ts
# 14 passed | 2 skipped files，121 passed | 3 skipped tests

pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm lint   # 0 errors（既有 296 warnings）
```

变异校验：从 fixture 移除 `findActiveServerAlerts` 后，本轮 5 个状态链用例全部失败；
恢复后 19/19 通过。说明新增断言能捕获“异常被吞掉导致假通过”。

## 未完成与限制

- 0.79/0.81 是“真实分母 + 构造分子”的边界 replay，不是生产已发生的高使用率事件。
- 未部署生产，未重跑 #243 生产迁移；生产规则与旧规则审计保持不变。
- 本地未再跑全量 `pnpm --filter slide-api test`；完整 gate 由本次 exact HEAD 的 CI 执行。
- 前端规则编辑器仍只有数值顺序校验；单位错误由保存接口返回的 `error` 展示。

## 回滚

回滚本轮及上一版提交即可恢复旧的保存行为；无数据库迁移、无持久化配置变更。
