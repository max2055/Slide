# MAX-73 SNMP implementation plan

目标：标准 MIB uptime、IF-MIB 状态/字节/error/discard 进入 MAX-70 调度、MAX-66 公共处理、MAX-68 查询。基线 main `eea42aa`，包含 PR #81/#83。

范围 v1：新增独立版本包和资源级 SNMP discovery；兼容旧包与旧采集器。排除 UI、生产切换、新私有 OID、真实厂商兼容声明及跨消费方联调。硬预算未设定；token/费用遥测不可用；不委派子代理。停止条件为必要验收通过，或有无法在授权范围内消除的外部阻塞。

设计选择：直接扩展旧数值化采集器会丢失 Counter64 精度；另建调度违反复用要求。采用现有 SnmpClient 的有界 get/table + 新解码器，公共 runner 增加可选逐字段证据。线格式不变。资源级 discovery 在进程重启/失去连续性时换代，优先安全地重新建立基线，不假装拥有持久设备启动标识。IF-MIB 无法证明身份的端口不计算连续速率。

1. `src/metrics-v2/snmp/collector.ts`：固定标准 OID，Counter64 Buffer→bigint→十进制字符串；独立 ifTable/ifXTable，HC 优先，字段失败隔离，读 uptime 前后检查重启。接口身份由名称、描述、MAC 和 generation 构成，完整发现中消失后重现换代；重启/中断证据不能产生速率尖峰。32 位下降不猜测 wrap，缺速率上限不计算速率。
2. `src/metrics-v2/snmp/package.ts`：新包注册 canonical oper_up 与有命名空间的 Extension；rx/tx 分别输出 bit/s，speed 为每方向 bit/s 分母。复用现有已版本化厂商 fixture 的 CPU/memory 映射，默认无私有 OID；温度因冻结单位目录不支持而不强行映射。
3. `src/metrics-v2/packages/{adapters,runner}.ts`、`derived.ts`：可选 get、逐字段 quality/counter/bound、按序列传递速率上限，保持旧调用默认行为。取消检查覆盖每次网络请求。
4. `src/metrics-v2/snmp/collector.test.ts` 与 `docs/slide/metrics-v2/snmp/fixtures.json`：精度、64/32 fallback、wrap/reset、重启/消失/复用、权限/unsupported/缺口/局部失败、扩展来源和取消回归。
5. `src/metrics-v2/snmp/snmp.mysql.test.ts`：localhost UDP SNMP 模拟器→真实 SnmpClient→既有 Worker→隔离 MySQL→SemanticQueryService；验证频率、revision、rx/tx、来源和未知质量。

验证顺序：focused SNMP tests → metrics-v2/network-devices 受影响测试 → typecheck、文档目录门禁、contract/qualification/security checks → 一次完整后端 gate。所有命令从仓库根使用 `corepack pnpm --filter slide-api ...`；MySQL 通过 `METRICS_V2_TEST_MYSQL_PORT` 显式指向本任务隔离端口，不读取生产配置。报告记录实际命令、结果和模拟器边界。回退只停用新包/调度绑定，保留历史，不改旧来源。
