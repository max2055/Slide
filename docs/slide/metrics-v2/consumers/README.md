# MAX-75 消费边界与兼容迁移

## 范围与接口

`apps/db-ops-api/src/metrics-v2/consumers/` 将 MAX-68 `SemanticQueryService` 接入实际 Fastify API、Agent、告警和诊断；没有建立第二套聚合算法。基线 main `9ec6eae` 包含依赖 PR #81/#84/#85/#86。

- `POST /api/metrics-v2/query`：`{resource:{type,id},from?,to?,metric_ids?,view?,bucket_ms?}`。from/to 必须同时给出，使用 UTC 半开区间；默认一采集周期。默认 CoreProfile，显式 `canonical/extension/all` 或指标 ID；定义、版本、单位、时间策略由服务端绑定选择，客户端不能注入。
- `POST /api/metrics-v2/discover`：已授权资源的固定产品 profile、Canonical 定义、当前包 Extension 和有效能力/配置。模板不能重排 CoreProfile；配置缺失仍保留核心列。
- `POST /api/metrics-v2/inventory`：属性独立读取，例如 `db.version`，不伪装成数值指标。
- `POST /api/metrics-v2/evaluate`：`{query,policies}`，返回完全相同的指标结果及基于明确阈值的评估。该只读接口不发布配置或投递通知。`evaluation.ts` 同时支持 MAX-64 冻结的 AlertPolicy；恢复阈值和持续时间单独给出，缺失为 unknown。

所有接口先检查资源权限，再读取配置、维度或指标。Agent `query_metrics` 默认 Canonical first，支持跨资源显式引用、固定窗口、Extension 发现和查询。未知指标（包括包中没有的 InnoDB 指标）报错，不补造值。没有 actor 的直接工具调用拒绝。旧 ID 只经版本化等价映射转入新查询。

响应保留完整编码值（包括 uint64 字符串）、定义/口径、语义版本、quality/reason、accuracy、coverage、freshness、sources/versions、窗口、能力和最近尝试。缺失、停用、不支持、权限失败、能力未知和临时失败互不混淆。临时失败保留指标项；没有有效维度时不制造空维度时序。只允许按定义支持的操作聚合；例如不允许 rate 的计数器显式显示 `query_operation_unavailable`。

## 运行路径

- 三类列表加入固定产品 CoreProfile；资源详情默认展示标准指标和模板 Extension。旧概览/趋势折叠到明确标识的兼容区域，保留迁移期查询入口。
- `query_metrics` 和资源诊断包通过同一服务查询。诊断包仍有字节上限；证据超限明确要求缩小查询，不静默生成诊断值。
- 数据库、服务器、网络设备告警评估接入 `operational.ts`。已绑定 V2 时，缺失/权限/查询失败不退回旧数值，恢复也须通过完整质量及持续时间检查。规则阈值与模板采集设置分离。设备 reachability 保持独立的资源状态证据边界。
- `evaluation.ts` 默认只接受 exact、good、完整覆盖且最新 bucket fresh 的数值证据；显式策略可选择 partial/estimated/coverage。估算 CPU 不能隐式变成 Host CPU。整数超过现有告警数值表示范围时评估为 unknown，查询和 UI 仍保留精确字符串。

## 旧配置迁移与追溯

采用版本化的读取时适配，不修改数据库中的原始规则、阈值、持续时间、资源范围或旧 migration。`migration.ts` 为每次解释返回版本、resource、旧 ID、新 ID、状态和转换方式；新触发告警 tags 保存迁移记录。没有等价定义的引用标为 `review_required`，不会改成一个看似相近的指标。

| 旧引用 | 等价目标 / 决定 |
| --- | --- |
| MySQL connections | mysql.processlist.count；阈值仍为 count |
| PostgreSQL connections | postgresql.activity.count；保留 backend 口径 |
| Oracle connections / max_connections | oracle.sessions.count / oracle.processes.limit；绝不相除为会话使用率 |
| DM connections / max_connections | dameng.sessions.count / dameng.sessions.limit；本次不自动建立 ratio |
| MySQL qps | mysql.queries.per_second；新解释使用同一 epoch 的差分速率，记录映射 |
| server cpu_usage / memory_usage / load_1min | 对应 Linux Extension，保留单位和 Linux 口径 |
| network device_uptime_seconds / interface_in_bps / interface_out_bps | 对应 SNMP agent uptime / 分方向 bits_per_second |
| DB cpu_usage、disk_usage、未知旧 ID | review_required，禁止替换为 Host CPU 或容量比例 |
| 老动态基线规则 | review_required；不把旧历史 AVG 基线套到新语义 |
| 旧评分的连接使用率、慢查询等非连接检查 | 当前绑定没有冻结等价评分定义，显式 unknown/待复核；不沿用缺失补零或不匹配分母产生的健康分 |

旧评分策略本身保留；连接检查仍是独立连通性证据。V2 绑定资源可能因此显示“评分未知”，这是显式兼容行为，不能描述为已经迁移出新的等价评分公式。未绑定资源保留旧消费路径。没有自动修改或发布任何生产策略。

## 验证与限制

确定性 fixture：`fixtures.json`。合同测试直接调用真实查询服务和 Fastify 路由；浏览器测试启动真实 HTTP、Vite 和 Chromium，使用固定的内存观测存储，不依赖 LLM 或外部数据库采样。覆盖 UI/API/Agent/告警/评分一致性、授权、未知指标、单位/语义版本、缺失、stale、estimated、分母未知、临时失败和模板切换。

命令与结果见 `verification.md`。截图位于 `screenshots/1440.png`、`screenshots/375.png`。

维度发现目前沿用 JSON payload 查询并限制返回 100 个维度，使用请求窗口前一天作为发现范围；未进行生产容量性能验收。现有 opt-in MySQL/外部集成测试默认跳过，不表述为通过。未做真实生产采样、生产发布或通知 exactly-once 验收。

回退：回退本 PR 即恢复旧页面默认呈现及消费者入口；没有新 DDL、数据重写或不可逆配置迁移。保留原 V2 存储/包/策略及已有历史。未来如新增可证明的等价评分定义，应独立版本化并经同一 fixture 验证后替换 review_required 状态。
