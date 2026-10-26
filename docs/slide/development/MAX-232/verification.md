# MAX-232：文件系统 ratio 阈值迁移指引修正（GitHub #256）

日期：2026-10-26。任务分支 `agent/15coder1/max-232`，基线 `c0e8fdc17`。

## 目标与范围

修正 #243 迁移指引中的单位错误：`linux.filesystem.used_ratio` 是 `unit=1` 的 0–1 比率，80%/90%/95% 必须写成 0.80/0.90/0.95；库大小仍用 `By` 绝对字节阈值；保存和迁移预览都必须拒绝把旧百分比原值直接搬到新指标。

排除项：

- 不重新执行 #243 的生产迁移，不改动已上线的规则 123/124/125 与旧规则 85/104 的审计记录。
- 不新建/重启 MySQL 容器，不改动共享数据库；真实数据沿用 2026-10-25 已采集的 `verify-final.json` 证据。
- 不改动 MAX-225 负责的 `alert-database-service` / `rca-investigation-bridge` / `event-aggregator` / `qualify-automatic-alert`。

关键假设：

- “预览/保存”对应两条路径：迁移 CLI 的 `plan`（预览）/ `disable|delete --apply`（保存），以及 `/api/alert-rules` 的保存接口。前者已有 `validateReplacementDefinition`，本次补齐后者。
- 真实基线最高比率为 `/` 0.371783，0.79/0.81 只能在与真实挂载分母配对的边界构造中验证，不能表述为生产已发生的使用率事件。

## 改动

| 文件 | 内容 |
| --- | --- |
| `apps/db-ops-api/src/alerts/threshold-units.ts` | 按指标单位校验阈值：`unit=1` 只接受 (0,1]；`unit=By` 只接受正整数；两类指标拒绝未解析告警宏 |
| `apps/db-ops-api/server.ts` | `POST/PUT /api/alert-rules` 保存前调用上述校验，返回 400 + `code`；PUT 仅在写入阈值相关字段时校验 |
| `apps/db-ops-api/src/metrics/alert-metric-catalog.ts` | 目录条目补充 `unit`（旧注册表与语义指标都返回） |
| `apps/db-ops-api/src/alerts/threshold-units.test.ts` | 单位校验单测（含 80/90/95 拒绝、0.79/0.81 接受、宏拒绝、JSON 字符串模板） |
| `apps/db-ops-api/src/alerts/filesystem-ratio-boundary.test.ts` | 真实挂载分母上的 0.79/0.81 边界、逐挂载独立恢复、unknown≠0、字节阈值 |
| `apps/db-ops-api/src/alert-rule-metric-target.test.ts` | 复用真实路由处理器，覆盖保存接口的拒绝/接受路径 |
| `docs/slide/reviews/2026-10-25-legacy-template-migration-243.md` | 新增单位换算、保存校验、边界验证与测试命令 |
| `docs/slide/reviews/2026-10-25-eight-issues-followup.md` | #6 表补充保存校验说明 |

## 验收逐条

### 1. 文档与 #243 实施输入明确 ratio/百分比转换

- `2026-10-25-legacy-template-migration-243.md` 新增“单位换算（#256）”：`ratio = used_bytes / size_bytes`，`80% = 0.80`、`90% = 0.90`、`95% = 0.95`；百分比指标必须保留自身指标标识与 `%` 单位。
- `2026-10-25-eight-issues-followup.md` #6 表明确保存时按 `unit` 校验。
- 代码中的迁移定义仍为 `{ warning: 0.8, error: 0.9, critical: 0.95 }`，且 `validateReplacementDefinition` 对 80/90/95 抛 `RATIO_THRESHOLD_RANGE`（`legacy-alert-migration.test.ts` 既有用例）。
- 新增保存接口校验：`POST /api/alert-rules`（`linux.filesystem.used_ratio` + 80/90/95）返回 400 `ALERT_THRESHOLD_RATIO_RANGE`，提示 0.80/0.90/0.95；0.80/0.90/0.95 返回 200。

### 2. 真实 used/size 配对、逐挂载边界与独立恢复、unknown 不当 0

数据来源：server:3，2026-10-25T13:24:52Z，11 个挂载（`outputs/legacy-template-migration-243/verify-final.json`，证据目录不入库；对应 243 文档“真实基线验证”）。

`filesystem-ratio-boundary.test.ts` 使用真实挂载容量为分母、真实维度（mount/device/fs_type），通过生产派生引擎（`executeDerived`）计算 ratio，再用生产告警编译/评估函数判定：

- 11/11 挂载：`floor(size × 0.79)` → ratio < 0.80 → healthy；`ceil(size × 0.81)` → ratio > 0.80 → warning。
- 0.89 → warning、0.90 → error、0.94 → error、0.95 → critical。
- 3 个挂载 0.81、其余 0.79 时只有这 3 个 firing；其中一个恢复 0.79 后仅该挂载恢复，其余保持 firing。
- used 缺失 → `value=null`、`quality=unknown`；size 缺失 → `missing_input`；真实 0（`/dev`）→ `value=0`、`quality=good`。
- 旧 80/90/95 直接用于 ratio 值（0.371783–0.999999）永不触发，复现原指引的漏报风险。
- 真实已观测比率（0–0.371783）全部 healthy。

### 3. 库分配字节使用 By 绝对值；旧规则处置保留审计

- `filesystem-ratio-boundary.test.ts` 另组用例：`mysql.tables.estimated_allocated_bytes` 在真实 1,278,853,120 By 为 healthy；101/501/1001 GiB 分别 warning/error/critical；0.8/0.9/0.95 被 `ALERT_THRESHOLD_BYTES_ABSOLUTE` 拒绝。
- `legacy-alert-migration.test.ts` 继续覆盖 100/500/1000 GiB 与旧 80/90/95 不平移。
- 旧规则 85/104 的禁用/删除审计记录与删除前快照见 243 文档“迁移步骤（实际执行）”，本次未改动。

## 验证命令与结果

```bash
pnpm --filter slide-api exec vitest run \
  src/alerts/threshold-units.test.ts \
  src/alerts/filesystem-ratio-boundary.test.ts \
  src/alert-rule-metric-target.test.ts \
  src/metrics/alert-metric-catalog.test.ts
# 4 files / 31 tests passed

pnpm --filter slide-api exec vitest run \
  src/metrics/consumers src/metrics/alert-metric-catalog.test.ts src/alerts \
  src/alert-evaluator.test.ts src/server-alert-evaluator.test.ts \
  src/alert-rule-metric-target.test.ts src/alert-rule-template-service.test.ts
# 12 passed | 2 skipped，90 passed | 3 skipped

pnpm --filter slide-api typecheck
pnpm contracts:check
```

## 风险与限制

- 边界验证是“真实分母 + 构造分子”，不是生产已达到 0.79/0.81 的观测；交付说明必须保持这一措辞。
- 保存校验只覆盖数值阈值；旧 `%`/`bytes`/`state` 单位保持原有语义，不受影响。
- 比率/字节指标上的未解析告警宏被拒绝，需要显式写数值；这阻止了“改指标名沿用旧百分比”，但也意味着此类规则不能再用模板宏。
- 未重新查询实时 MySQL 数据（避免与 MAX-225 的 SQL 使用冲突）；如需当日实时复核，可在串行交接后执行 243 的 `verify`。
- 前端规则编辑器仍只有数值顺序校验；单位错误由保存接口返回的 `error` 展示，未新增前端预览控件。

## 回滚

回滚本次提交即可恢复旧的保存行为；无数据库迁移、无持久化配置变更。
