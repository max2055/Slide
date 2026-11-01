# 原生监控模板：版本、权限和数据口径

本说明配套 `database-template-candidates.json` 的人工原生模板定义。它不是通用导入器，不包含凭据、目标地址、任意 SQL 或脚本。现有发布服务从注册实现重新核对每项映射；模板发布成功只证明配置合法，资源上的 probe/trial 成功后才能应用。隔离验收不向现有应用库安装模板。

## 使用流程

在“指标与采集”的原生模板库搜索并按资源类型筛选，复制现有模板，在自定义草稿中删除不需要的项，从已注册能力选择本说明列出的指标。保留自动带入的稳定指标标识、单位、维度和实现版本，只改显示名称与模板周期。保存名称、监控项及草稿后发布不可变版本，资源从已授权模板中选择该固定版本，先测试再应用。当前版本没有“导入此 JSON”按钮。

模板显示名不是身份。重命名保留 template_id/item_id；已发布快照不可变，修改后产生新版本，旧绑定继续固定原版本。更改单位、维度或指标语义不能以重命名方式续接历史。空名称、重复指标、非法周期、缺失实现会阻断发布。只读用户可以查看；编辑、复制、保存、发布需要 `metric:manage`，资源测试和应用还需要该资源管理权限，服务器/数据库/网络设备凭据不能互用。实时撤权后应重新加载，不能使用旧界面权限状态继续写入。

## PostgreSQL 基础模板

人工候选含 5 项，包 `postgresql-representative@1.0.0`，资格范围 PostgreSQL **16.4**（现有匹配规则接受该 major.minor 后的补丁段，不外推 16.5/17）。默认周期 60000ms、超时 5000ms、过期 120000ms、计数最大间隔 300000ms、最大行数 100；实际包推荐值以固定 digest 为准，资源覆盖以预览为准。数据库大小查询成本较高，不建议为了事务指标将整个模板设为高频。

| 项 ID / 指标（语义版本均为 1.0.0） | 固定实现后缀 / 原始字段 | 单位、值类型和维度 | 口径及最低读取范围 |
|---|---|---|---|
| activity / `postgresql.activity.count` | `connections.v1` / connections | count、uint64、无维度 | `pg_stat_activity` 行数，含后台和空闲进程；读取该视图即可 |
| capacity / `postgresql.connections.limit` | `limit.v1` / capacity | count、uint64、无维度 | `current_setting('max_connections')`，客户端连接上限 |
| commits / `postgresql.transactions.commit_total` | `transactions.v1` / commits | count、uint64、database | 当前绑定数据库 `xact_commit`，包括自动提交；读取 `pg_stat_database` 及启动/reset 证据 |
| rollbacks / `postgresql.transactions.rollback_total` | `transactions.v1` / rollbacks | count、uint64、database | 当前绑定数据库 `xact_rollback`，与提交项共享同一次快照 |
| disk / `postgresql.database.disk_bytes` | `size.v1` / bytes | By、uint64、database | 当前绑定库 `pg_database_size` 物理文件总大小；需要 CONNECT 及该函数执行权限 |

实现完整前缀为 `builtin:database.postgresql.`。参数没有数据库名称：数据库维度由授权连接的 `current_database()` 返回，不能手填别库维度。账号至少 LOGIN + 目标库 CONNECT，保留上述系统视图/函数读取权限；不需要超级用户、`pg_read_all_data`、业务表 SELECT 或写权限。隔离验收账号还设置 `default_transaction_read_only=on`；这不是生产权限管理的替代品。数据库连接由既有资源凭据引用提供，不在模板存密码。

**不能计算 activity/capacity 使用率**：前者包含后台进程，后者只限制客户端连接，口径不相容。事务计数保留 uint64 字符串、服务器采样时间及启动/数据库 OID/stats_reset 连续性。速率只在现有派生层算一次；首样本、统计重置、超长间隔等返回未知，不补 0。派生 commit_rate/rollback_rate/completed_rate 存在于注册包，但当前模板选择器不能直接将派生项作为监控项发布；本基础模板只选择原始计数。

该模板**不预装触发器**，因此没有虚构的触发/恢复阈值。需在已发布版本上使用既有触发器入口配置符合业务的触发与恢复条件，再形成新固定版本；只接受 good 质量或明确允许的质量，未知不能当健康。PG 本轮验证以真实读取和模板应用/持久样本为边界，不宣称事件触发/恢复业务实测。主机内存、磁盘空闲和 CPU 需显式授权关联主机，不能由数据库地址猜测 SSH 目标。

## Oracle 与达梦：不可应用候选

两者只有人工候选定义和已注册固定映射核对，**未获得对应版本的已授权实库验证，本轮不发布、不激活、不绑定**。隔离演练只保留 current=null、无版本记录的草稿。草稿不是系统强制的“认证锁”：现有通用编辑器允许管理员自行发布注册项，这不能被解释为本候选已经认证可用。

