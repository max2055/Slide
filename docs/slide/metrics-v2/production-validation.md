# MAX-85 生产接线验证记录

日期：2026-09-23。基线：`2da7b2d`。分支：`feat/max85-production`。

本批实现：应用生命周期、受控资产访问与在途变更检测、SNMP discovery 连续性、逐资源/序列 ticket 快照、Raw 与 Normalized 事务落库、正式消费者 shadow 隔离、迁移 102 及运维清单。完整 MAX-85 尚未交付；详细缺口见 `production.md`。

## 环境与证据

独立 Docker MySQL **8.4.10**、Alpine SSH **3.22.5**、本地模拟 UDP SNMP；Node **24.18.0**。未使用生产数据库、资产凭据或应用 `.env`，未执行生产切换。Linux/数据库/SNMP 既有隔离链路仍使用 fixture CollectorAccess，不能等同于生产 Access 的三类真实目标验证。

| 检查 | 结果 |
| --- | --- |
| 完整后端 `vitest run --maxWorkers=2`，设置隔离 MySQL/SSH 变量 | 290 文件通过、5 文件跳过；2,657 项通过、56 项环境相关跳过 |
| 最后资产/凭据在途校验补丁后的 `src/metrics-v2/config src/metrics-v2/scheduler --maxWorkers=1` | 7 文件、46 项通过；复用未受影响的完整门禁结果，未重复全套 |
| 前端三个指标组件测试 | 3 文件、21 项通过 |
| 实际 MySQL 098–102 全链新建与重复执行 | 通过，包含既有迁移修复测试 |
| 从 101 升级 102：ALTER 后中断、阻止直接重试、checksum-bound repair、回填与历史保持 | 1 项真实 MySQL 专项通过 |
| 桌面/移动端配置 UI + 实际 HTTP/MySQL + Linux SSH fixture | 2 文件、4 项通过；浏览器断言已与当前 main 的中文文案和放弃修改确认一致 |
| 后端类型检查（最后补丁后） | 通过 |
| 前端类型检查 / 构建 / CSP | 通过；2 个生产脚本通过 CSP。存在既有 chunk 大小和静态/动态 import 提示，无构建失败 |
| API contracts | 通过 |
| qualification matrix | 37/37 已映射，通过；映射通过不代表全部生产场景通过 |
| 秘密扫描（含已暂存新增文件） | 通过 |
| 部署安全静态不变量 | 通过，不等同于已部署到生产 |

计数不可相加：focused regression 与完整后端门禁有重叠。没有宣称 56 项跳过通过；没有宣称物理交换机、全部目标版本、生产峰值容量、生产灰度或真实业务回退通过。

## 行为回归覆盖

- 默认关闭、无效激活值拒绝、迁移前置校验、tick 不重叠、错误恢复与脱敏、关闭超时。
- 删除资产、错误凭据引用/资源身份、旧数据库连接目标与密码不一致、远程 IO 期间资产/凭据变化拒绝落库。
- 同一 SNMP 资产连续发现；其他资产、目标/凭据变化、淘汰、进程重启不会复用旧代次。
- 两个资源使用不同来源资格；只有明确登记且匹配 pin/revision 的序列进入正式 publications。
- 采集中 CAS 提升代次后，旧 ticket 不能借用新代次发布；失败事务不留下正式值。
- shadow、pending、legacy 模式不进入正式 V2 查询/维度；unknown 观测保留；回退不删除历史。
- Raw 证据独立 stage 存储并保留 Normalized lineage，Raw 不计作正式序列或 publication。

## 审阅与资源

按实际 diff 完成主线程自审；没有独立子代理审阅。子代理数 0、最大深度 0、代理并发峰值 1。硬预算未设定；raw input、cached input、output 与费用实际遥测不可用，不提供虚构估算。

本批作为 draft PR 交付，不合并、不发布。周期采集缺省关闭。完整生产任务保持进行中，不能因本记录的本地测试结果放量。

## 后续代码验证（2026-09-23，基于 72deeb5）

新增 PostgreSQL 原子 counter evidence、Linux 块设备生命周期发现，以及 shadow 不提前替换旧告警/评分输入的来源选择。未修改冻结的指标包或历史迁移；未合并、部署、切换生产来源。

### 实测环境与边界

- 独立 PostgreSQL 16.14 容器：真实生产 transport、普通登录采集角色、固定 SQL、pg_stat_reset 及超时连接释放，3 项通过。验证的是 transport；注册表原有 16.4 版本范围未扩展，不能计作 16.14 整包兼容通过。
- 独立 Alpine 3.22.5 SSH 容器，Linux 7.0.12-linuxkit：固定命令读取真实 boot ID、btime、diskseq 和 /proc/diskstats，经包 normalization 与语义 rate 查询验证，1 项通过。不是生产服务器或物理交换机验收。
- 独立 MySQL 8.4.10：来源状态选择、shadow、CAS、pending/applied、混合来源、回退与告警重放，9 项通过。
- 本次容器均为专用临时资源，未使用项目生产配置、既有数据库或真实资产凭据。

