# #243 旧模板迁移逐项上线（qps / disk_usage / 告警宏）

日期：2026-10-25。依据：`2026-10-25-eight-issues-followup.md`（#6 处置表）、#256（ratio 阈值单位修正）、ROADMAP Phase 147。

## 结论

- 旧 `qps` / `disk_usage` 表达式继续 `CUSTOM_EXPRESSION_REVIEW_REQUIRED`，不改名、不直接把旧阈值搬到新指标。
- 新规则只引用已审核的语义指标：
  - `mysql.queries.per_second`（`count/s`，带计数器代次）；
  - `linux.filesystem.used_ratio`（`unit=1`，0–1 比率，`accuracy=exact` 或 `estimated`，取决于浮点表示）；
  - `mysql.tables.estimated_allocated_bytes`（`By`，`accuracy=estimated`）。
- 旧告警规则先禁用（`enabled=0`），确认新规则存在且启用后删除；每次变更在同事务写 `audit_log_entries`，删除后审计仍保留原规则快照。
- 真实基线（instance:1 + server:3）已验证：新指标有真实值；计数器重置产生 `unknown` / `null`，没有被当成 0；文件系统真实 0（`/dev`）仍能按 0 评估。

## 新规则与阈值

| 规则 | 指标 | unit | warning | error | critical | 持续时间 |
| --- | --- | --- | --- | --- | --- | --- |
| QPS 过高 | `mysql.queries.per_second` | `count/s` | 2,000 | 5,000 | 8,000 | 300s |
| 文件系统使用率过高 | `linux.filesystem.used_ratio` | `1` | 0.80 | 0.90 | 0.95 | 300s |
| 数据库大小过高 | `mysql.tables.estimated_allocated_bytes` | `By` | 100 GiB | 500 GiB | 1,000 GiB | 300s |

阈值依据（2026-10-25 真实基线，instance:1）：

- QPS：379 个有效样本（窗口 2026-10-25T05:20:53Z–13:33:45Z），min 278.06、p50 629.45、p99 751.78、max 782.75；33 个重置样本为 `unknown/null`。warning 2,000 ≈ 2.6× max，error 5,000 ≈ 6.4×，critical 8,000 ≈ 10.2×。旧的 3,000/8,000/15,000 没有被复用。
- 文件系统：11 个挂载点，最高 `/` 0.3718；0.80/0.90/0.95 在真实基线上均为健康。逐挂载用同窗口的 `host.filesystem.used_bytes` / `host.filesystem.size_bytes` 重算，11/11 与存储 ratio 一致。`linux.filesystem.used_ratio` 是 0–1 比率，**80/90/95 必须写 0.80/0.90/0.95**（#256）。
- 库大小：最新 1,278,853,120 By（约 1.19 GiB），`accuracy=estimated`。绝对值阈值沿用现有 `data_size_gb` 的 100/500/1000 GiB 口径，不与文件系统比率混用。

## 实现

- `apps/db-ops-api/src/metrics/consumers/legacy-alert-migration.ts`：迁移计划、阈值单位校验、禁用/删除两阶段、事务内审计。
- `apps/db-ops-api/scripts/legacy-alert-migration.ts`：`plan` / `disable` / `delete` / `verify` 操作入口；`disable`/`delete` 默认 dry-run，必须显式 `--apply`。
- `apps/db-ops-api/src/metrics/consumers/migration.ts`：移除 `qps → mysql.queries.per_second` 的隐式映射。旧 `qps` 名称在告警评估中返回 `review_required`，不会再拿旧阈值评估新速率。
- `apps/db-ops-api/src/metrics/consumers/operational.ts`：
  - 允许派生速率/估算指标的 `partial` + `estimated` 证据；`unknown`/`invalid` 和 null 仍然拒绝，计数器重置不会被当作 0。
  - 查询窗口多取一个 bucket，并只裁掉查询边缘没有样本的尾 bucket；真实停采会让最后一个有值 bucket 变 `stale`，中间缺桶仍是 `gap`。
- `apps/db-ops-api/src/metrics/alert-metric-catalog.ts` + `server.ts`：告警规则 API 先查旧注册表，再查已审核语义指标；新规则可以通过既有 API 编辑，而不是复制一份旧的 `metric_definitions`。
- 文档：`2026-10-25-eight-issues-followup.md` 的 #6 表已把 80/90/95 修正为 ratio 0.80/0.90/0.95。

## 迁移步骤（实际执行）

```bash
cd apps/db-ops-api
pnpm migration:legacy-alerts -- plan
pnpm migration:legacy-alerts -- disable --apply --actor MAX-243-operator
pnpm migration:legacy-alerts -- verify --instance 1 --server 3
pnpm migration:legacy-alerts -- delete --apply --actor MAX-243-operator
```

