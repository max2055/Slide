# MAX240-HISTORY-WINDOW 交付说明（2026-10-29）

范围：Chief 准入的 MAX-240 原范围独立读取/聚合包。只改正式查询读取链，不做 UI、不放开模板规则/policy/schema/retention/writer，不宣称 MAX-240 整单完成。

## 1. 输入与基线

- 分支基线：`e11f6ba2ed8108af585af022c4acf8817c1d1fec`（main），本任务分支 `agent/15coder1/max-240`。
- 8 个消费者输入文件在该基线与 `534dfb1be`、`4fe1e9b18`、`c811e5939` 逐 blob 一致，已用 `git hash-object` 复核，与 `consumer-inputs.json` 完全相同：
  `contracts/metrics/validation.ts` `fedfbe24…`、`contracts/metrics/observations.ts` `2424d319…`、`metrics/query.ts` `03bd5812…`、`metrics/storage.ts` `f68d9119…`、`metrics/rollout/formal-store.ts` `498304a0…`、`metrics/consumers/{service,runtime,routes}.ts` `53ab3db6…`/`17c178f5…`/`fef1d022…`。

## 2. 问题与实现

现状：`MysqlFormalMetricStore.queryWindow` 单条语句最多 1000 行、`aggregate` 最多 1000 桶，24h×1min=1440 槽真实 `/api/metrics/query` 直接 `QUERY_LIMIT_EXCEEDED`。

实现（仅读取侧）：

1. `rollout/formal-store.ts` 新增 `readWindow(series, from, to)`：在**同一事务**内复制既有正式可见性谓词（`metric_publications→metric_observations→metric_rollout` 的 generation / read_mode / applied=published / source=semantic / config_revision / policy binding fence）并用 `metric_rollout … FOR UPDATE` 固定切换；按 `(p.observed_at, p.observation_id)` 升序 keyset 分页读到窗口结束，另取窗口前一条/后一条供计数器速率与时权保持使用。
   - 顺序/游标：`observed_at` 升序，重复时间戳以 `observation_id` 升序决胜；游标 `(observed_at, observation_id)` 严格大于，页界不会重复或漏掉同一时间戳的多行。
   - 一致性边界：所有页在同一 REPEATABLE READ 快照内（与既有 `queryWindow` 相同），切换/回滚被行锁阻止，后页不会混入新事实；游标只在本次调用内部使用，不跨请求复用，因此每次查询都重新执行当前主体授权。
   - 有界保护：`page_rows=1000`（单条语句）、`max_rows=50_000`（单系列整窗，31 天×60s=44,640 上限内），超限抛 `QUERY_LIMIT_EXCEEDED` 而不是静默截断。上限只在构造参数中可注入以便验证，生产使用默认值。
2. `metrics/query.ts`：`QueryStore` 增加可选 `readWindow`；`SemanticQueryService` 在授权之后优先使用它，缺失时回退 `queryWindow`（其它消费方/测试桩不受影响）。
3. 桶上限：`MAX_BUCKETS=10_080`（7 天×60s 默认周期），替换原 1000；超出仍 `QUERY_LIMIT_EXCEEDED`。
4. 降采样：每个桶输出 `stats: {count,min,max,avg}`（速率桶为该区间各自速率的包络），`value` 为所选模式；缺口桶 `value=null` 时 `stats=null`，不补 0、不暴露未被 `value` 担保的样本。历史质量仍按当时样本判定，`freshness` 仅由最近有效观测与查询时刻决定。
5. 性能：桶计算由“每桶全窗口重扫”改为“每系列去重排序一次 + 二分切片 + 每桶一条前驱/后继”，24h×1440 点聚合从约 1.3 s 降到约 30 ms（本地 Node 24 实测），否则 7 天窗口在 10,080 桶下无法有界完成。
6. `metrics/consumers/runtime.ts`：正式 consumer store 接上 `readWindow`，真实 `/api/metrics/query` 与 `/api/metrics/evaluate` 走完整窗口读取。

未改动：生产写入、retention、rollout 控制、迁移/schema、policy/config、scheduler/worker、前端、MAX238 fixture；`rollout/control.ts` 内置窗口（评估用短窗）保持原样；未新增公开 OpenAPI 路径或生成物（`contracts:check` 无差异）。

## 3. 验证（绑定本分支）

环境：macOS darwin 27.2.0、Node v24.18.0、pnpm 11.19.0；一次性 `mysql:8.4`（8.4.10）容器映射 `127.0.0.1:33307`（非 3306），测试自建 `max240_history_<pid>` 库并在结束后删除，测试连接会话时区 `+05:30`（证明时区不移动窗口）。

