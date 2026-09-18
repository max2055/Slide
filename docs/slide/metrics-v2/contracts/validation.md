# MAX-64 验收证据

日期：2026-09-18。分支：`agent/15astra/max64-contracts`。基线：`2995227f4416460612e3434cfdee1d93dd24b2a4`（main，包含已合并 MAX-63 PR #74）。交付 commit/PR 的精确链接见本任务最终评论；本文件随同交付提交保存，不自引用尚不存在的提交 SHA。

## 验收对应

|要求|证据|
|---|---|
|全部命名对象的 TypeScript/schema|`apps/db-ops-api/src/contracts/metrics-v2/{definitions,observations,configuration}.ts`；导出的 `schemas.json`；TypeScript 类型由 Zod 推导|
|状态转移、兼容、API 与关闭边界|`README.md`，其中区分纯契约与后续运行时集成；`validateAttemptTransition`、`acceptsVersion`、`resolveDecision` 的测试|
|同 canonical ID 不同语义拒绝|同 ID 改 unit/meaning/temporality/scope/dimensions/aggregation 的负例|
|单位/64 位/维度/时间/分布|UnitSchema；Counter64 大于 2^53 与 uint64 上界；未知/缺失维度、基数上限、时间顺序、累计 histogram 边界/总数|
|Canonical/Extension、三类资源与属性|`fixtures.json`：instance/server/network_device；db.version、os.family、device.model 属性；Extension、canonical、估算 gauge、精确 derived|
|一项一来源、DAG|跨 collection 的重复来源拒绝；未知引用、pin、单位转换顺序、循环与自依赖测试；跨资源派生拒绝|
|质量与尝试分离|timeoutAttempt 与 supported Capability 同时合法；failed attempt 禁止观测；质量枚举拒绝、缺失零值拒绝、历史 unknown 不升级|
|聚合与缺失|avg(p95)、累计 counter sum、zero fill 均拒绝；告警 missing 只能 unknown|
|身份、幂等与版本|单位/资源/语义冲突、包/profile 不可变、Extension 晋升检查、等价毫秒时间身份、终态不可改、同 ID 不同载荷冲突|
|可移植正反例|`fixtures.json` 的 invalidExamples 包含非法单位、单位冲突、资源身份冲突、非法质量枚举、契约版本不兼容、语义不兼容；测试按预期错误校验|
|生成产物无漂移|全量测试中的 focused 契约套件比较 `schemas.json` 和 fixture 与同一源码导出结果|

## 实际命令与结果

在上述任务分支对应代码上运行：

- `pnpm install --frozen-lockfile --offline`：成功，复用本地缓存，无依赖/lockfile 变更。
- `pnpm --filter slide-api exec tsx src/contracts/metrics-v2/export.ts`：成功生成 schema 和合成样例。
- `pnpm --filter slide-api exec vitest run src/contracts/metrics-v2/contracts.test.ts`：59 项通过；最终完整 gate 再次包含该套件。
- `pnpm --filter slide-api typecheck`：通过。
- `pnpm --filter slide-api test`：最终 **262 文件通过、4 文件跳过；2326 测试通过、55 跳过**，退出码 0。跳过项为仓库原有测试配置，并非本项为绕过失败而修改。
- `pnpm exec oxlint apps/db-ops-api/src/contracts/metrics-v2`：0 warning、0 error。
- `pnpm contracts:check`：通过，现有公共 API 生成产物无变动。
- `python3 docs/slide/metrics-v2/v1/verify.py`：通过（64 registry identities、65 provider cases、70 realtime fields、55 referenced files、三类 fixture）。
- `git diff --cached --check`：提交前通过。

第一次 focused 执行发现导出脚本/测试相对路径多退一级，修正后通过；没有放宽校验。随后复核固定 UTF-16 字典序、UTC 毫秒身份与精度上限，重新生成产物并重新运行类型/全量门禁。最终无未解决的本项测试失败。

## 限制、资源与回退

未运行实机数据库/SSH/SNMP、前端或生产发布：本项只冻结契约，不接入这些路径。Raw lineage 可以引用按保留策略未永久留存的原始项；示例不代表原始采集链已上线。摘要真实性、跨批唯一性/基数、实际 Counter/Derived 计算、聚合、路由与授权、告警执行均由下游实现并做集成验收；这不是将本项必需验收缺失移交下游。

硬预算未设定。实际 raw input、cached input、output、总吞吐和费用遥测不可用，未用内部计数冒充实测。主代理 1、子代理 0、最大深度 0、并发峰值 1。

回退：撤回新增 `apps/db-ops-api/src/contracts/metrics-v2/` 与 `docs/slide/metrics-v2/contracts/`；无运行时接线、数据库迁移或生产配置变化。PR 合并前不能宣称下游 main 依赖已满足。

## CI 修复复验

PR #76 首轮 CI（run `35311703522`）失败于 recovery-qualification 的
`assert-failover.ts`：任务已被旧 owner 领取，但 1 秒租约在后续查询时已到期，
`lease_expires_at` 与数据库 `NOW()` 同为 `2026-09-18T05:42:33Z`，返回空 claim。
本次不是 MAX-63 的文档目录问题；契约产物已位于 `docs/slide/metrics-v2/`。

接管 fixture 改用 30 秒租约，并只对本测试的记录显式设置可领取/已到期时间，
移除固定 sleep；保留活跃租约排他、接管 token 递增、旧 owner 拒绝及新 owner 完成断言。
未修改生产租约实现或放宽目录门禁。

- `bash scripts/qualification/run-environment.sh failover`：隔离 MySQL 8.4，101 项迁移、bootstrap、lease takeover 和 workflow fencing 通过，容器退出清理成功。
- `pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts src/contracts/metrics-v2/contracts.test.ts`：70/70 通过。
- `git diff --check`：通过。

以上为本地复验；远端 CI 状态以当前 PR head 的 checks 为准。回退该修复可撤回
`tests/qualification/assert-failover.ts` 的测试改动，无生产数据迁移。
