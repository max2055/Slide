# Metric Architecture V2：盘点与迁移候选 v1

任务：MAX-63；日期：2026-09-18；源码基线：`f9c1de747890a10d059765aac32712fa4e270372`（当次最新 main）。本目录是 MAX-64 的契约输入，不是已经上线的 V2 API。映射语义版本统一为 `1.0.0-candidate.1`；旧数据没有语义版本，标记为 `legacy-unversioned`，不得倒填为新版本。

## 执行契约与关闭边界

- 范围：MetricRegistry、数据库/Server/网络设备采集、实时/历史接口、图表、告警、评分、Agent 的源码盘点；迁移映射、Core Profile 候选及三类合成脱敏 fixture。
- 排除：运行时代码修改、指标扩容、采集包/存储/公共转换器实现、生产操作；不重新实施 MAX-11/19/30/37。
- 验收：注册定义及 provider 分支逐项有迁移行；实时字段有迁移行或非指标解释；消费引用有分类；三类 fixture 的数值、维度、不可映射案例可离线验证。
- 测试层级：静态提取交叉核验 → fixture 算术与覆盖校验 → 最终同一离线 gate + `git diff --check`。没有运行时代码改动，不启动数据库/SSH/SNMP、不运行无关全仓测试。
- 硬预算：未设定。实际 raw input、cached input、output、费用遥测均不可用，不填写估算实测值；主代理 1、子代理 0、最大代理深度 0、并发峰值 1。
- 停止条件：产物校验通过并交付 PR 后等待验收/合并；合并 main 后才满足下游依赖。若缺少写入权限，保存已验证提交并报告具体阻塞。PR 合并不由本报告代为授权。
- 回退：仅新增本目录，撤回该目录的提交即可；没有数据迁移、配置或运行时副作用。

## 产物与阅读方式

`mapping.md` 是逐项语义映射（包含旧 ID、类型、单位、来源、成本、作用域/维度、分类及处置理由）；`consumers.md` 是消费方与兼容边界；`inventory.json` 是源码提取的注册表、provider 分支、实时字段及引用位置快照；`fixtures.json` 是三类代表和正反例。运行 `python3 docs/metrics-v2/v1/verify.py` 交叉校验；`--refresh` 仅在审核新基线时重建源码快照，不自动修改人工语义决策。

源码快照覆盖仓库内置实现，不声称覆盖部署数据库中用户创建的 `collection_sqls`/`compute_expr`。自定义定义必须逐部署导出后按 Extension 审核；未知 SQL 不按旧 ID 自动升级为 Canonical。成本为源码推导的查询/命令次数与复杂度，**不是实测延迟**。

## 已有工作复核