### 最终门禁

命令 `METRICS_V2_TEST_MYSQL_PORT=<isolated> METRICS_V2_TEST_PG_PORT=<isolated> METRICS_V2_TEST_SSH_PORT=<isolated> METRICS_V2_TEST_SSH_PASSWORD=<fixture> pnpm --filter slide-api exec vitest run --maxWorkers=2`：294 文件通过、5 文件跳过；2,693 项通过、56 项环境相关跳过。最终通过结果对应最新产品代码和测试。

前后端 typecheck、前端 build/CSP（2 个生产脚本）、contracts:check、qualification:matrix（37/37）、security:scan、security:deployment 均通过。前端保留原有 chunk/import 提示。未单独测量覆盖率；没有把映射、静态检查或跳过项算作生产验收。

首轮全套出现 9 项失败，根因为旧测试以数据库未连接的全局状态隐式选择 legacy；现已将这些 legacy 阈值/历史/加权评分用例显式隔离来源边界，并增加来源失联不触发/恢复告警的回归。真实 MySQL 来源选择测试未被 mock 替代。

完整任务仍未完成：其他 SQL/Host 网络 counter authority、其余旧写入者/消费者、停任务/排空/CAS/applied/回退协调器、真实版本/物理设备和峰值容量验收仍在待完成清单。剩余开发无需等待生产部署批准；不能因为本轮门禁通过就转为生产 GO。

资源口径沿用原记录：硬预算未设定，实际 token/费用遥测不可用，子代理 0、深度 0、并发峰值 1；未以分批实施重置预算或缩减 MAX-85 的原始验收。

## 旧写入 fence 检查点（2026-09-23，基于 6d0203d）

数据库、Linux Host 和网络设备旧采集链路现已在远程 IO 前检查资源来源，并在正式旧表提交时使用与 policy/rollout CAS 相同的事务锁再次检查。没有 rollout 登记的资源维持原行为；pending、mixed、V2 以及尚未 applied 的 legacy 回退均不产生新的旧正式指标。切换发生在远程 IO 期间时，晚到结果被最终 fence 丢弃，且不将资源误标为采集故障。

- 定向单元回归：5 个文件、63 项通过；覆盖三类采集器的 IO 前停止、三张旧表的提交 fence、回退 pending 和异常回滚。
- 独立 MySQL 8.4.10：rollout/fence 2 个文件、10 项通过；并发用例确认在途旧事务先于 CAS 完成，CAS 完成后的旧写入不能落库。
- 完整后端：293 个文件通过、8 个文件环境相关跳过；2,702 项通过、61 项环境相关跳过。未把跳过项计作通过。
- 后端 TypeScript、API contracts、qualification matrix（37/37）、秘密扫描和部署安全静态检查通过。前端未变化，复用 `6d0203d` 对应的前端类型检查、构建/CSP 和 CI 全绿证据，不重复运行。

该检查点关闭了已知三类旧指标写入竞态，但没有完成生产切换协调器、旧读取/诊断/Agent 全量接线或真实环境验收；生产状态仍为 NO-GO。

## 告警最终发布 fence 检查点（2026-09-24，基于 a8db9e3）

正式 Metrics V2 告警现在把 series hash、source、generation 和 revision 固化到告警标签及加密投递请求。通知 Worker 在调用 SMTP/Webhook 前核对当前 rollout、applied revision、告警 unread 状态和冻结 ticket，并持有与切换、回退、正式恢复相同的逐序列 MySQL named lock，直到外部调用结束。失效的排队任务标记为 skipped；发送前门禁不可用进入 retryable；已经调用外部渠道后的不确定结果继续使用既有 reconciliation 流程，不承诺 exactly-once。

- TDD RED：新增测试实际加载后因门禁模块不存在失败，提交 `732910c`。
- focused 单元/工作流回归：7 个文件、35 项通过。
- 独立 MySQL 8.4：rollout、旧写入 fence 与通知 fence 3 个文件、16 项通过；并发断言确认通知进行时 CAS 等待，完成切换后旧 generation 不执行发送。
- 最终后端全量 gate（未设置外部目标环境变量）：283 个文件通过、19 个文件环境相关跳过；2,645 项通过、124 项跳过。跳过项未计作生产验收通过。
- 后端 TypeScript 检查通过；本批未改前端，未重复前端门禁。

该检查点完成告警创建/恢复与最终外部发布的 generation fencing，但不等同于完成切换协调器、全部消费者迁移或真实生产告警渠道验收；生产状态仍为 NO-GO。

