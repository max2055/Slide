# MAX-192 最终集成验收（2026-10-17）

本记录针对主任务 MAX-188 的统一指标整改，按 R2 方案和已批准 R1 原型验收。最终交付仍须 Chief 对本 PR 独立审查、正常合入及记录最终 merge SHA；本记录不表示生产部署或生产迁移已执行。后续准确 PR head 的完整 CI 结果随 Multica 最终评论附件交付，不能把下列前序 CI 当成本 PR 的结果。

## 版本与证据有效性

- 干净基线 main `520f8fb78781ea48a3865259dd30de930372eab4`，即 C PR208 merge；A/B PR202 head `d42bd05a9311b4ca1eadb17131da8b7943dc2175`，merge `3b309a7b6387c5946c9ae818ab9dc04cfdee0bf2`。B PR200 提交已是该主线祖先，不另做重复合并。
- 已直接读取 GitHub：A/B CI38998242264、C CI39002710905 均为准确 head 完整14项成功；Multica PR208 快照确认 merged、14成功、0失败、0运行。Chief 的 A 兼容收口、B R1复审、C批量源码/权限/恢复/R1审查见各原交付线程。
- 本次生产增量只有 `127_metric_schema_descriptions.sql` 的三个表注释和一个列注释；列类型、排序规则、业务数据、配置和运行时实现不变。其余为 qualification、迁移文档和本报告。真实 SQL/VM、认证 UI 三周期、字段一致性和 R1证据按交接复用，不重复认证或实采。
- 新增迁移与恢复实测源码 `cee4e79e1cba2f977aef6141e8f5aad3057cee5e`；之后新增命名扫描工具 `c0d68ca4` 不改变运行源码。最终 diff 可核对，不含原工作区用户快照、AGENTS 修改或旧发布包。
- 原型 SHA256 `ab49721cb37448222295b526cd6c1744b94e2b5b546596c5f2f0ad4416ae6074`，用户已批准；不增加人工听读门禁。

## 逐项验收矩阵

“通过”指所列范围及证据；受控 UI、fixture 和隔离恢复均显式标注，不代替真实目标验收。

| 需求/原审计问题 | 结论 | 可核查证据及边界 |
|---|---|---|
| 1 发布→调度→正式查询，不能只看attempt/raw | 通过 | A真实 MySQL4周期、VM8周期及 B完整JWT认证导航三周期；唯一正式 query 出值，来源门禁保留。B `e556eba1` 安全JSON `checks.threeFormalCycles=true`、`formalCycles=3`，不是health探针 |
| 1 全局关闭阻塞、发布/应用/正式分层 | 通过 | configuration-status五层契约、R1受控状态矩阵、scheduler lifecycle实测；`METRICS_COLLECTION_ENABLED`严格布尔且默认关闭，不读取旧变量fallback |
| 2 资产停用优先、在途复核、启用/重启恢复 | 通过（能力边界保留） | A现有来源实测报告：VM停用attempt 0→0、再暂停40→40；恢复后last_success与正式观测推进。VM网络counter缺epoch仍failed/unknown；C显式linux-basic正式可见，不称全指标成功 |
| 3 绑定、执行、正式数据及覆盖独立呈现 | 通过 | B真实列表/详情/设置字段一致性、C混合结果；linux-basic磁盘/网络为未覆盖。容量按实际包和正式结果显示，不套用旧包不支持结论 |
| 4 按资源/引擎/版本/能力推荐 | 通过 | MySQL9.6代表路径、旧基础包不兼容受控场景、模板真实覆盖摘要；PG/Oracle/DM仅fixture兼容验证 |
| 5 编辑主入口、详情摘要、设置全局治理 | 通过 | B三类页内基本信息/监控与采集、详情打开同一编辑器；真实导航及修改保护/焦点证据，未新增第二配置源 |
| 5 加载/错误/权限/未知反馈、有界刷新 | 通过 | B20组受控状态矩阵及最终真实R1补证；受控状态不是对应故障的远端实测 |
| 5 策略组可选与权限过滤 | 通过 | A契约与组枚举权限回归、B共享编辑器受控组选择；原覆盖不被推荐静默覆盖 |
| 连接保存与采集结果、候选失效、409 | 通过 | B认证产品流程和flow回归、候选保留/放弃、C真实冲突只重预览失败对象；不盲重试 |
| 批量混合、部分失败、权限、冲突、取消、重试 | 通过 | C R10：真实MySQL/授权VM；断连/冲突/撤权/重启恢复/排队取消，5次发布对应5唯一request_id，源配置摘要未变。网络库存为合成无凭据对象，只证明unsupported反馈 |
| 既有覆盖保护、受控并发、幂等 | 通过 | C保留后设置max_rows=7、逐对象权限/候选CAS、队列上限；本次126恢复后owner/key唯一约束拒绝重复，取消fence保留 |
| 来源切换互斥、失败不能正式发布 | 通过 | 本次实库rollout/control/coordinator/formalization/legacy-write-fence回归，覆盖排空旧写、原子切换与回退、伪零gate拒绝、失败来源不增publication；不是额外远端双周期 |
| 告警/评分/报表/诊断/Agent唯一正式消费者 | 通过 | 本次consumers、report-metric-source、diagnostic-evidence-adapters回归；query_metrics→MetricConsumerService→MysqlFormalMetricStore。历史源、存储失败/未知不触发旧源fallback或健康恢复 |
| 备份→升级/冲突→重跑/并发→独立恢复 | 通过（隔离实库） | 本次4个migration测试；121重名原子拒绝、checksum绑定修复、重复/并发、旧schema恢复；新schema全量备份恢复覆盖126/127、129条迁移账本、audit/lineage/unknown/原时间 |
| 现役名称、配置、API、目录和活动表 | 通过（两项明确适配例外） | 源码扫描current-name-audit.json无未许可残留；实库24表/188列/50索引/29约束扫描零残留。4处旧schema注释先失败再由127修正；历史迁移不改checksum |
| R1桌面/窄屏、明暗、空/加载/失败/权限/部分/未知 | 通过（复用已审证据） | B77张真实截图以f62314e8的60张主题/稳定布局补证替换受影响图；C20真实+12受控截图。Chief已独立看图，控制/真实来源不混用 |
| 最终gate、独立review、merge及运行版本 | 本地受影响通过；本PR CI另附；Chief待审 | 前序准确head完整14绿已核；本次无合并/部署。运行时与已验C相同，schema127只变注释，不声称已在生产或共享服务运行本PR |

