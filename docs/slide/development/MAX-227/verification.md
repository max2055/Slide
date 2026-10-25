# MAX-227 / GitHub #251 验证记录

## 范围与实现

仅修复 MetricFormalization 的重复工作和样本定位，不改变 1s scheduler tick、60s 采集周期、采集开关、历史保留、发布锁次序或公开契约。

原实现每个 tick 无条件锁定发布源、扫描 normalized 历史并逐条检查 lineage。现在通过资源主键读取资产开关，并对当前配置、持久化采样快照和迁移 phase/revision/generation/gate 计算摘要。相同摘要在同一个 formalizer 中不再重复进入核验事务。摘要变化后，在原发布 fence → policy lock 的事务内重新读取摘要并校验，提交成功后才保存摘要。异常不保存摘要；进程重启会重新核验一次。每个资源只保存一个摘要，内存最多 10000 项；淘汰只会增加核验工作，不授予发布权限。

核验使用持久化 snapshot.sample_ids 按 observation PRIMARY 定位，保留时效条件及语义、资源、配置、package、raw/derived lineage 和 attempt 校验。未采集到有效证据、资产停用、配置不匹配或回滚版本均不会因摘要命中而获得新发布权限。读侧原有配置、质量和 stale 处理不变，unknown 不转换为零值或恢复事件。

## RED / GREEN 与业务检查

在生产代码修改前，真实 MySQL 回归确认：10 次空闲 reconcile 重复执行 10 次历史扫描、10 次 raw 查询及 10 次 GET_LOCK。RED 测试提交：`e009f56e2`。

回归覆盖同批空闲 tick、新采样批次、迁移状态变化、包/配置切换与切回、失败/缺失/错误 snapshot、停用和重新启用、过期样本、缓存验收后的读侧 stale→unknown，以及资源/版本/raw/attempt 边界。边界篡改被现有 observation identity 校验或 source lineage 校验拒绝。

## 真实 MySQL 前后对照

2026-10-26，Node 24.18.0 / pnpm 11.19.0，独立 `mysql:9.6` 容器；3 个 MySQL 资源，100012 条 observation（其中 100000 条为同形状的过期历史负载夹具），采集周期均 60000ms。前后在相同容器重新建独立数据库，使用正式迁移、MetricScheduler、WorkerRuntime、真实 `SHOW GLOBAL STATUS` 采集、持久化 raw/normalized/attempt、MetricFormalization、正式 metric store/consumer 和 `evaluateMetric`。对照过程中没有其他测试访问该实例。修复源码版本为 `ecbc01a0a`。

这是可复现的真实 SQL 性能/业务夹具，不是用户生产数据库的原位复测；历史负载是合成记录，代表采集指标为每资源的 `db.uptime_seconds`，不代表混合数据库/服务器/网络设备的全部指标组合。告警耗时覆盖正式指标读取与阈值评估，不包含通知渠道投递。

| 指标 | 基线 c9fab86 | 修复后 |
|---|---:|---:|
| 窗口 | 65.564s | 65.118s |
| 完成 tick | 63 | 65 |
| 实际新增采集 SQL | 3 | 3 |
| MySQL CPU（单核百分比） | 53.4707% | 0.4390% |
| 全局 QPS | 82.15 | 42.00 |
| schema rows examined | 18905849 | 1918 |
| schema rows examined / s | 288357.16 | 29.45 |
| InnoDB rows read | 18905271 | 2501 |
| InnoDB row lock waits / time | 0 / 0ms | 0 / 0ms |
| digest SQL lock time 总和 | 1.752ms | 0.954ms |
| tick 中位 / P95 | 1003 / 1125ms | 11 / 15ms |
| 采集 tick 开始→告警 firing 评估完成 | 1189ms | 134ms |

CPU 使用容器 cgroup `cpu.stat.usage_usec` 的窗口增量，100% 表示一个逻辑核心。QPS 为 GLOBAL STATUS Queries 增量；rows examined / SQL lock time 来自本次数据库 performance_schema digest 增量。窗口内没有额外人工锁竞争，不能把零等待解读为高竞争场景证明。原始计数、全部 tick 耗时与 EXPLAIN 见 `before.json`、`after.json`。

原查询：`idx_metric_retention` 的 stage 前缀，估算 46269 行，`Using where; Using filesort`。新查询：`PRIMARY`，`const`，1 行。新路径按本批 IDs 定位，历史总量不再参与样本扫描；空闲路径不读取 observation 或申请发布锁。

## 复现

