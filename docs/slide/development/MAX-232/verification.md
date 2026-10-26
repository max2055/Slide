# MAX-232：文件系统 ratio 阈值迁移指引修正（GitHub #256）

日期：2026-10-26。任务分支 `agent/15coder1/max-232`（本轮基线 `0dcbfa6fa`），PR
[#350](https://github.com/max2055/Slide/pull/350)。

## 本轮修复（Chief review `97bfc2553` 的 changes requested）

上一版把 `unit=1` 一律当作比率，引入两个真实回归：

| 指标 | 既有语义 | 上一版保存结果 | 本轮 |
| --- | --- | --- | --- |
| `linux.load.one_minute` | load average，可 > 1 | 400 拒绝 | 接受（`>= 4` 等） |
| `network.interface.oper_up` | up=1 / down=0 | 400 拒绝（0 不在 (0,1]） | 接受（`= 0`） |
| `linux.filesystem.used_ratio` | used/size，0–1 | 80 拒绝 / 0.8 接受 | 保持 |

修复方式：比率校验按指标语义收窄到 `linux.filesystem.used_ratio`，不再按 `unit=1` 判断；
`unit=By` 仍要求整数绝对字节（拒绝 0.8/0.9/0.95，保留真实 0 与操作符语义）；
上一版额外加的“所有 `unit=1`/`By` 指标拒绝未解析宏”属于范围外产品限制，已移除，
仅在比率指标上保留（宏可能解析成旧百分比）。`POST` 与 `PUT` 两条保存路径都覆盖。

## 目标与范围

修正 #243 迁移指引中的单位错误：`linux.filesystem.used_ratio` 是 0–1 比率，80%/90%/95% 必须写成
0.80/0.90/0.95；库大小仍用 `By` 绝对字节阈值；保存时拒绝把旧百分比原值直接搬到新指标，
同时不影响其他无量纲指标。

排除项：

- 不重新执行 #243 的生产迁移，不改动已上线规则与旧规则 85/104 的审计记录。
- 不新建/重启 MySQL 容器，不改动共享数据库；SQL fixture 属 MAX-225，待串行交接。
- 不改动 MAX-225 负责的 `alert-database-service` / `rca-investigation-bridge` /
  `event-aggregator` / `qualify-automatic-alert`。

关键假设：

- “预览/保存”分别指迁移 CLI 的 `plan`（预览）/ `disable|delete --apply`（保存），
  以及 `/api/alert-rules` 的 `POST`/`PUT` 保存接口；前者由 `validateReplacementDefinition`
  校验，后者由本轮新增的 `validateAlertThresholdUnits` 校验。
- 真实基线最高比率为 `/` 0.371783，0.79/0.81 只能在与真实挂载分母配对的隔离 replay 中验证，
  不能表述为生产已发生的使用率事件。

## 改动

| 文件 | 内容 |
| --- | --- |
| `apps/db-ops-api/src/alerts/threshold-units.ts` | 比率校验只作用于 `linux.filesystem.used_ratio`；`unit=By` 要求整数绝对字节；移除全局宏限制 |
| `apps/db-ops-api/server.ts` | `POST/PUT /api/alert-rules` 保存前调用上述校验，返回 400 + `code`；PUT 仅在写入阈值相关字段时校验 |
| `apps/db-ops-api/src/metrics/alert-metric-catalog.ts` | 目录条目补充 `unit`（旧注册表与语义指标都返回） |
| `apps/db-ops-api/src/alerts/threshold-units.test.ts` | 比率边界、load/oper_up 非回归、宏语义、字节绝对阈值 |
| `apps/db-ops-api/src/alerts/filesystem-ratio-boundary.test.ts` | 真实挂载分母边界 + 生产消费者评估 + `ServerAlertEvaluator` 状态机 replay |
| `apps/db-ops-api/src/alert-rule-metric-target.test.ts` | 复用真实路由处理器，覆盖 `POST`/`PUT` 的拒绝与接受路径 |
| `docs/slide/reviews/2026-10-25-legacy-template-migration-243.md` | 单位换算、保存校验、边界与状态链证据、未完成项 |
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

隔离 replay 使用上述真实配对为输入、真实维度（mount/device/fs_type），经生产
`executeDerived` 计算 ratio（逐挂载与采集时记录的 ratio 一致到 14 位小数，真实值全部 < 0.80），
再走生产消费者评估入口 `evaluateOperationalRule` → `evaluateMetric` 与真实
`ServerAlertEvaluator` 状态机：

- 真实配对：11/11 挂载 derived ratio 与采集值一致，评估为 healthy。
- 边界（真实分母 + 构造分子）：`floor(size × 0.79)` → < 0.80 → healthy；`ceil(size × 0.81)` → > 0.80 → warning。
- 0.89 → warning、0.90 → error、0.94 → error、0.95 → critical。
- 三个挂载 0.81、其余 0.79：规则 firing；只恢复其中一个仍 firing；全部恢复才 `recovery=true`。
  告警按规则/服务器去重，不存在“单挂载告警行各自恢复”的持久化语义。
- `ServerAlertEvaluator` replay：首次 firing → `createAlert`（含 mount 维度）；部分恢复 →
  `touchAlert`；全部恢复 → `resolveAlert`；其余挂载健康但有一个 unknown 时不 create/touch/resolve
  （unknown 不当作 0 或 healthy）。
- used 缺失 → `value=null` / `quality=unknown`（unknown，不当作 0/healthy）；size 缺失 →
  `missing_input`；真实 0（`/dev`）→ `value=0` / `quality=good`。
- 旧 80/90/95 直接用于 ratio（0.371783–0.999999）永不触发；在状态机 replay 中，这类旧规则遇到
  >0.80 的比率会 `resolveAlert` 而不是 `createAlert`，复现原指引的漏报风险。
- 真实已观测比率（0–0.371783）全部 healthy。

证据等级（不得混用）：派生计算与阈值分级是生产实现；消费者评估与告警状态机 replay 只替换了
采集查询与 MySQL 支撑的 `alertDatabaseService`/`serverDatabaseService`。**真实 MySQL 告警行的
创建/更新/恢复尚未执行**，见“未完成”。

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

pnpm --filter slide-api exec vitest run \
  src/alerts src/metrics/consumers src/metrics/alert-metric-catalog.test.ts \
  src/alert-evaluator.test.ts src/server-alert-evaluator.test.ts \
  src/alert-rule-metric-target.test.ts src/alert-rule-template-service.test.ts
# 12 passed | 2 skipped files，107 passed | 3 skipped tests

pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm lint

pnpm --filter slide-api test
# 首次全量（源码改动后）：4251 passed | 1113 skipped，449 files passed
```

全量重跑时 Docker 并发的 T07/T08 MySQL 套件出现 `Connection lost` / `STACK_TRACE_ERROR`
超时（`investigations/alert-bridge*`、`legacy-analysis-bridge`、`resource-event-bridge`、
`trigger-concurrency.mysql`、`network-device-alert-evaluator.mysql`）。这 6 个文件用
`--no-file-parallelism` 串行重跑为 6 files / 62 tests passed，与本改动无关；
告警/指标相关套件在多轮运行中始终通过。

## 未完成（需串行 SQL 交接）

真实 MySQL 中的告警状态持久化未验证：`alerts` 行在 ratio 规则 firing 时创建、部分挂载恢复时更新、
全部恢复时 resolve，以及 unknown 挂载不 resolve 的库内结果。需在 MAX-225 释放 SQL fixture 后，
用与 `server-alert-evaluator.test.ts` 相同的最小 fixture 执行一次迁移 + 评估 + 查询断言，
并记录精确版本/提交与输出。本报告不宣称该项通过。

## 风险与限制

- 边界验证是“真实分母 + 构造分子”的隔离 replay，不是生产已达到 0.79/0.81 的观测；
  交付说明必须保持这一措辞。
- 保存校验只覆盖数值/宏阈值语义；其他单位（`%`、legacy `bytes`、`state`）保持原有行为。
- 未重新查询实时 MySQL 数据（避免与 MAX-225 的 SQL 使用冲突）；如需当日实时复核，
  可在串行交接后执行 243 的 `verify`。
- 前端规则编辑器仍只有数值顺序校验；单位错误由保存接口返回的 `error` 展示。

## 回滚

回滚本轮及上一版提交即可恢复旧的保存行为；无数据库迁移、无持久化配置变更。