| 检查 | 命令 | 结果 |
|---|---|---|
| API 类型 | `pnpm --filter slide-api typecheck` | 退出 0 |
| 前端类型（未改前端，回归） | `pnpm --filter slide-frontend typecheck` | 退出 0 |
| 公开契约 | `pnpm contracts:check` | 退出 0，无生成物差异 |
| 聚合单测 | `vitest run src/metrics/query.test.ts src/metrics/query.window.test.ts` | 通过（1440 槽首尾/缺口/峰值/1 万桶边界/分页读取/授权先于读取） |
| 一次性真实 MySQL + 真实 HTTP | `METRICS_TEST_MYSQL_PORT=33307 vitest run src/metrics/rollout/history-window.mysql.test.ts` | 3/3 通过，HTTP 24h/1440 桶耗时 86 ms |
| 受影响模块 | `vitest run src/metrics/consumers src/metrics/rollout/{control,formalization,history-window}.mysql.test.ts src/metrics/packages src/operations/baselines` | 17 文件 202 测试通过 |
| metrics 全量 | `METRICS_TEST_MYSQL_PORT=33307 vitest run src/metrics` | 62/70 文件、558 测试通过；`policy/store.mysql.test.ts` 在 70 文件并行下 5 s 超时，单独重跑 9/9 通过（并行资源），其余文件均通过 |
| 下游消费 | `vitest run src/operations src/investigations src/alerts` | 91/120 文件通过；3 个 MySQL 文件在并行负载下超时/失败，逐文件重跑 24/24 通过（环境并行，与本改动无关） |

真实 MySQL 证据（`history-window.mysql.test.ts`，1440 分钟窗 + 前驱/后继 + 重复时间戳 + 缺口 + 峰值 + 4 类围栏负例）：

- HTTP `/api/metrics/query` 返回恰好 1440 桶，首桶 `[from, from+60s)`、末桶 `[to-60s, to)`；`sample_count` 合计 1438（1440 减去 2 个保留缺口）。
- 缺口分钟 `value=null, stats=null, coverage=0, reason=missing_input`；第一个桶 24 小时前仍 `quality=good, accuracy=exact`（仅 `freshness=stale`），不因年龄变缺测。
- 峰值样本（第 720 分钟 `999999`）在 `value` 与 `stats.max` 一致；相邻正常桶值为 `500 % 41`，证明按桶边界取数。
- 重复时间戳（第 999 分钟两行，跨越 1000 行页界）：`readWindow` 返回两行且无重复 id；聚合每时间戳只取确定的一条，未重复计数。
- 页界等价：`page_rows=1000` 与 `page_rows=97` 返回完全相同的完整 id 序列；`page_rows=100, max_rows=500` 抛 `QUERY_LIMIT_EXCEEDED`。
- 围栏负例不出现：无 publication 的 shadow 样本、`config_revision=2`、旧 generation 的 publication、`semantic_version=2.0.0` 行。
- 上限与权限：`bucket_ms=1000`（86,400 桶）经 HTTP 返回 400 `QUERY_LIMIT_EXCEEDED`；撤权主体返回 403 `POLICY_FORBIDDEN`，恢复授权后再次 200。

计数/清理：测试库 `max240_history_<pid>` 由测试创建并 `DROP DATABASE`；容器为本次一次性实例（8.4.10，宿主端口 33307），测试结束删除；未连接共享 3306、未写业务库、未部署、未改动共享服务。

## 4. 未完成与剩余项（不宣称整单完成）

- UI/图形接线、当前采集状态与“旧值灰化”展示：本包 API-only，按准入首轮不改 UI。
- 历史阈值当时配置/事件快照、停用/解绑后保留历史可见性、改名/普通版本升级身份保持：仍属 MAX-240 原范围其它部分，本包未改现有 fence 语义。
- 公开原始值分页接口未开放：分页游标仅服务内部读取（不跨请求），原始样本按桶 `observed_at`/`sample_count`/`sources` 及更窄窗口追查；如需对外分页需另行定义公开契约。
- 真实采集链路与容量 SLO qualification：本包未做，fixture 不冒充真实采集；延迟数据仅本机目标数据量（24h×1min）实测，未作容量声明。
- 未在 3306 业务库、未部署、未跑真实目标采集；安全/权限/审计最终结论由 Chief 独立复核。
