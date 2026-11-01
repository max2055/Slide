# MAX-237 / T3：接到 mysql3306、转换三份官方模板、网络速率夹具

本目录是 Issue #261（Multica MAX-237）**T3 开发包**的交付说明。准入是成员评论
`01a17d8e-d980-78f2-9d2e-410d9242f8ec`（接 mysql 3306、网络先做功能、模板从 Zabbix 下载转换）与
`01a17d9b-f942-7e81-9698-b2100c221d2f`（本包范围）。基点是 `4ed20d4d9a181ca44764ec40cb6f0cf9e1a20409`；
本包只在该分支追加，不重做已接受的 T1、T2A、T2B。

**一句话结论**：五张 T2B 表已用已接受的候选 DDL（`CREATE TABLE IF NOT EXISTS`）补在 `mysql3306` 所在的应用库
`db_ops_ai`，三份固定官方 Zabbix 7.0.21 模板已按显式规则转换为 Slide 原生模板并经既有 repository 写入，按上游
uuid 读回项数为 **1 / 5 / 9**，与转换报告一致；重复导入为 `noop`、不新造模板。网络接口速率只用夹具证明
首样本 / 计数重置 / 缺输入均为未知。**三份模板的已验证对象都是「无」**：没有真实 SSH/SNMP/数据库采集，
不是三类真实模板闭环，也不是 P1 完成，整单保持 `in_progress`。

## 1. 基点与本包变更面

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-237`（未切分支、未 rebase/squash） |
| 交付 base | `4ed20d4d9a181ca44764ec40cb6f0cf9e1a20409` |
| 产品代码提交 | `8a4f6489b` |
| CLI/证据提交 | `535ae6635` |
| 新增（仅允许面） | `apps/db-ops-api/src/metrics/templates/{zabbix-official-templates,zabbix-template-import,max237-zabbix-import-cli,zabbix-official-templates.test}.ts`、本目录 |
| 修改（仅允许面） | `apps/db-ops-api/src/metrics/snmp/collector.test.ts` |
| 只执行不修改 | `docs/slide/development/MAX-237/t2b/sql/t2b_metric_template_aggregate.sql`（运行时只加 `IF NOT EXISTS`） |
| 未改 | 应用 migration、`server.ts`、路由、`metrics/policy`、`bindings`、`config`、调度器、前端、共享 pool、公共契约、T2B 候选 SQL 文件 |

新增模块故意不挂载：没有路由、进程注册、调度、共享连接池或运行时消费者引用它们。CLI 是一次性证据命令，
默认 dry-run；`--apply` 才使用应用现有 `dbConnection`。

## 2. 接到 mysql3306 所在应用库

- 只读前置核对：`database_instances.id = 1` → 名称 `mysql3306`、`db_type=mysql`、`port=3306`、
  `database_name=db_ops_ai`、`status=active`；连接池 `SELECT DATABASE()` 同样为 `db_ops_ai`，不一致即停止。
- 首次 apply 前 `SHOW TABLES LIKE 'metric_template%'` 只有历史表 `metric_templates`（5 行）；五张 T2B 表均不存在。
- 本次只补这五张表，逐条来自已接受候选 DDL，运行时仅改写为 `CREATE TABLE IF NOT EXISTS`：
  `metric_templates_v2`、`metric_template_drafts`、`metric_template_versions`、`metric_template_items`、
  `metric_template_item_versions`。全部 `InnoDB` / `utf8mb4_bin`，`CREATE_TIME` 均为
  `2026-10-27T13:54:39Z`。
- 没有 `ALTER`/`DROP`、停写、复制整库、切换或回退；历史 `metric_templates` 表未动。
- 业务表行数前后一致：`users` 5、`database_instances` 5、`servers` 1、历史 `metric_templates` 5。
- 机器证据：[evidence/t3-import.json](evidence/t3-import.json) 的 `target`、`tables`、`business_counts`、
  `table_facts`、`template_facts`、`readback`。该文件记录的是最终代码 SHA 上的重复 apply（`created = []`、
  三份 `noop`）；首次 apply 建表与建模板由 `table_facts.create_time` 及三份模板 `created_at` 均为
  `2026-10-27T13:54:39Z` 复核。直连 SQL 旁证见 [evidence/t3-direct-readback.json](evidence/t3-direct-readback.json)。

## 3. 三份官方模板的来源链

固定上游：Zabbix **7.0.21**，提交 `6542e21fe6adc8ab7bf903c2a9d1df80e80366cd`，许可证 **AGPL-3.0-only**，
仓库 `https://github.com/zabbix/zabbix`。运行前用 `git -C <ref> rev-parse HEAD` 核对，不等于该提交即拒绝。
不提交上游 YAML，不复制 C/PHP 实现或表达式引擎，不做通用导入器。