| 候选 / 注册包 | 指标 / 原始字段 | 单位、维度 | 所需权限和口径 |
|---|---|---|---|
| Oracle 19.3 / `oracle-representative@1.0.0` | oracle.sessions.count / connections | count、无 | SELECT V_$SESSION，绑定容器内会话数，含后台及空闲 |
| 同上 | oracle.processes.limit / capacity | count、无 | SELECT V_$PARAMETER，processes 参数，**不是会话上限**，不能与 sessions 合成利用率 |
| 同上 | oracle.transactions.commit_total / commits | count、无 | SELECT V_$SYSSTAT，user commits，驱动还须提供可信启动/重置证据 |
| 达梦 8.1 / `dameng-representative@1.0.0` | dameng.sessions.count / connections | count、无 | SELECT V$SESSIONS，数据库会话数 |
| 同上 | dameng.sessions.limit / capacity | count、无 | SELECT V$PARAMETER，max_sessions，无值不能补默认值 |
| 同上 | dameng.transactions.commit_total / commits | count、无 | SELECT V$SYSSTAT，transaction commit count，驱动还须提供可信启动/重置证据 |

全部值类型 uint64、语义版本 1.0.0，实现前缀 `builtin:database.oracle.` / `builtin:database.dameng.`，后缀为 connections.v1、limit.v1、transactions.v1。周期和超时同 PG；均无预装触发器、发现执行和专属图形。现有生产 transport 没有提供 Oracle/达梦 counterQuery 连续性证据，不得仅凭合成数组响应将事务率宣布可用；缺证据保持未知。容量扩展包/诊断包不是这些基础候选的隐含部分。

环境缺口 owner：Chief 协调 Max 提供已授权 Oracle 19.3 / 达梦 8.1 测试实例及凭据引用、允许的只读窗口；实现 owner 15coder1。恢复条件：明确连接对象/版本和最小读取授权，使用现有驱动完成正常、拒权、超时、精度、启动/统计重置证据与资源应用验证。若需付费安装或额外许可，另获授权；不连接共享3306，不擅自安装产品。此缺口只影响这两种候选的真实资格，不阻塞其他已授权工作。

## 既有三类模板资料与验证边界

| 模板 | 版本/权限/默认参数 | 单位、维度、未知与未支持项 |
|---|---|---|
| MySQL by ODBC 有限转换 | 原始 mysql-basic@1.0.0 为5.7/8.0/8.4；9.6应明确重新固定mysql-basic@2.0.0，仅uptime；读取SHOW GLOBAL STATUS；周期60s | uptime为s、无维度；不包含ODBC运行时；current/limit与计数率全覆盖不能由uptime证据代替 |
| Linux 固定参考模板 | linux-basic/linux-host@1.0.0，Linux；授权SSH账号能读取固定/proc与文件系统信息；周期60s | 内存%用(MemTotal−MemAvailable)/MemTotal；uptime s；文件系统By、device/mount/fs_type；不是任意脚本执行器，不能把CPU user+system当100−idle |
| Huawei VRP 固定参考模板 | snmp-standard@1.0.0；授权SNMP v2c/v3读取系统与接口OID；周期60s | uptime s；接口速率bit/s由By counter派生一次；uint64/观测时间/接口身份必须保留，首样本/重置/缺输入未知；无厂商CPU/风扇/温度映射 |

精确内容 hash、每项 raw→metric 映射和未转换项见 `t3/README.md`、`t3/evidence/t3-conversion.json`；T3原证据不是实采。后续真实 MySQL/VM 和受控 SNMP 证据按已接受 `native-template-workflow-20261101.md` 及 `template-review-fixes-20261101.md` 固定来源复用。本轮不重做，不把受控SNMP称为网络硬件实测，不以三类uptime/协议证据宣称原指标矩阵全部完成。上述三份转换模板均没有可执行预装触发器，恢复条件由资源实际发布的规则版本决定。发现、继承/退役和专属图形按相关任务交付，不以占位配置冒充执行。

## 隔离复现入口

仓库根目录运行，使用 package.json 的 pnpm 版本，Docker 可用且预先具备 `postgres:16.4` 和 `mysql:8.4`：

```bash
pnpm install --frozen-lockfile
pnpm --filter slide-api exec tsx e2e/max237-database-templates.ts
```

脚本自己创建带随机 nonce 标签的两个一次性容器、动态回环端口和 MySQL 所有权句柄；不接收外部连接目标，不用应用库连接配置，不打开生产 worker/通知/模型。随机测试加密 key 仅在进程内。前台 worker.runOnce 只处理隔离库自身队列。结束关闭连接、核对 schema 所有权后删除、核对容器 ID/nonce 后优雅停止；清理失败返回非零并保留证据，不按端口强杀。

输出 `outputs/max237-databases-<nonce>/evidence.json` 包含源码 SHA、真实版本、映射、固定发布快照、业务结果和逐项清理状态。Issue附件是可访问交付物；工作目录路径仅为复现约定。脚本失败日志应与最终证据同时保留；测试跳过不能计为通过。