## 资源观测消费边界检查点（2026-09-24，基于 628b464）

资源 overview、metrics summary、diagnose 以及 `diagnose_resource` Agent 现在通过同一个 source-state 包装器读取旧 observations。只有整个资源仍为 applied legacy 时调用旧表 reader；pending、mixed、V2 或来源状态查询失败均不会回退到旧观测。V2 诊断证据继续走已有正式 `semanticMetrics`；overview/summary 的旧字段在 V2 下保持缺失，等待 canonical UI 迁移，不用同名字段伪造等价语义。

- TDD RED：4 项用例因 source-controlled 入口不存在而失败，提交 `af5c72e`。
- GREEN focused：资源 summary、诊断、Agent 诊断和标准 Agent 查询 5 个文件、28 项通过；后端 TypeScript 检查通过。
- 最终后端全量 gate（未设置外部目标环境变量）：284 个文件通过、19 个文件环境相关跳过；2,649 项通过、124 项跳过。前一检查点的 contracts、qualification、秘密扫描和部署安全检查所覆盖输入未变化，复用其通过结果。

该检查点关闭了共享资源诊断入口的 legacy 混读，但未覆盖旧 baseline、report、直接历史 API 或 canonical UI 展示；生产状态仍为 NO-GO。

## Rollout 协调器检查点（2026-09-24，基于 7bc5973 / ecb558d）

新增迁移 103 和逐资源协调器，将服务端 shadow evidence、停止新任务、在途排空、逐序列告警锁、策略锁、CAS 切换、applied 确认及更高代次回退串成可恢复状态机。资源 API 只接受资源与预期 revision，不接受目标、凭据、SQL、命令、OID 或客户端 series。回退后 Scheduler 不再入队；superseded job 不会抢占新 revision。

- rollout、调度与 API focused：10 个文件、57 项通过。
- 独立 MySQL 协调器与旧写入并发：13 项通过；切换/回退与旧事务按相同锁顺序收敛。
- 回退保留 V2 历史及审计，不删除表、不降低 generation/revision、不重算历史。

## 正式来源读取与 UI 检查点（2026-09-24，基于 bcb01f3 / ce23d8b）

新增统一正式来源路由器，legacy、V2 与 pending/mixed 严格单选。实例实时及历史 API 在 V2 下返回完整 semantic response；前端来源切换时清除旧缓存并交给 canonical 组件展示，不把 V2 强制映射为旧字段。

- 来源路由器与实例 API：12 项通过。
- 前端来源切换及 canonical UI：6 项通过。
- 前后端 TypeScript 检查通过。

## Baseline 与报表检查点（2026-09-24，基于 26b5a92）

legacy baseline 的计算和缓存读取先检查正式来源；V2 返回 `METRIC_V2_BASELINE_UNAVAILABLE`，pending 返回 `METRIC_SOURCE_PENDING` 或不暴露缓存。health/performance/capacity 报表在统一入口分流，V2 使用 `view=all` 并原样保存 semantic response，HTML 展示单位、维度、质量、原因、freshness、coverage 与来源；slow-query 保持独立路径。

- baseline/report focused：2 个文件、16 项通过，其中行为测试确认 pending 不创建报表、V2 不调用 legacy metrics/slow-query reader。
- 报表调度、实例指标 API 与 baseline 受影响回归：5 个文件、70 项通过。
- 后端 TypeScript 与 `git diff --check` 通过。

至此仓库内已盘点的正式指标写入和消费入口均已接入来源控制，开发候选进入最终集成门禁。真实生产等价数据库/Linux/物理网络设备、峰值容量、实际 package pin/凭据权限、分批 shadow/cutover 及真实回退仍未执行，因此生产状态继续为 **NO-GO**。

## 最终开发候选门禁（2026-09-24）

- 完整后端：287 个文件、2,666 项通过；20 个文件、127 项环境条件跳过。未设置生产或真实目标凭据，跳过项不计作通过。
- 完整前端：80 个文件、537 项通过；TypeScript 检查通过；Vite 生产构建及 2 个 CSP 脚本通过。保留既有 chunk 大小和静态/动态 import 提示，无构建失败。
- 后端 TypeScript、文档结构 11/11、API contracts、qualification matrix 37/37、秘密扫描、部署安全静态不变量及 `git diff --check` 通过。
- 两张配置 UI 证据截图被既有测试重写，作为与本任务无关的工作树差异未提交；`.multica/` 运行时文件未提交。

该门禁证明当前分支达到代码审阅候选标准，不证明真实生产目标、物理网络设备、峰值容量、生产告警渠道或真实灰度/回退通过。生产放量必须继续遵守 `production.md` 的门槛与授权要求。
