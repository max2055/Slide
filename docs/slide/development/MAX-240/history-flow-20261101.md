# MAX-240 历史读侧候选与验收边界

日期：2026-11-01。任务起点 `902ea13c06d287171575d45fa2ad362d55c08f77`，PR #568；保留原 RAW-PAGE 实现。整合 MAX-239 PR #570 实际安全头 `0a9eec2e13b03c7665c025080fce799f769247fe`（其 base `88fc15e2bce814218ff2f1836a33d57ff236eef6`），合并提交 `24d078bc6`。该依赖已有持久化 episode、事件 writer 和配置快照；不能继续按“episode 仅内存”判断。

## 实现与可验证行为

| 用户路径 | 读侧实现与证据 |
| --- | --- |
| 24h 首尾及原始分页 | 保留 keyset 全窗口读取、原始分页游标/顺序/total/has_more。真实 MySQL HTTP 测试检查 1440 槽、边界、重复时间戳、不同分页大小及超限拒绝；不静默截断。 |
| 数值/图形、缺口、峰值 | 同一资源、指标语义版本、维度、窗口；缺口为 null，保留 count/min/max/avg。浏览器覆盖 6h/24h/7d/自定义及快速切换，三种桌面尺寸。 |
| 停用、解绑、改名 | `history:true` 使用当前正式围栏或已持久接受的 resource/revision/generation；publication 与观测 ID/series_hash 精确一致，仍排除 shadow、未接受修订及 generation。解绑后不要求当前模板继续存在。当前读、最新容量及 baseline 保留原围栏。真实 MySQL 测试包含停用和解绑；浏览器在隔离 schema 内改名、解绑后读历史。没有执行真实目标解绑。 |
| 稳定身份与版本 | series identity 不含显示名或 package version；同指标不同已安装 semantic_version 分列，不拼曲线。安装目录以外的已卸载定义没有新建第二套持久目录。 |
| 权限撤销 | 每次历史查询和原始页开始及所有存储等待结束后重新认证/授权；生产 runtime 使用 actorContextService.revalidateActor。无事件权限清除事件区段；HTTP private,no-store。单测包含等待中撤权，真实 JWT 浏览器包含撤权后清屏与 403。 |
| 当时阈值/事件 | 按窗口正式样本 config_revision 读取并校验 immutable trigger snapshot；缺快照显示未知，不拿当前参数回填。只在含对应修订观测的桶画简单 last 阈值，复杂条件保留表达式。问题/未知区段读现有持久 episode；事件详情按需加载现有真实 API。真实 MySQL 验证快照不变、半开窗口、缺失及篡改拒绝。浏览器 fixture 使用现有编译器、评估器和事件 writer，通知渠道禁用。 |
| 旧成功与当前失败 | 原已实现的当前状态、最后尝试、失败原因、正式成功时间与旧成功值继续并列；旧值灰化。浏览器真实 API 对照失败 attempt 与旧成功时间，曲线继续可见。单位不符/部分/无数据等边界由语义组件与 query 测试覆盖。 |
| 保留策略 | 返回配置的 raw/history/attempt 时长与清理实际启用条件（enabled 且 apply）；这不是已有数据覆盖承诺。不加入后台历史核验轮询。 |

历史采样采用显式假设：60 秒 interval、180 秒最大 counter gap。响应 `sampling.basis=explicit_history_assumption`，界面说明未还原每个旧配置的采样周期。这样当前 interval 变化不会重写历史计算假设，但不能作为历史真实采样配置的证明。

## 可复现检查

使用仓库 pnpm 11.19.0。真实数据库测试仅针对任务自建、非 3306、可销毁 MySQL；浏览器 harness 启动自己的服务、登录真实 JWT、最后关闭进程和删除 schema，并断言产品模型调用为 0。

