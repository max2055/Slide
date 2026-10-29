# MAX238-COLLECTION-DISPLAY-E2E-R1：原生模板挂到真实对象并采集、正式发布、页面显示

2026-10-29。**一句话结论**：已转换的 MySQL 原生模板（上游模板 uuid `e19c120027e04da69b130e0f6cea29fc`）以一个**新发布的不可变版本**挂到已纳管实例 `mysql3306`（`instance:1`），经真实 HTTP 试采 → 事务应用 → 调度执行 → 正式化 → 最新数据 API → 浏览器页面，页面显示的 `78602 s @ 2026-10-29T15:15:15.334Z` 与页面自身 `/api/metrics/query` 响应里同一条观测（同 value/observed_at/unit/quality/revision/package）完全一致。**这不是 MAX238 整单完成**：绑定/应用的范围剩余项（见 §8）仍未验收。

机器证据：[native-template-chain-20261029.json](native-template-chain-20261029.json)。截图随交付评论附上。

## 1. 环境（隔离平台库 + 真实目标）

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-238` |
| 实现提交 | `afb1f3d3e` 起的本包提交（见交付评论列出） |
| 平台库 | 一次性 MySQL 8.4.10，`127.0.0.1:13306`，库 `slide_max238_r1`；从空库跑完整 migration（含新 `135_metric_template_binding_storage.sql`） |
| 目标 | 真实 `mysql3306`：`localhost:3306`，MySQL **9.6.0**，库 `db_ops_ai`；只读采集 |
| 对象身份 | 从共享开发库**只读复制**已纳管 `database_instances` 行（id=1、名称、地址、版本、加密凭据列）到隔离库；没有新建同名目标 |
| 模板 | 三份 MAX237 已接受模板行一并复制进隔离库；MySQL 模板再以本包新接口发布版本 2 |
| 运行 | 真实 `apps/db-ops-api/server.ts`（127.0.0.1:3001）+ 真实 Vite（127.0.0.1:5173，`/api` 代理到 3001） |
| 未包含 | 无明文密码/令牌进入证据；平台库与共享 3306 的既有绑定未被改写（本包所有写入都在隔离库） |

服务器 3（`192.168.49.130`）本轮仍未连通；按指令使用已有 mysql3306 目标。

## 2. 版本兼容：新模板版本固定既有适用 release

模板版本 1 的 Uptime 项固定 `mysql-basic@1.0.0`（`sha256:f35d9c93…`），其 applicability 为 MySQL 5.7/8.0/8.4；目标是 9.6.0，因此：

- `POST /api/metrics/templates/e19c120027e04da69b130e0f6cea29fc/repin` → 新发布**模板版本 2**，只把该 item 重钉到已安装的 `mysql-basic@2.0.0`（`sha256:a38519cb…`，实现 `builtin:mysql.status.v2`，同一 `raw_field=Uptime`、输入/输出单位 `s`）。
- 版本 1 与 item 版本 1 **原样保留**（不可变）；`current` 指针指向版本 2。
- 语义核对由已接受的模板服务完成（metric/unit/dimensions/实现映射），未改任何 release、未放宽 applicability、未删除断言。

| 对象 | 值 |
|---|---|
| 模板版本 1 | `content_hash = sha256:4db4800495…`（保留） |
| 模板版本 2 | `content_hash = sha256:1f9bd5626c774543b1db166c6f836ae3986f145fbffb62c1ef3dfdf85d95077e` |
| item 版本 1 | `8fbad224ebdf46e7b25a0be015f21972@1` → `mysql-basic@1.0.0` / `builtin:mysql.status.v1` |
| item 版本 2 | `8fbad224ebdf46e7b25a0be015f21972@2` → `mysql-basic@2.0.0#sha256:a38519cb…` / `builtin:mysql.status.v2` |

## 3. 绑定 / 试采 / 应用（真实接口，非 stub）

| 步骤 | 请求 | 结果 |
|---|---|---|
| 预览 | `POST /api/metrics/template-bindings/instance/1/preview`，pin = 版本 2 | `executable=true`；release `mysql-basic@2.0.0#sha256:a38519cb…`；`db.engine=mysql`、`db.version=9.6` 均 supported；item 决策 `collect`；`resolution_identity=sha256:6484c2c3…` |
| 对比：版本 1 | 同接口，pin = 版本 1 | `executable=false`；`db.version=9.6.0 unsupported`；item 决策 `unsupported`（**不适用的 pin 被拒绝**，没有静默降级） |
| 试采 | `POST …/trial`，`receipt_id=max238-r1-trial-c2b4694c` | `decision=attempted`；真实读取 `db.uptime_seconds = 77878 s`（good）；read/transform/unit 三阶段均 true；写入 v2 receipt |
| 应用 | `POST …/apply`，`caller_key=max238-r1-apply-2` + 同一 receipt | `committed`，`revision=5`；`templates-v1` payload + 操作行 + 审计同一事务 |

绑定行（`metric_policy_bindings.resource_key='instance:1'`）：

- `envelope=templates-v1`，`binding.revision=5`，`template_pins=[e19c12…@2 content_hash 1f9bd5…]`；
- `template_resolution.pending.resolution_identity=sha256:e9b63696…`，plan `executable=true`，release `mysql-basic@2.0.0`，collector `mysql-status`，metric `db.uptime_seconds@1.0.0`；
- `application.status=pending`、`applied_revision=4`（已接受 codec 规定 `applied_revision ≤ base`：pending 计划是本次要执行的配置，旧包 revision 4 仍是上一份已应用配置——**没有把 pending 说成 applied**）。