执行记录：

- 禁用阶段：创建规则 123（QPS）、124（文件系统）、125（库大小），禁用旧规则 85（`disk_usage`）和 104（`qps`）。审计 5 条（3 条创建 + 2 条禁用），其中创建审计 `audit_mvnv669u_52879d3d` / `4ba90e95` / `9fe56287`，禁用审计 `audit_mvnv669u_226ad1d9`（104）和 `audit_mvnv669u_2b68d665`（85）。
- 删除阶段：旧规则 85、104 删除，审计追加 2 条删除记录（`audit_mvnv9vap_2eb1a1a9` / `bebba976`）；规则行快照保留在 `audit_log_entries.details_json.before`，包括旧 `metric_name` 和 `threshold_template`（85：80/90/95；104：30000/100000/200000）。
- 删除后 `alert_rules` 中 85/104 不存在，123/124/125 仍启用；再次执行 `delete` 为幂等空操作，`plan` 返回空 retire/replacements；再次执行 `disable` 只复用 123/124/125。

审计查询：

```sql
SELECT id, action, resource_id, username, details_json
FROM audit_log_entries
WHERE JSON_EXTRACT(details_json, '$.migration') = 'MAX-243'
ORDER BY timestamp_ms;
```

## 真实基线验证（instance:1 + server:3）

`pnpm migration:legacy-alerts -- verify --instance 1 --server 3` 输出 `outputs/legacy-template-migration-243/verify-final.json`（证据目录不入库）。验证覆盖：

- `mysql.queries.per_second`：真实有效值；重置样本 `value=null`、`quality=unknown`。
- `mysql.tables.estimated_allocated_bytes`：`accuracy=estimated`，真实值可评估。
- `linux.filesystem.used_ratio`：逐挂载点用同窗口的 `host.filesystem.used_bytes` / `host.filesystem.size_bytes` 重新计算，11/11 与存储的 ratio 一致；全部在 0–1 内。
- unknown vs 真实 0：
  - 重置样本的 null 在评估器里保持 `unknown`、`value=null`；
  - 真实 qps 值（>0）在阈值 0 下可触发；
  - `/dev` 的真实 0 在阈值 0 下触发且 `value=0`，不是 unknown。
- 新规则当前评估结果记录在 `current_rule_evaluation`：库大小当前为 `healthy`（1,278,853,120 By）；QPS/文件系统当前为 `unknown`（QPS 窗口内有计数器重置/重启缺口，server:3 近几次采集因 5s SSH 超时被取消，能力证据为 unknown）。这是真实的 unknown，不是 0，也不是健康。
- 对同一批真实正式数据做证据时点 replay（`replay_evaluation`，只把当前 capability/attempt 状态排除，保留原始 bucket 窗口与质量）：QPS `healthy`、文件系统 `healthy`、库大小 `healthy`；阈值 2,000 / 0.80 / 100 GiB 均未被真实基线触发。

## 仍然 blocked / unknown 的旧项

- `metric_definitions` 中的旧 `qps`、`disk_usage` 定义保留；`/api/metrics/config/resources/instance/:id/migration` 继续返回 `CUSTOM_EXPRESSION_REVIEW_REQUIRED`。没有改名，也没有用直接改库冒充迁移。
- `metric_templates` 的旧 `qps_*` / `disk_*` 宏保留为历史数据，并已在迁移计划/审计中记录（模板 1–5 及实例覆盖）。Phase 130 后模板执行已移除；新规则使用显式指标与阈值，不再读取这些宏。
- 旧 PG/Oracle/DM 的 qps/disk 表达式没有新指标等价值，继续 unknown；本单只上线决定表中明确的 MySQL + Linux 指标。
- 历史告警记录（例如旧规则 85 在 oracle1521 上的 active 告警）不因规则删除而重写；规则处置与历史告警是两件事。

## 测试

```bash
# focused unit
pnpm --filter slide-api exec vitest run \
  src/metrics/consumers/legacy-alert-migration.test.ts \
  src/metrics/consumers/operational.test.ts \
  src/metrics/alert-metric-catalog.test.ts

# 事务/审计（MySQL 9.6 容器）
METRICS_TEST_MYSQL_PORT=<port> pnpm --filter slide-api exec vitest run \
  src/metrics/consumers/legacy-alert-migration.mysql.test.ts

# 回归
pnpm --filter slide-api exec vitest run \
  src/metrics/consumers src/metrics/config src/metrics/policy \
  src/alert-evaluator.test.ts src/server-alert-evaluator.test.ts
pnpm --filter slide-api typecheck
```