| 类别 | 官方文件（路径） | 模板 uuid | 官方 URL |
|---|---|---|---|
| 数据库 | `templates/db/mysql_odbc/template_db_mysql_odbc.yaml` | `e19c120027e04da69b130e0f6cea29fc` | [固定链接](https://github.com/zabbix/zabbix/blob/6542e21fe6adc8ab7bf903c2a9d1df80e80366cd/templates/db/mysql_odbc/template_db_mysql_odbc.yaml) |
| 服务器 | `templates/os/linux/template_os_linux.yaml` | `f8f7908280354f2abeed07dc788c3747` | [固定链接](https://github.com/zabbix/zabbix/blob/6542e21fe6adc8ab7bf903c2a9d1df80e80366cd/templates/os/linux/template_os_linux.yaml) |
| 网络设备 | `templates/net/huawei_snmp/template_net_huawei_snmp.yaml` | `ad4c3dad4b7b492685d1fd3bd3a664f9` | [固定链接](https://github.com/zabbix/zabbix/blob/6542e21fe6adc8ab7bf903c2a9d1df80e80366cd/templates/net/huawei_snmp/template_net_huawei_snmp.yaml) |

持久化身份就是上游模板 uuid（`template_id`）与上游 item/prototype uuid（`item_id`），重复导入不会新造一份。
`source_chain.actor_id` 为 `NULL`（已接受 schema 允许无人工作者的迁移），`migration_ref` 含固定提交与模板 uuid；
不冒充任何用户。完整 URL、路径、提交、uuid 与逐项来源同时写在
[evidence/t3-conversion.json](evidence/t3-conversion.json)。

## 4. 转换结果（只转换已注册、可采集的能力）

规则是显式键表（`zabbix-official-templates.ts`），不做显示名或表格顺序匹配。未命中的条目保留上游身份与理由，
不进入模板版本。

### 4.1 MySQL by ODBC → 1 项

| 上游项 | 上游键 | Slide 指标 | 单位 | 实现 |
|---|---|---|---|---|
| Uptime | `mysql.uptime` | `db.uptime_seconds@1.0.0` | `s` | `mysql-basic@1.0.0` / `builtin:mysql.status.v1` / raw `Uptime` |

- ODBC 的只读 `SHOW`/`SELECT` 只作为来源说明；实际采集复用既有 MySQL 只读状态采集。`{$MYSQL.USER}`、
  `{$MYSQL.PASSWORD}`、`{$MYSQL.DSN}` 全部丢弃，未入库。
- 63 条未转换：`no_matching_slide_metric` 27、`derived_not_selectable` 24、`odbc_raw_not_a_metric` 6、
  `expression_not_supported` 3、`discovery_not_delivered` 3。没有触发器（上游 0 条）。

### 4.2 Linux by Zabbix agent → 5 项

| 上游项 | 上游键 | Slide 指标 | 单位 | 实现 |
|---|---|---|---|---|
| Memory utilization | `vm.memory.utilization` | `linux.memory.used_percent@1.0.0` | `%` | `linux-host@1.0.0` / `builtin:linux.host-gauges.v1` / raw `memory_usage` |
| Load average (1m avg) | `system.cpu.load[all,avg1]` | `linux.load.one_minute@1.0.0` | `1` | `linux-basic@1.0.0` / `builtin:linux.basic.v1` / raw `load_1min` |
| System uptime | `system.uptime` | `linux.uptime.seconds@1.0.0` | `s` | `linux-basic@1.0.0` / `builtin:linux.basic.v1` / raw `uptime` |
| FS [{#FSNAME}]: Space: Total | `vfs.fs.dependent.size[{#FSNAME},total]` | `host.filesystem.size_bytes@1.0.0` | `By` | `linux-host@1.0.0` / `builtin:linux.filesystem.v1` |
| FS [{#FSNAME}]: Space: Used | `vfs.fs.dependent.size[{#FSNAME},used]` | `host.filesystem.used_bytes@1.0.0` | `By` | `linux-host@1.0.0` / `builtin:linux.filesystem.v1` |

- 内存项对应既有 MemAvailable 口径：`(MemTotal - MemAvailable) / MemTotal`，不是另起公式。
- 66 条未转换：`zabbix_agent_unsupported` 29、`semantics_mismatch` 17、`no_matching_slide_metric` 13、
  `discovery_not_delivered` 4、`internal_not_collectable` 1、`expression_not_supported` 2。
  `system.cpu.util` 归为 `semantics_mismatch`：Slide 现有指标是 user+system 占比，不等于 Zabbix 的 100-idle。
- 4 条触发器全部是多指标/依赖未转换项的表达式，保留原文并标 `unsupported`；模板不含可执行触发器。

### 4.3 Huawei VRP by SNMP → 9 项

| 上游项 | 上游键 | Slide 指标 | 实现 |
|---|---|---|---|
| Uptime (network) | `system.net.uptime[sysUpTime.0]` | `snmp.agent.uptime_seconds@1.0.0` | `snmp-standard@1.0.0` / `builtin:snmp.system.v1` |
| Operational status | `net.if.status[ifOperStatus.{#SNMPINDEX}]` | `network.interface.oper_up@1.0.0` | `builtin:snmp.interfaces.v1` |
| Speed | `net.if.speed[ifHighSpeed.{#SNMPINDEX}]` | `snmp.interface.speed_bits_per_second@1.0.0` | 同上 |
| Bits received | `net.if.in[ifHCInOctets.{#SNMPINDEX}]` | `snmp.interface.rx_octets_total@1.0.0` | 同上 |
| Bits sent | `net.if.out[ifHCOutOctets.{#SNMPINDEX}]` | `snmp.interface.tx_octets_total@1.0.0` | 同上 |
| Inbound packets with errors | `net.if.in.errors[ifInErrors.{#SNMPINDEX}]` | `snmp.interface.rx_errors_total@1.0.0` | 同上 |
| Outbound packets with errors | `net.if.out.errors[ifOutErrors.{#SNMPINDEX}]` | `snmp.interface.tx_errors_total@1.0.0` | 同上 |
| Inbound packets discarded | `net.if.in.discards[ifInDiscards.{#SNMPINDEX}]` | `snmp.interface.rx_discards_total@1.0.0` | 同上 |
| Outbound packets discarded | `net.if.out.discards[ifOutDiscards.{#SNMPINDEX}]` | `snmp.interface.tx_discards_total@1.0.0` | 同上 |

- 上游 “Bits received/sent” 呈现为 bps；Slide 的模板项钉住底层 `ifHCInOctets`/`ifHCOutOctets` 计数器
  （`By`），速率是独立 derived 指标，不能把上游 rate 冒充为 counter。速率未知规则见 §6。
- 26 条未转换：`snmp_oid_unmapped` 16、`discovery_not_delivered` 5、`icmp_not_collected` 3、
  `trap_not_collected` 1、`internal_not_collectable` 1。`hrSystemUptime`、`ifType`、MPU/FAN/Entity/
  EtherLike 原型都不在现有 `SnmpDiscovery` 或已审阅华为 MIB 目录中；仓库默认 `vendorMetrics` 为空，
  没有伪造 CPU/内存/温度映射。
- 1 条触发器（重启）依赖两个 uptime 项与多条条件，`unsupported`，原文保留。

### 4.4 共同决定

- 模板级周期统一为 `interval_ms = 60000`（已接受边界 1000–86400000）；上游逐项 delay（0/30s/3m/5m/1h）保留在
  转换报告，但既有采集计划一个资源只有一个节奏，不能逐项设置。
- 上游图（MySQL 6、Linux 8）与 discovery 都未交付，capability 占位保持 `executable: false`。
- 触发器引用、阈值与恢复执行属于 MAX-239；本包没有执行任何规则。

## 5. 写入与读回

| 模板 uuid | 读回名称 | 状态 | current | 版本数 | 项数（报告/读回） | content_hash |
|---|---|---|---|---|---|---|
| `e19c120027e04da69b130e0f6cea29fc` | MySQL by ODBC | active | 1 | 1 | 1 / 1 | `sha256:4db480…b107a` |
| `f8f7908280354f2abeed07dc788c3747` | Linux by Zabbix agent | active | 1 | 1 | 5 / 5 | `sha256:bfdc51…c7c21` |
| `ad4c3dad4b7b492685d1fd3bd3a664f9` | Huawei VRP by SNMP | active | 1 | 1 | 9 / 9 | `sha256:2ea6fd…c7f92` |

- 写入经既有 `MySqlTemplateRepository`：草稿 + 不可变版本 + `current` 指针，均在同一事务；没有第六张表、
  没有第二套 registry。
- 重复 apply：`created_tables = []`，三份模板均为 `action = noop`，版本数仍为 1，业务行数不变。
  机器证据：[evidence/t3-import.json](evidence/t3-import.json)。
- 不经适配器的直连 SQL 复核：[evidence/t3-direct-readback.json](evidence/t3-direct-readback.json) 显示三行模板
  （`created_by = NULL`、`current_published_version = 1`）、三条只读版本与 1/5/9 项计数。
- 转换报告：[evidence/t3-conversion.json](evidence/t3-conversion.json)（含每条未转换项与理由、触发器原文、
  丢弃的凭据宏、未转换图）。

## 6. 网络采集与速率未知边界（夹具）

- `SnmpDiscovery` 复用既有共享 Counter Processor：rx/tx 独立，保留 uint64 位宽、观测时间、连续性证据与
  `interface_epoch`。
- 新增 focused 用例：首样本 `counter_baseline`、计数重置 `counter_reset`、缺输入（varbind 缺失）都为
  `value: null` 且质量未知，**不补 0**。见 `collector.test.ts` 的
  “keeps interface rates unknown on first sample, counter reset and missing input — never zero”。
- 所有断言只用仓库内夹具，未打开真实 SNMP 套接字、未连接真实网络设备。夹具通过不等于真机验收。

## 7. 验证

| 命令（cwd `apps/db-ops-api`） | 结果 |
|---|---|
| `npx vitest run src/metrics/templates src/metrics/snmp` | 6 文件通过 / 2 跳过；**94 passed / 23 skipped**，exit 0（[evidence/t3-focused-tests.txt](evidence/t3-focused-tests.txt)） |
| `npx tsc --noEmit` | exit 0，无诊断（[evidence/t3-checks.json](evidence/t3-checks.json)） |
| `npx oxlint <5 changed files>`（仓库根） | 0 warning / 0 error（[evidence/t3-oxlint.txt](evidence/t3-oxlint.txt)） |
| `tsx src/metrics/templates/max237-zabbix-import-cli.ts --zabbix-ref <ref> --repo-root ../.. --out <evidence> --apply` | 首次建五表并导入；再次运行 `created=[]`、`noop`（[evidence/t3-import.json](evidence/t3-import.json)） |

无公共契约变更，未跑 `contracts:check`、全量测试或 UI；本包不涉及前端。

## 8. 本包没有做（不得当成完成）

- **没有真实采集**：三份模板的已验证对象均为「无」，没有 SSH/SNMP/数据库采样、没有真实触发器、没有历史或
  通知闭环；夹具、转换报告和数据库读回都不能替代真实业务验收。
- 未接真实设备/实例：没有读取 VM、mysql3306 的业务指标，没有打开 SNMP 套接字。
- 触发器、发现、图形、AI 证据、资源绑定、历史/规则执行仍属后续 Issue；模板里的 capability 占位不可执行。
- MySQL 兼容边界：转换项钉 `mysql-basic@1.0.0`（适用 5.7/8.0/8.4）。本机应用库是 MySQL 9.6，9.6 目标需要
  `mysql-basic@2.0.0`（仅 uptime）；这是绑定时的适用性边界，不是本包已完成的采集结论。
- 未提交上游 YAML、C/PHP 实现、ODBC/Agent/表达式引擎；许可证按 AGPL-3.0-only 标注来源，未把上游内容作为
  自有实现带入。
- PR #390 保持未合并；整单保持 `in_progress`。