## 本次恢复环境、命令及证据

Node24.18.0 / pnpm11.19.0（仓库声明版本），独立临时MySQL8.4容器 `slide-max192-migration`，容器ID `289b3998af12c3100cc5e50933d9462d6255838b489e563789eb8d71f9cecefd`、label `slide.task=MAX-192`、仅绑定127.0.0.1:55755。未启动Fastify/Vite或访问真实目标，未改动共享3000/5173、其他容器及Provider。

成功演练库 `max189_upgrade_42593`，升级前恢复库 `max189_upgrade_42593_restore`，升级后恢复库 `max189_upgrade_42593_final_restore`。由fixture创建并在afterAll删除；不是生产库或真实平台数据副本。演练保留合成payload的revision7、lineage、unknown/null epoch，观测时间固定 `2026-01-02 03:04:05.123`，stored_at固定 `03:04:06.123`，不重写为恢复时间。恢复后队列可读写，cancel_requested和owner/idempotency_key约束保留，发布结果request_id与审计相符；不启动worker或重放未知任务。

执行命令（从仓库根目录；只对自有label容器）：

```bash
pnpm install --frozen-lockfile
docker run -d --name slide-max192-migration --label slide.task=MAX-192   -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1::3306 mysql:8.4   --innodb-buffer-pool-size=64M --performance-schema=OFF
docker port slide-max192-migration 3306
# 以下55755为本次实际分配端口，复现时使用上一行输出
METRICS_TEST_MYSQL_PORT=55755 UNIFIED_MIGRATION_CONTAINER=slide-max192-migration   UNIFIED_METRICS_EVIDENCE=<证据目录> pnpm --filter slide-api exec vitest run   src/migrations/unified-metrics.mysql.test.ts src/metrics/rollout src/metrics/consumers   src/metrics/bulk src/metrics/scheduler/lifecycle.test.ts   src/report-metric-source.test.ts src/diagnostic-evidence-adapters.test.ts   --maxWorkers=1 --reporter=dot
node scripts/qualification/audit-metric-names.mjs <命名审计JSON>
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm qualification:matrix
pnpm security:scan
pnpm security:deployment
node --test scripts/ci/*.test.mjs
```

dump/import由上述测试通过 `docker exec <自有容器> mysqldump -uroot --single-transaction --skip-comments <演练库>` 及 `docker exec -i <自有容器> mysql -uroot <独立恢复库>` 执行。空密码仅用于回环绑定的临时测试容器，生产凭据不进入命令、日志、附件。新schema dump316092字节，SHA256 `ade508623c25cd22045bbaaa3bc28e115ff1e7d7a8964077a1b41298cde29a99`。旧schema dump及两个dump实际大小/哈希见附件SHA256SUMS。逐行账本及队列/审计/观测快照见final-schema-restore.json。

