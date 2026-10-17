# P04 / B06 集成接口

P10 用平台 pool 装配 `BaselineStore`、`registerBaselineRoutes(app, verifyToken, store)`，注册 `operations:context:view`、P01 `behavior_baseline_versions` schema 和既有 outbox。默认 `OPERATIONS_BASELINES_ENABLED=false`；本包不注册 server、不分配迁移、不授予角色、不启动采集，也不修改告警。沿用全局 HTTP 安全插件；路由附加 POST 每分钟 6 次、GET 60 次限速配置。POST 正文上限 16 KiB。

- POST `/api/operations/baselines`：`{resource:{type,id},metric,dimensions,mode:'daily'|'weekly',staticThreshold?:{operator:'>'|'<',value}}`。阈值只用于报告对照，不写回任何告警规则。
- GET `/api/operations/baselines/:id`：读取最后一个不可变版本。服务端从持久对象取完整资源范围，实时检查调用者权限、原 delegation ceiling、session、目标存续及配置。响应 `private, no-store`。
- P05 通过 `store.read(actor,id, synchronousDeliver)` 消费 `id/version/contentHash` 和 `result`。仅 `status=known && state=qualified` 时使用 comparison；`unknown` 的异常值是 null，不可转 false 或正常。发送前最终检查在持锁事务内，`synchronousDeliver` 不得返回异步工作。
- `staticComparison` 独立于基线资格：只有历史不足而当前指标仍有效时继续输出静态对照；来源失效/过期/停用则同样 unknown。它只报告调用方给定阈值，不修改或覆盖既有告警配置。
- 版本包含方法、完整系列身份、训练/验证窗口、覆盖/有效天数/样本、分槽参考、排除依据和时间外报告。原 `contentHash` 标识保存的证据；GET 失效投影保留其引用、移除数值和 bands，不是新版本。回退关闭新计算，保留全部版本/outbox；旧对象读取仍需 ACL，返回 unknown，不 DROP 或重放。

## 算法与质量

`utc-hour-median-q10-q90/1.0.0` 固定 UTC 小时槽。日内窗口 14 天（7 天训练＋7 天验证）；周窗口 28 天（21＋7）。每个小时槽日内至少 7 个不同日期，周模式至少 3 个训练周；每一天和训练/验证各自覆盖均须 ≥90%。小时仅接受既有正式语义查询给出的有效精确标量，保留来源定义更严格的 `min_coverage`；不会放宽该定义来填充小时。部分质量仅允许纯缺口且覆盖达标的桶。连续 6 小时无有效桶使版本失效；不插值、不使用事后标签排除异常。

中位数和 10%/90% 分位来自训练窗口。时间外窗口超过半数小时在同一方向偏移，且偏移超过 `max(3×训练区间宽, 50%×abs(中位数), 1e-9)` 时严重漂移失效；孤立验证异常不改训练值。最新 gauge / counter rate 单独检查当前新鲜度、capability 有效期和质量，历史观测在采集时间检查迟到，不能把历史样本因“今天已陈旧”全部丢掉。

系列隔离包括资源、metric/semantic 版本、单位、dimensions、collector/binding、package/contract/transform/config 版本和 counter epoch。counter 复用 `metrics/query.aggregate` / `processCounter` 的精确累计计算，未知 epoch/回绕/质量/重置不推测 rate。目标地址/端口/已知身份变更后保存重新累计起点，不能重复重算就把旧观测恢复为 qualified。当前正式 generation/revision、asset 开关、策略/能力及最新正式值也纳入发送和缓存校验；这些状态变化后旧缓存只读 unknown。

首次计算在来源 IO 前后观察到目标身份变化时，即使没有历史版本，也在最终事务中保存 `targetSince`。该边界按资源跨 metric/dimensions/mode 继承，计算最终快照和缓存读取均检查训练起点；完整新目标窗口之前保持 unknown。JSON envelope 的内部 `resourceVersion` 在既有共享控制锁下递增，建立跨系列持久顺序，避免各系列独立版本号及 `created_at` 毫秒并列导致边界回退。旧 envelope 缺省为 0，首次追加后沿新顺序读取；不改写旧版本或 outbox，不需要新增迁移。

数据只来自集成 `MysqlFormalMetricStore.queryWindow`，不读 legacy、shadow 或旧 history。按天读取，超 1000 样本的区间递归拆分，最多 5000 查询/100000 个候选样本；超限为依赖不可用，绝不截断后宣称 qualified。此有界实现适用于常规分钟级采样；秒级长期序列可能触发上限，需由指标域提供有血缘的可流式历史聚合后再扩展，不增加第二采集或存储路径。

时间外报告包含两种规则各自 flags；真实标签缺失时固定 `labelledSamples=0`、误报率/重要漏报=null、`improvement=not_established`。本包合成窗口测试不计真实天数，短时真实 SQL 不计 14/28 天准入。P12 仍需真实长期观测和相同标注集完成 B07。

## 验证入口

纯算法和适配反例：`pnpm --filter slide-api exec vitest run src/operations/baselines/calculator.test.ts src/operations/baselines/source-adapter.test.ts`。

真实 SQL/JWT/HTTP：为隔离的 MySQL 9.6 设置 `OPERATIONS_TEST_MYSQL_PORT`（可选 `OPERATIONS_TEST_MYSQL_PASSWORD`），运行 `pnpm --filter slide-api exec vitest run src/operations/baselines --maxWorkers=1`。测试专属数据库由 fixture 建立和清理；不连接生产库。`P04_REAL_REPORT` 可指定证据 JSON 路径（相对 API cwd）。9.6 是当前 mysql-basic 包的实际支持版本，不能伪造目标版本用 8.4 替代真实来源验收。P10 的 CI 装配需保留此真实来源 gate；未设端口时 SQL suite 明确跳过。