使用根 `package.json` 的 pnpm 版本，准备独立 MySQL 9.6、空 root 测试密码并启用 performance_schema。不要将测试端口指向业务库。环境变量中的输出文件路径相对于 `apps/db-ops-api`。

```bash
# 原版本临时副本与当前文件处于同目录，保持相对 import；不切换/重写任务分支。
git show c9fab86f9a2825b69639762603c462a948129ef9:apps/db-ops-api/src/metrics/rollout/formalization.ts > apps/db-ops-api/src/metrics/rollout/.max227-baseline.ts

METRICS_TEST_MYSQL_PORT=<port> METRICS_TEST_MYSQL_CONTAINER=<container> \
  METRICS_LOAD_FORMALIZATION=./.max227-baseline.ts METRICS_LOAD_LABEL=baseline \
  METRICS_LOAD_EVIDENCE=../../before.json pnpm --filter slide-api exec vitest run \
  src/metrics/rollout/formalization.mysql.test.ts -t 'records a reproducible'

METRICS_TEST_MYSQL_PORT=<port> METRICS_TEST_MYSQL_CONTAINER=<container> \
  METRICS_LOAD_LABEL=fixed METRICS_LOAD_EVIDENCE=../../after.json \
  pnpm --filter slide-api exec vitest run src/metrics/rollout/formalization.mysql.test.ts \
  -t 'records a reproducible'

METRICS_TEST_MYSQL_PORT=<port> pnpm --filter slide-api exec vitest run \
  src/metrics/rollout/formalization.mysql.test.ts
```

两次负载测试必须串行、避免同一 MySQL 上运行其他测试。完成后清理自己生成的 `.max227-baseline.ts` 和测试容器；测试自动删除各自的数据库。无负载环境变量时，65 秒对照用例默认不执行。

## 最终 gate

- 专项 MySQL 9.6 回归：13 passed，1 个可选负载用例 skipped；该负载用例已在独立的前后对照中各自执行通过。
- `pnpm --filter slide-api typecheck`：通过。
- `pnpm lint`：0 errors，294 条既有 warnings。
- `pnpm contracts:check`：通过。
- `node --test tests/qualification/*.test.mjs`：46 passed。
- `pnpm qualification:matrix`：37/37 findings mapped。
- `bash scripts/qualification/run-investigation-rollout.sh --api`：使用脚本专用 MySQL 8.4 / 9.6 和串行 worker，完整执行 922.13s；498 文件通过、17 文件跳过、2 文件失败；5231 项通过、102 项跳过、2 项失败。摘要见 `gate-summary.json`。

完整候选发现未修改的 `src/investigations/governance.mysql.test.ts:330` 失败：域轮换测试拿到了 `rotation:null` 的审计记录。独立执行 `-t 'rotates the ledger domain'` 也复现。测试 SQL 用 `JSON_EXTRACT(details_json, '$.rotation') IS NOT NULL` 筛选，然后读取无 ORDER BY 的首行；MySQL 的 JSON `null` 仍符合这个谓词（在专用 8.4 实例直接执行得到 1），因此 runtime-only 更新的空轮换审计也被选中。该测试及治理/预算实现与基线完全一致，且该路径不调用 MetricFormalization；归类为无关既有失败，不在本单修改。完整合并门禁不能据此标绿。

另一失败为未修改的 `src/operations/product-budget-lock.test.ts`：文件争用测试的 read 子进程抛出 `OPERATIONS_BUDGET_LOCK_TIMEOUT`。该用例独立复查通过（11.42s），记录为无关既有间歇失败；不将独立复查通过改写为完整候选全绿。本次指标相关测试、配置切换/迟到任务/回滚和真实 MySQL 正式化回归均通过。

较早的普通 `--maxWorkers=2` 调用只设置了 METRICS 的 9.6 端口，产生既有 8.4 用例版本不匹配和并行数据库启动超时；已优雅取消并清理本次子测试容器，正式门禁改用仓库标准双实例脚本。新增边界断言最初预期较晚的 SOURCE_IDENTITY，实测被更早的 IDEMPOTENCY_ID 拒绝；已修正测试预期，专项回归通过。

没有模型调用；本任务模型测试用量为 0，编码代理 token/费用实际遥测不可用。

测试自动删除隔离数据库；标准候选的两个容器已由脚本清理，额外负载容器也在交付前清理。测试生成的已跟踪 readiness 结果已恢复，保留运行时注入的 AGENTS.md 与预先存在的 .multica 内容。

不直接推送带有无关运行快照的任务基线。仅提交本单源码、测试和证据，交付任务 SHA 供 Chief 提取 source-only 提交。