## 4. 调度 / 正式写入

- 模板行进入既有调度器（同一 `metrics.collect` 队列、同一 worker 租约/围栏、同一调度表），执行的是 plan 自带的 release/collector/metric 选择，**不是**整包重编译：`mysql-status` 每 60s 对目标执行一次只读 `SHOW GLOBAL STATUS`。
- 提交路径：身份校验（`config_revision=5`、resource、`package_id/version` 必须等于 plan 的精确 release）→ 正式化（`metric_rollout` 行 pin = `mysql-basic@2.0.0`、generation 2）→ `RolloutControl.publish` 写 `metric_publications`。
- 证据：`metric_schedule_events` 对 `instance:1` 全部 `committed`（15 次）；`metric_rollout` 1 条 semantic/semantic、`published_revision=applied_revision=5`；`metric_publications` 该资源 8 条；`metric_source_acceptance` revision 5 记录 `template_binding=true`、1 个样本、plan identity。

同一条观测：

| 字段 | 值 |
|---|---|
| observation id | `sha256:64529ebfec667e98f7407f3cc6532ac181d65952a02a6603cb311785bbbc5526` |
| observed_at | `2026-10-29T15:15:15.334Z` |
| metric | `db.uptime_seconds@1.0.0` |
| value / unit | `78602` / `s`，quality `good` |
| package | `mysql-basic@2.0.0`，`versions.config_revision=5` |

## 5. 最新数据 API 对照

`POST /api/metrics/query {"resource":{"type":"instance","id":1},"view":"all"}`（真实 HTTP，真实平台库）→ `configuration_revision=5`，`db.uptime_seconds` `state=available`、`enabled=true`、`capability=supported`，bucket 值 `78602 s @ 2026-10-29T15:15:15.334Z`，来源 `versions.package_id=mysql-basic`、`package_version=2.0.0`、`config_revision=5`。模板行不再返回 409 `TEMPLATE_BINDING_UNSUPPORTED`，消费者按 plan 读取 settings/items/release。

## 6. 页面（Web Component，同一条观测）

真实 Vite 页面，登录后 `Databases → mysql3306 → 指标与趋势`：

- 页面标题 `数据库运行时长 · db.uptime_seconds`，状态 `可用`，值 **`78602 s`**，观测时间 **`2026/10/29 23:15:15`**（Asia/Shanghai，即 `15:15:15Z`），徽标 `良好 / 新鲜 / 精确`。
- 页面自身发出的 `/api/metrics/query` 响应由 Playwright 捕获，同一 `observed_at=2026-10-29T15:15:15.334Z`、`value=78602`、`unit=s`、`quality=good`、`package_id=mysql-basic`、`package_version=2.0.0`、`config_revision=5`。
- 文本用穿透 shadow DOM 的遍历读取（`element.shadowRoot` 递归），不是 `body.innerText`；截图与响应同一次页面加载。

截图：`max238-r1-metrics.png`（指标与趋势），`max238-r1-databases.png`（实例列表），`max238-r1-instance.png`（实例详情）。

## 7. 本包必要接线（代码）

| 位置 | 变更 |
|---|---|
| `src/metrics/templates/*`（自 MAX237 `a2c665cc9` 逐字节引入） | 模板领域、MySQL 仓库、版本发布服务、三份固定转换 |
| `sql/migrations/135_metric_template_binding_storage.sql` | 新增 5 张模板表 + B2E 操作/回执表（全部 `CREATE TABLE IF NOT EXISTS`，仅增不改） |
| `src/metrics/templates/{binding-service,repin,routes}.ts` | 持久模板版本读取 → preflight→compile→resolve→plan；真实试采 + v2 receipt；host 应用；版本重钉；只读目录/版本接口 |
| `src/metrics/bindings/package-reader.ts` | template 行返回解码后的 envelope（旧读者仍只看到 `source` 判别并拒绝） |
| `src/metrics/scheduler/{store,service}.ts` | 模板行按 plan 执行（每 release 一次 `runPackage`，plan 的 collector/metric 选择）、围栏提交、raw+normalized 正式写入、发布票据 |
| `src/metrics/rollout/formalization.ts` | 模板行正式化：按样本自身的精确 release 建 rollout（pin/generation/acceptance），无 legacy 对比 |
| `src/metrics/consumers/{service,runtime}.ts` | 最新数据读取模板 plan（settings/items/release），不再 409 |
| `server.ts` | 注册 `/api/metrics/templates*` 与 `/api/metrics/template-bindings/*` |

## 8. 明确未完成 / 未验收

- `application.applied_revision` 仍指向上一份配置：已接受 codec 不允许把 pending 计划标成 applied；模板应用的“已应用”展示（状态页/UI）未接。
- 模板绑定的 **状态读接口** 已有（`GET /api/metrics/template-bindings/:type/:id`），页面尚未使用；页面只验证了最新数据与趋势。
- 多 release 模板（Linux/华为模板）未在真实对象上执行；服务器 3 不可达、网络设备按既有决定不验。
- 模板正式化的 legacy 对比、容量、24h、迁移演练、触发/恢复、通知、AI 闭环均不在本段。
- 重钉是维护操作（HTTP 接口 + 服务层校验），没有做通用模板编辑器 UI。