结果：23文件/103测试通过，1文件/1测试按真实浏览器环境条件跳过；迁移4测试均实跑。首次仅备份增量为52通过/1跳过；扩展活动schema审计RED为3通过/1失败，准确发现4处注释；127后完整上述范围GREEN。类型、构建/CSP、契约、37/37资格覆盖、安全扫描、部署安全及14项CI选择器测试通过。保留既有构建体积/动态导入提示，不扩大重构。

## 唯一实现及旧名例外

- `server.ts` 只装配一套MetricSchedulerLifecycle，周期job由共享WorkerRuntime执行。全局关闭的持久job处理器fail closed。bulk worker只编排配置发布，不执行第二采集周期；历史collector/server lifecycle委托唯一实现，`migrations/metric-history`没有生产import。
- `/api/metrics-v2/...` 仅 `metrics/legacy-routes.ts` 注册同handler/认证/权限，带Deprecation/Sunset，最晚2026-11-15移除；bulk只用中性API。`alert-publication-fence.ts`只识别旧metrics-v2-rollout来源以保护历史通知，旧通知排空后可移除。这两处是运行时允许的全部代际字符串。
- 001—120历史SQL、121改名映射及迁移测试、已发布证据和历史文档保留旧名用于追溯；原 `metrics_history`/`server_metrics`/`network_device_observations`仅历史数据/迁移证据，不作正式fallback。`metrics-database-service.ts`未被现役调用的旧指标方法仍保留，不据字符串存在宣称它是活跃双路径；当前有效调用限慢查询/容量等独立能力，原方法归档需单独评估，不擅自删历史数据。
- 包语义版本、revision、digest、JWT/Agent/SNMP协议版本保留；不属于体系代际。自定义SQL两条已审固定定义经可信catalog复用唯一runner，原表达式/模板宏保持review-required，不称全部自动迁移。

## 证据入口与限制

- A：[原交付与Chief审查线程](mention://issue/01a14522-98e8-7759-8000-2fb8a2152c35)，源码报告 `unified-metrics-existing-sources-2026-10-17.md`、能力清单及兼容审查文档；历史UI阻塞以B最终交付为准。
- B：[完整R1真实页矩阵](https://multica.ai/api/attachments/01a147bb-9483-7a3f-96ac-066f08b69267/download)、[最终主题/布局补证](https://multica.ai/api/attachments/01a147d7-5e0c-7234-af7e-59476a02e39d/download)。最终补证ZIP SHA256 `580477fdcdf37781042e3e538f05435aa4ba5f4823dfd4d472ec637289da4606`；正式字段/三周期JSON及进程→端口→cwd→命令→源码→日志取证在原线程附件中。
- C：[真实/受控批量证据ZIP](https://multica.ai/api/attachments/01a1481f-411e-708e-bcdd-835a3fc11b73/download)，3622745字节，SHA256 `65f8f169ee7a6ada360dff2d97f8617f7ffcde2a2f65c1a0285e5e5126443aa9`，本次独立复算一致；源码交付报告 `MAX-191/delivery-2026-10-17.md`。R9 pending_takeover反例仍保留，不放宽门禁。
- 本次最终comment附脱敏迁移dump/账本、RED/GREEN、命名扫描、前序证据复用校验及准确head CI快照；产物统一outputs目录，不将运行机私有路径当作远端交付。

未测：PG/Oracle/达梦远端、真实复制多通道、物理SNMP。VM磁盘/网络及counter epoch/不支持速率仍按实际unsupported/unknown/partial呈现。恢复仅覆盖明确隔离schema场景，不承诺生产原地自动回退或任意损坏恢复；切换生产连接和生产迁移未获本交接授权。本次不交付部署代码包，旧290f4e03包不覆盖C/127，不能拿它当最终版本发布。

历史失败保留：C本地全量legacy调查10并发INSERT死锁1213与本次文件无关，不顺手修复、不把本地全量改称全绿；前序CI已逐head分类。本次新增schema元数据残留已修，最终完整CI单独核验。独立Chief审查与最终merge仍待后续，不能以绿CI代替。

产品LLM请求0；共享10M账本未重置。未派生代理；编码代理token/费用实际遥测不可用，不编造统计。用户工作区保持原样。
