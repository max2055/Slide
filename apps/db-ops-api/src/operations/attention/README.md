# P05 / B08 多事件关联与排序

基准：implementation-1.2，SHA256 `459c81c1b67a3867db8ba181e91da6ebe075e8e676f5d77a3ff735ccae48e915`。基于已审定 main `4d40f1796c22ec292d9e49b126fd0ecdc931f914`，只读消费 operational event/admission/Investigation；不修改原 owner，不新建事件真相源，不派发调查、工具或模型调用。

## P10 装配

导出 `AttentionStore(poolProvider, contexts, relationEvidence, signatures, flags, clock)` 和 `registerAttentionRoutes(app, verifyToken, store)`。正式 server、迁移编号、公开契约和权限注册由 P10 负责。本包使用 P01 已有 `attention_correlation_snapshots`、`attention_snapshot_members`、outbox及正式 metrics control lock；没有额外迁移。

- 默认开关 `OPERATIONS_ATTENTION_ENABLED=false`，计算与人工 override 直接 API 均拒绝；停用后保留版本、审计和受 ACL 保护的历史读取，响应标明 unknown。另需装配 P02 context 与 P04 baseline 的当前 flags。
- 读取/计算要求 `operations:context:view` 和对应资源 read、数据库显式 grant；关联调查另核对原 owner/member、session、完整调查范围及 delegated ceiling。人工 override 另要求 `operations:context:manage` 和资源 manage，服务身份不能操作。
- `relationEvidence` 必须复用 P02 的权威证据 resolver，在同一 `RelationSession.connection` 锁定并检查确切版本/hash、资源范围、状态和有效期。默认 `unavailable`，绝不把未验证关系提升为事实。调用 P02 原有 graph 实时复核 confirmed、legacy 窗口和证据；所有根共享最多100边的保守遍历预算，最多2跳，partial 时停止继续扩大搜索。
- `signatures` 是部署端已知故障注册表，key 为 `operationsContentHash({code,callsite,kind})`，value 为版本化已知签名。任意相同文本、未知 code、correlationId、模型猜测都不能建立此关联；默认注册表为空。
- P04 `BaselineStore.read` 在当前连接读取最新资格、来源/config fence、资源替换重新累计边界及有效期。只消费 known/qualified 且具有有效偏离数值的版本；其余 baseline 分项为 null。分数使用绝对 deviationRatio，在1封顶。当前投影可反映新资格；`recordedScore` 保留该快照当时的不可变评分。
- P02/P04 通过窄的连接 lease 复用同一外层事务；只有外层拥有 begin/commit/rollback/release。异常整体回滚，嵌套工作不得逃逸或重试外部 IO。遵守 P04 `metric_policy_lock` 顺序。新版本必须先成功 commit，再开启新事务实时复核并同步 HTTP 发送；commit 失败不返回新版本成功。

## 内部 HTTP

所有接口经过既有 JWT verifyToken，响应 `private, no-store`，正文64KiB；为全局限流插件提供 POST 6/min、GET 60/min 配置。

- POST `/api/operations/attention`：`{observedAt:"...000Z", resources:[{type,id}]}`，1～20个互异资源。调用者不能传入事件、分数、qualification 或签名。按原发生时间锚定固定 UTC 15分钟窗口，从既有表读取；真实未来事件、引擎反馈事件、不可信/未授权 admission 被排除。允许回放积压，但超出原窗口后15分钟标为历史 unknown，不能冒充当前健康或新故障。
- GET `/api/operations/attention/:id?version=N&limit=20&cursor=...`：默认最新版本；稳定跨页须固定返回的 version。游标仅引用授权后的稳定组 ID，计数/排序均在权限过滤后进行，权限、资格或当前证据变化使旧游标409失效，重新获取第一页。每窗最多1000条已授权事件，单资源最多100条基线系列；超限503，绝不截断后声称完整。
- POST `/api/operations/attention/:id/overrides`：`{expectedVersion,reason,partitions:[[eventId,...],...]}`。必须恰好无重复地覆盖当前快照全部原事件，不能添加任意事件。单分区表示人工关联，多分区表示拆分；CAS并发只接受一个版本。原事件/调查ID保持，审计保存原版本、actor、reason及分区。迟到事件另存新版本，已有拆分继续有效，新到事件独立待审，不自动重新合并。

集合 ID 固定于 principal、请求资源和观测窗口，组 ID 通过旧成员交集延续，避免更早到达的迟到事件改变现有组身份。每次重算/override追加新版本及 outbox；GET 精确版本不改写历史。成员索引保留事件、调查和参与的关系/基线版本。`recordedReasons` 为保存时解释，只在其端点仍可读时返回；`reasons` 为当前仍有效的解释。证据失效时保留历史 score，移除当前事实路径并明确 unknown。

## 评分语义

先按 `critical > error > warning > info` 分层，同严重度按 score.lower 递减，再最早原事件时间、稳定ID升序。严重度归一为1、2/3、1/3、0并占50分；已确认影响20、观测持续性15、有效基线偏离15。纯评分器只接受[0,1]事实或null，不重新分配缺项权重；返回 lower/upper 和按已知权重计的 coverage。

现有 event/admission 没有可复用的已确认业务影响事实，本包诚实保留 impact=null、`impactStatus=unknown`，不按资源数量推测业务损失。持续性表示同窗已观测复发的首末跨度/15分钟；单个事件未知，不声称连续故障。多资源组只要有一个资源无有效基线，基线分项保持未知。关联不等因果，每组固定 `correlationIsCausation=false`。`partial` 和 missing 显示不完整证据，零值与unknown分开。

## 验证与回退

纯规则：`pnpm --filter slide-api exec vitest run src/operations/attention`。

真实 SQL/JWT/监听 HTTP：设置隔离 MySQL 的 `OPERATIONS_TEST_MYSQL_PORT`（可选 `OPERATIONS_TEST_MYSQL_PASSWORD`），运行同一命令。suite 使用完整正式迁移和真实生产 ingest、P02/P04、ACL、JWT、事务；输入事件、关系证明及长期基线窗口明确为 synthetic。新 suite 也接受现有 CI 的 `AGENT_RUN_TEST_MYSQL_PORT` / `AGENT_RUN_TEST_MYSQL_PASSWORD`，无需改动 P10 所有的共享 CI 文件。两种端口均未设置时SQL suite显式跳过。全 Operations 模块应使用 MySQL9.6，以覆盖 P04 已有真实 mysql-basic 来源门槛。

回退关闭 attention 新计算/override，保留所有原事件、调查、版本、成员索引和outbox；不DROP、不重放、不改原owner。P05无需连接VM、安装helper、目标动作或产品LLM。前端/视觉集成由P09，正式共享装配由P10，父任务独立审查与实际merge/main包含性仍是合入门槛。合成窗口不计14/28天，真实数据资格由P12继续核验。
