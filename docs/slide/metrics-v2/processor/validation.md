# MAX-66 验收记录

2026-09-18；分支 `agent/15astra/max66-processor`，基于 main `980d236d62533423d7fad811dd01e69c2337d588`。前置 MAX-64 [PR #76](https://github.com/max2055/Slide/pull/76) 已于 2026-09-18 05:53:23 UTC 合并；平台 PR 关联表为空，因此另用 GitHub mergedAt/mergeCommit 及 git fetch 确认。当前交付 commit/PR 链接见任务最终评论，不以未合并分支作为下游 main 依赖已完成的证据。

## 交付与验收映射

|验收|实现/证据（仓库相对路径）|
|---|---|
|首样本无 rate、真实时间差、缺口|`apps/db-ops-api/src/metrics-v2/counter.ts`；`docs/slide/metrics-v2/processor/fixtures.json` 的 actual-elapsed / fractional-seconds / long-gap|
|重启、来源切换/切回、位宽、转换版本及维度|`processor.test.ts` 的 baseline transitions、共享 rate 节点升级版本测试|
|重复、同时间新 attempt、乱序不推进|`processor.test.ts` 的 duplicate/equal-time/late 测试；receipt 重放见 `state.test.ts`|
|32 位 wrap 有证据才恢复、多次不确定 wrap|fixtures 的 proven/unproven/ambiguous/hidden/wrap-without-bound；持续证据测试|
|64 位超过 2^53、接近 2^64、转换前精度|fixtures 大整数样例；精确 delta、Raw ms→s 差分测试；拒绝 Number 编码的 raw counter|
|单位转换、冲突和最终编码精度|`arithmetic.ts`、`observation.ts`；s/ms 等价、单位冲突、整数范围和 IEEE 极值测试|
|ratio 分母零/缺失不造零、依赖失败|`derived.ts`；ratio、missing/invalid、下游 null 传播测试|
|受限 DAG、时间窗口、来源与转换版本血缘|拓扑排序、循环/未知依赖/脚本/多源拒绝、窗口偏差、input_provenance 和 MAX-64 validator 校验|
|estimated/stale 等传播，derived 保持 exact|精确 ratio、accuracy 最差输入、独立 freshness 测试|
|多 worker 所有权、重放和持久化边界|`state.ts` 接口、`state.test.ts` 单线程模型、README 中 CAS/fencing/receipt/namespace 规则|

表内无前缀的代码文件均位于 `apps/db-ops-api/src/metrics-v2/`。全部生成观测经过现有 `validateObservation`；有效普通派生样例另经过 `validateDerivedObservation` 和 `validateLineage`。

## 本地命令与结果

从仓库根目录运行：

|命令|结果|
|---|---|
|`pnpm install --frozen-lockfile`|通过，无锁文件变更|
|`pnpm --filter slide-api exec vitest run src/metrics-v2`|51/51 通过|
|`pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts src/contracts/metrics-v2/contracts.test.ts src/metrics-v2`|121/121 通过（处理器 51、契约 59、目录 11）|
|`pnpm --filter slide-api test`|265 文件通过、4 文件跳过；2383 通过、55 跳过；最终实现 8.42 秒|
|`pnpm --filter slide-api typecheck`|通过|
|`pnpm exec oxlint apps/db-ops-api/src/metrics-v2`|0 warning、0 error|
|`pnpm contracts:check`|通过；旧 API 未变更|
|`git diff --check`|通过|

开发过程先验证 counter 测试因缺少实现失败，之后按模块回归；最终 gate 后不因汇报重复运行整套测试。未运行真实数据库/双 worker/生产发布验收，不能将 55 项跳过或内存模型当作这些能力通过。

## 附加旧盘点校验的既有失败

`python3 docs/slide/metrics-v2/v1/verify.py` **未通过完整快照一致性断言**：仅 `apps/db-ops-api/server.ts` 的 source_sha256 和 references 行号与 MAX-63 冻结 inventory 不同。读取最新 snapshot 后逐项比对，当前 server.ts 的 SHA-256 与 `git show origin/main:apps/db-ops-api/server.ts` 完全相同；本任务未修改该文件。属于 main 已有漂移，不刷新历史 inventory、不放宽门禁，不扩展为本项整改。

独立调用该脚本的 `verify(snapshot())` 通过：64 registry identities、65 provider cases、70 realtime fields、55 referenced files、三类资源 fixture、映射覆盖/路径/算术/负例。此结果**不替代**上述完整 snapshot 命令的失败。

可复核：使用 Python importlib 按仓库相对路径载入 verify.py，比较 `snapshot()` 与 inventory.json；再运行 `verify(snapshot())`。新处理器不进入该 legacy 正则盘点，也未改变被盘点的源文件。

## 限制、交接和回退

- 没有运行时接入、数据库迁移、生产配置或发布；MAX-67 接模板，MAX-70 接持久化/调度，MAX-76 做全链路。受限标量 DAG 不实现分布聚合。
- 32 位增长上界和 discontinuity 由可信驱动提供；缺证据保守返回 null。输入载荷冲突、生产原子性、fencing 和持久化 receipt 由适配器实现并真实验收。
- 本项仅新增两个目录，回退撤回提交即可；现有旧采集逻辑未修改。未来接入升级/回退必须改变版本/revision 并重建基线。
- CI 是 PR 推送后的外部任务，状态以最终交付评论/PR 为准；本地通过不等于 CI 通过。PR 未合并时不启动依赖本项 main 的下游实现。
- 硬预算未设定；实际 raw input/cached input/output/费用遥测不可用，未虚构估算或实测。子代理 0、最大深度 0、并发峰值 1。