```bash
pnpm --filter slide-api exec vitest run src/metrics src/contracts src/alert-event-service.test.ts
pnpm --filter slide-api exec vitest run src/auth src/resources/resource-service.test.ts src/security/server-instance-authorization.test.ts src/alert-event-access.test.ts
METRICS_TEST_MYSQL_PORT=58362 pnpm --filter slide-api exec vitest run src/metrics/rollout/history-window.mysql.test.ts src/metrics/consumers/history-context.mysql.test.ts
MAX240_CAPACITY=1 METRICS_TEST_MYSQL_PORT=58362 MAX240_CAPACITY_REPORT="$PWD/outputs/max240-capacity-final.json" pnpm --filter slide-api exec vitest run src/metrics/rollout/history-capacity.mysql.test.ts
MAX240_TEST_MYSQL_PORT=58362 MAX240_TEST_API_PORT=58400 MAX240_TEST_WS_PORT=58401 pnpm --filter slide-frontend exec playwright test -c playwright.max240.config.ts
pnpm --filter slide-frontend test
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
git diff --check
```

端口是本次隔离环境的实测值；复现者需自行准备一次性 MySQL 并选择未占用端口，不能连接共享应用库。容量测试另要求显式开关，常规门禁不会自动生成大样本。

实测结果：后端受影响模块 79 文件 / 1097 项通过（57 文件 / 243 项环境门控跳过）；认证与资源权限 16 文件 / 274 项通过（1 文件 / 8 项真实库门控跳过）；另有真实 MySQL 历史与快照 6 项、容量 1 项、真实 JWT 浏览器 5 项通过。前端全量 151 文件 / 1399 项通过，类型、构建/CSP、契约及改动文件 lint 通过。集成时修正静态安全测试仍查找已迁移旧事件 GET 路由的问题，保持对共享读路由资源范围及手工创建写权限的检查。独立复核尚未发生。

## 容量实测

500 服务器、100 数据库、50 网络设备；每资源 1 条序列，60 秒采样、24h，共实际写入并 COUNT 确认 936000 条归一化观测及对应 publication。Node v24.18.0、macOS、Docker MySQL 8.4.10。4 并发，三类资源各抽 10 个，共 30 次真实 HTTP 历史查询：全部 200、1440 槽，错误 0、截断 0、截断率 0；p50 609.98ms、p95 1022.92ms、p99/max 1028.96ms。写入耗时 172294.96ms。

information_schema 表空间估计：observations data 1330348032 / index 391102464 字节，publications data 225427456 / index 144703488 字节。TABLE_ROWS 是 InnoDB 估计，不能替代实际 COUNT。只测合成契约样本的真实数据库与 HTTP 读侧；未验证 650 个真实采集器并发、每资源多指标、长期保留全量、生产硬件或 SLO。

## 未完成接口与责任边界

以下仍属于完整用户流程的未完成部分，不以本候选宣称整单完成；由 Chief 独立复核并协调对应 owner 接续。

1. **维护历史区段，owner P2/MAX-244**（Chief 2026-11-01 更正归属）：当前 `apps/db-ops-api/src/metrics/triggers/runtime.ts` 的 snapshot/episode 路径没有可读的持久维护有效区段。等待 MAX-244 的正式持久有效区段契约及写入证据；不指派 MAX-239 实现整套维护治理。本项在 `metrics/consumers/history-context.ts` 消费并在 `semantic-metrics.ts` 渲染；不能把当前静默状态推测成历史区段。
2. **同窗口 AI 草案入口，owner MAX-242**：`frontend/src/app/ui/components/investigation-create.ts` 的资源/时间选择是内部状态，`resource-investigation-links.ts` 链接仅保留资源。需要提供公开预填入口，例如 `initialContext: {resourceRefs;timeWindow:{from;to};metric;dimensions;sourceEventIds}`，或等价路由契约。本项再传当前上下文；不得仅跳到未保留窗口的页面假称完成，也不应自动调用模型。
3. **精确历史采样配置，owner MAX-238**：任意旧配置的 resolved sampling 设置没有本项可消费的不可变历史查询口；如需按真实旧 interval/max gap 计算，需提供 `readConfigurationAt(ref: Ref, revision: number)` 返回已解析 settings 与有效依据。当前明确使用上述采样假设，未以当前参数补历史。

独立安全/跨模块复核由 Chief 承担；本实现方检查不能替代该复核。本候选不合并、不部署、不改共享 3306、不外发通知、不调用产品模型。最终准确源码 SHA、PR head/base、测试汇总、证据哈希与处置记录随任务附件交付。