2026-09-18 任务列表显示 MAX-11/19/30/37 均 done；main 历史分别包含 `0785db9` (#13，采集/查询可靠性)、`ab1a2f0` (#19，按指标调度)、`3f76d32` (#31，DM8 内存及部分成功)、`1d011e3` (#40，监测状态/采集质量)。本项只记录其现状与语义缺口，保留这些修复；没有以发现差异为由重写它们。当前无相关开放 PR。

## 关键语义决定

1. `target_type + resource_id + metric_id + semantic_version + dimensions` 决定序列身份。旧 `cpu_usage` 在 instance/server 下不是同一指标。引擎类型是资源属性与映射选择条件，不允许跨引擎同名直接合并。
2. `version`/`db_version` → `db.version`，`db_type` → `db.engine`；OS、设备型号/固件、接口名称/别名/速率属于 inventory。不是数值时序，不能求均值。接口速率作为带时间/来源的属性供分母使用。
3. 连接、会话、后台进程、活跃事务是四种对象。MySQL PROCESSLIST、PG pg_stat_activity、Oracle V$SESSION、DM V$SESSIONS 的过滤/后台对象不同；旧 `connections` 拆为引擎 Extension，不凭字段名称映射为统一客户端连接数。Oracle `processes` 也不能作为会话数的统一分母。
4. 禁止直接启用笼统 `db.size_bytes`：MySQL 表 data_length+index_length 是引擎报告的表/索引占用估计；PG pg_database_size 是当前数据库磁盘占用；Oracle 表空间比例是已分配数据文件扣除空闲；均非用户逻辑数据字节数。旧 GB 实际除以 2^30 且四舍五入；还原 bytes 必须携带精度损失，不能伪装精确原始值。
5. 禁止直接启用笼统 `db.qps`：MySQL Queries 包含语句执行，PG 旧 qps 是 xact_commit，Oracle execute count 与 DM sql executed count 也不能仅因单位相同承诺等价。分别保留 Extension。TPS 的显式 COMMIT/ROLLBACK 命令计数、所有已完成事务、只提交事务也要拆分。
6. DB CPU/内存/磁盘估算不能映射 OS 利用率：MySQL CPU 有 +20 基线；PG 内存是会话比值；Oracle 内存混入表空间与异量纲 PGA 公式；DM disk 固定 45。后两类伪资源利用率候选废弃，但旧 API 和历史仍按原语义读，不能直接把旧值改成新指标。
7. Gauge/counter 与 estimated/derived 正交：已求差的速率是 gauge（derived=true），原累计量才是 counter。DB slow_queries(MySQL) 不是周期新增；网络 interface_*_bps/error_rate/drop_rate 注册为 counter 但输出已是 rate；Server network_*_bytes 注册缺省 gauge 但实际累计值。迁移不能再对速率求差，也不能对 counter 样本求和。
8. `interface utilization` 当前没有注册/发射。候选公式仅为方向独立 `100 * interface_bps(direction) / speed_bps`，全双工不把 in+out 除以单方向带宽。分母未知、0、ifSpeed 饱和、速度变化或采样跨接口重建时不产值；不能臆造容量。首期 fixture 演示公式边界，不新增采集范围。
9. 历史行没有完整质量/来源证据；`is_estimated` 是旧行级字段，不代表该行每一项估算。首次 counter baseline、重启、回绕、采样缺口、权限失败与真实零必须区分，后续公共处理器负责。不得回填历史为 good 或拼造 raw counter。

## Core Profile 候选（产品清单，不由模板覆盖）

|资源|首期 Canonical 代表|现有来源与准入|已有 Extension 样例|列表建议|
|---|---|---|---|---|
|数据库|`db.uptime_seconds`，gauge，秒，实例范围|MySQL uptime_seconds / SHOW GLOBAL STATUS Uptime；非单调累计 counter，不计算 rate；其他引擎未暴露此旧字段则 unsupported|`mysql.statements.rate` ← qps；`dameng.memory.pool_used_percent` ← memory_usage|可用性来自资源状态；代表 uptime；连接数/吞吐以引擎 Extension 明确标签，不填通用 CPU/磁盘|
|Server|`host.filesystem.used_bytes`（gauge，bytes）及 size/available；`host.network.bytes_total`（counter，bytes）|df 字节样本保留 mount/device/fs_type；/proc/net/dev 保留 interface/direction|`linux.cpu.user_system_percent` ← cpu_usage（不是所有非 idle CPU）；`linux.load.1m` ← load_1min|filesystem 占用及 host.memory.used_bytes；缺失为未知，不混合挂载点百分比|
|网络设备|`network.interface.traffic_bps`（derived gauge，bit/s）；`network.interface.oper_up`（gauge，0/1）|IF-MIB octets 差分×8，方向和 ifIndex 不丢；operStatus 只接受 up/down，其余 unknown|`huawei.device.cpu_percent` ← device_cpu_percent（默认 MIB 无厂商 OID，保持 unsupported）|可达性/数据新鲜度分开；接口流量在详情按维度显示；设备 CPU 无能力时不填零|

这些是最小验证集，映射表其余 Canonical 是后续可发现候选，不要求首期全量接入。`db.uptime_seconds` 尚未进入内置注册表，需要后续包基于**已有**实时来源接入，不意味着本项增加采集器。网络 sysUpTime 是管理子系统 uptime，不能与数据库/主机 uptime 无条件合并。

## 跨实现映射与拒绝样例

- 可映射：同一接口 IF-MIB 32 位 ifInOctets 与 64 位 ifHCInOctets，在已知位宽、同一 boot/接口世代和无重置/缺口下，60 秒增加 6000 octets 都给 `network.interface.traffic_bps{direction=in}=800`。不能在基线之间切换计数源而不重置基线。
- 可映射：Linux proc 接收累计字节在差分后×8，与 SNMP 入 octets 差分×8 在方向为入、单位为 bit/s、资源/接口身份各自保留时，具有可比较的接口流量语义；不是把两个设备合为一个序列。
- 不可映射：MySQL Queries 增长 600 与 PG xact_commit 增长 600，60 秒都等于 10，但一个是语句，一个是提交事务；不能合成 db.qps。
- 不可映射：MySQL PROCESSLIST=12 与 Oracle V$SESSION=12；后台对象与会话语义不同。MySQL 数据表估计 1 GiB 与 PG 数据库磁盘 1 GiB 数值相同也不是同一空间口径。
- fixture 中 `unknown` 为未来规范化预期；当前代码可能返回零/回退值。本项没有宣称规范化预期已经被运行时实现。
