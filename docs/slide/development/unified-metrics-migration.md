# 唯一指标升级、兼容与恢复

本说明适用于 MAX-189；能力及非等价口径见 `unified-metrics-capabilities.md`，前端/API 契约见 `unified-metrics-backend-contract.md`。这是迁移操作说明，不表示当前生产平台已经升级。

## 改名与兼容边界

| 历史名称 | 当前名称/处理 | 退出条件 |
|---|---|---|
| `src/metrics-v2`、`src/contracts/metrics-v2` | `src/metrics`、`src/contracts/metrics`；单一实现 | 不保留历史源码目录 |
| `/api/metrics-v2/{config,policy,rollout,query,discover,inventory,evaluate}` | 同 handler、认证与权限钩子转发 `/api/metrics/...`；Deprecation 与 Sunset 响应头 | MAX-190及外部调用方迁完，最晚2026-11-15移除兼容注册 |
| `METRICS_V2_COLLECTION_ENABLED` | `METRICS_COLLECTION_ENABLED`，严格 true/false，默认关闭 | 旧变量不隐式启用；部署配置需显式改名 |
| `METRICS_V2_TEST_*` | `METRICS_TEST_*`；实际fixture变量见对应测试 | 仓库qualification脚本使用中性名称 |
| `metric_v2_*` 16张运行表 | migration121原子改名为 `metric_*`，同步相关FK/索引 | 旧表名只用于历史SQL、升级与恢复证明；不双写 |
| 历史 `legacy/v2` 来源数据 | migration123将持久正式来源中性化；保留旧源事实与revision | `source-history`仅作来源迁移调查，正式读取不fallback |
| `metrics-v2-rollout` 告警source | 当前写 `metrics-rollout`；fence接受旧source以保护已存在通知 | 历史告警/待发通知处理完才清理旧source识别 |
| 历史包、implementation `.v1/.v2`、语义版本/digest | 保留不可变身份；新增能力发新包版本 | 不把必要语义版本当体系名称修改 |
| 历史 `docs/slide/metrics-v2` | 保留当时证据；当前导出/qualification写 `docs/slide/metrics` | 不重写旧截图、测量与证据 |
| 原 `collector/server/monitor/network` 周期 | 生命周期/手动兼容入口委托唯一scheduler/试采；历史实现在 `migrations/metric-history` | 历史实现无生产import；仅比较测试可引用 |
| `metrics_history`、`server_metrics`、`network_device_observations` | 原数据保留；不再作为正式数值读取/写入 | 不因迁移drop用户历史；后续归档另行授权 |

JWT加密封装、Agent协议、SNMP v2c/v3等无关协议版本不属于本次名称迁移。

## 自定义定义与诊断能力

Chief预审后的逐字段证据和自定义SQL审核/迁移操作见 `unified-metrics-compatibility-review-2026-10-17.md`。新增diagnostics@1.1.0不改1.0.0内容；旧绑定不自动升级。迁移status中的reviewed不是已执行或正式可见。

Compose和生产env示例现使用中性collection/retention变量；升级时显式复制经核实的旧值到新名，不读取旧名作为fallback。`startup-readiness.test.ts`验证实际Compose注入。

## 上线前备份与停写

1. 核对目标平台数据库、连接配置、分支/commit、进程PID→端口→cwd→命令→日志。不要对当前任务以外服务按端口强杀。
2. 记录现有迁移账本、schema版本和包digest、策略/组绑定、revision、lineage/audit及待处理workflow。备份平台业务schema（含迁移账本、原历史表和全部指标表），记录时间与SHA-256并在隔离恢复库验证可读。使用受保护客户端凭据，不把密码写命令行、日志或版本库。
3. 暂停旧版本写者和worker并确认在途请求已排空后升级。不能一边运行旧表名写者一边rename。`METRICS_COLLECTION_ENABLED=false`对新运行时禁止入队与远端周期请求；旧部署仍需正常停止旧worker。
4. 检查16组旧/新表是否发生重名，确认空间、权限、外键/索引及MySQL版本。出现用户已有中性同名表应停止，调查归属后制定迁移方案；禁止自动drop、覆盖或拼接两套数据。

## 迁移与修复

- 使用现有 MigrationRunner 的命名锁与checksum账本顺序执行121—125。121单条 RENAME TABLE 原子改16表；其后同步FK/索引。122持久来源接受，123来源名称，124语义基线，125实测来源对照。历史SQL001—120不改checksum。
- 原子rename遇重名应整条拒绝，旧证据保持可读。普通成功重跑不重复搬数据，并发runner由现有锁串行。
- MySQL DDL不能依赖事务回滚。若rename已完成而后续DDL或账本未完成，先保留完整错误和当前schema，逐项验证旧表消失、新表结构、索引/FK、行数与原payload/hash/lineage/revision。不得盲目改checksum或删除failed记录。
- 外部修复只有在针对该迁移的准确checksum、验证函数和操作说明齐备时，使用现有 `acknowledgeExternallyRepairedMigration` 接口登记，再重跑剩余迁移。测试覆盖的是明确构造的外部rename及此修复流程，不表示任意损坏均可自动恢复。

## 启用与验收

1. 用新变量显式启用全局采集，启动唯一MetricScheduler并确认其全局状态可观测。资产暂停优先于组/资源策略，检查入队、每次请求前与提交前的复核。
2. 按资源引擎、版本、OS、协议和实际能力推荐包；调用activate执行试采与CAS发布。应用pending/applied和formal visibility分开呈现，不能以发布HTTP200宣称正式可见。
3. 新资源以真实样本初始化；有历史源时保留来源记录，使用同一次固定远端响应的原解析重放进行等价项比较，并记录非等价项的具体口径。没有额外远端请求，也不声称独立双源周期。来源checks必须绑定当前resource/revision/sample IDs；失败/缺capture/错revision不能用全零gate蒙混通过。
4. scheduler持久raw/attempt/normalized和source checks，formalization验证实际样本、quality、lineage和CAS/fencing后发布。来源检查失败时不能继续新增正式publication。计数器epoch不可信时累计/速率保持unknown，不能伪造启动时间。
5. 验证至少三次正式周期及唯一查询API真正出值，再暂停资产确认无新attempt，恢复并重启scheduler确认续采；验证旧入口同一权限与结果、无历史fallback。检查告警/Agent/报告/评分读取来源、真实观测时间与coverage。

## 回退

- 停止新writer并排空在途，保全升级后数据库及错误证据。
- 将升级前备份恢复到**独立恢复schema**，验证账本、原表、payload/hash、lineage/revision及业务数据；在隔离环境用原commit/配置验证兼容后，再由发布负责人执行连接切换。
- 不在用户原schema上批量DROP/反向rename以赌恢复；不让旧程序连接已仅含新表名的schema。原环境和升级后新数据保留，待确认是否需要专门回填方案。
- 实库证据覆盖隔离MySQL8.4：升级前dump与校验和、重名原子拒绝、显式修复、并发/重跑和独立恢复；没有对真实生产平台schema执行迁移或回退。
