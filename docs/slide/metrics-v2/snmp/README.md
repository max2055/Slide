# SNMP representative collector (MAX-73)

`apps/db-ops-api/src/metrics-v2/snmp/package.ts` 的 `createSnmpPackage()` 返回含既有内置包和新包的 registry、release、pin。`snmp-standard@1.0.1`（默认版本）独立于旧 `if-mib-basic@1.0.0`，不改变旧摘要或默认来源。将返回的 registry 提供给既有 PolicyService/MysqlScheduleStore/MetricScheduler；按资源显式发布新 pin。不得同时让旧来源与新来源作为同一指标的正式来源。

## 宿主接入

`CollectorAccess.resolve(ref)` 必须先授权确切资源，从凭据引用解析该设备的 SNMP 配置，再返回：

```ts
// Cache discovery by authorized resource + target/config identity, not credential alone.
const discovery = new SnmpDiscovery();
const transport = bindSnmp(client, snmpConfig);
return { resource, credential_ref, evidence: { snmp: discovery },
  resolve: async (_reference, actualResource, method) => {
    if (_reference !== credential_ref || actualResource.id !== resource.id || actualResource.type !== resource.type || method !== 'snmp') throw new Error('EACCES');
    return transport;
  } };
```

同一设备连续采集复用 discovery；设备目标、授权配置变化或进程重启时新建，不能跨资源共享。目标安全策略与凭据授权仍由宿主负责；采集器不加载 `.env` 或持久化秘密。传输复用 `SnmpClient` 的 allowlist、响应大小约束、会话关闭及固定 get/table；不拼接用户输入 OID。runner 对每次 get/table 执行取消/fencing 检查；已在途 SNMP 请求不能被 abort 撤回，迟到结果由公共 scheduler 隔离。

默认 60 秒、超时 5 秒、最大缺口 300 秒、最多 64 个接口：覆盖 48 个常见接入口，并预留 16 行用于上联、管理和逻辑接口（24 端口设备也在此范围内；逻辑接口较多的设备仍可能超过容量）。1 个资源观测 + 每接口 15 个观测，由 resolver 派生标准包默认 961 series 预算；厂商包再加 2，仍受每资源 10000 series 总上限约束。

超过配置行数时，接口 attempt 为 `failed / parse_error`，附 `SNMP_INTERFACE_CAPACITY_EXCEEDED`（接口数量超过采集容量）；直接调用采集器的异常还包含调整提示。此时不会发布部分接口发现、删除旧接口状态或把未读到的接口判为消失，恢复后重新建立速率基线。ifNumber、ifTable 和 ifXTable 的超限均整轮拒绝，不截断。普通 ifXTable 不支持/传输失败仍按原有字段质量规则处理。

调整办法：在现有指标采集策略中显式同时提升 `max_rows` 与 `max_series_per_resource`（标准包至少 `1 + 15 * max_rows`；厂商包再加 2）。例如 100 行需标准包至少 1501 series。平台硬上限仍为 100 行，超过时本版本不能靠继续增加配置采集完整接口表，需在设备端缩小授权 SNMP 视图范围；持久身份模式下 ifNumber 必须与该范围一致，否则完整性校验仍会拒绝。

注册表保留原 `1.0.0` 的摘要与 6 行推荐值；新增 `1.0.1` pin 提供 64 行默认值。服务重新加载新版注册表后，新绑定选择新版包；已有绑定须通过原有配置发布流程显式升级至新版 pin 后生效，既有资源/分组显式覆盖值保留，若仍设置 6 行须调整或继承。不会自动改写历史绑定或放宽其预算。一次系统 GET 和一次接口逻辑采集共享所有该组指标；接口逻辑采集含 uptime GET、ifTable walk、ifXTable walk、uptime GET。walk 可有多个 UDP PDU；scheduler 的 logical_reads 不是 UDP 包数量。

## 指标与口径

| Metric | 原始来源/单位 | 行为 |
| --- | --- | --- |
| `snmp.agent.uptime_seconds` | sysUpTime TimeTicks / 100，s | SNMP 管理子系统 uptime，不宣称整机 uptime |
| `network.interface.oper_up` | ifOperStatus，1 | 复用 Canonical：up=1、down=0，其余未知 |
| `snmp.interface.admin_up` | ifAdminStatus，1 | up=1、down=0，testing 未知 |
| `snmp.interface.speed_bits_per_second` | ifHighSpeed × 1,000,000，fallback ifSpeed | 每方向标称 bit/s；ifSpeed 饱和值无替代时未知 |
| `snmp.interface.{rx,tx}_octets_total` | ifHCIn/OutOctets 优先，fallback ifIn/OutOctets，By | Counter64 ASN.1 Buffer→bigint→十进制字符串，禁止不安全 Number |
| `snmp.interface.{rx,tx}_bits_per_second` | 公共 Counter rate + By/s→bit/s | 独立方向，不把 rx+tx 除以单方向容量；全双工利用率分别以 speed 为分母 |
| `snmp.interface.{rx,tx}_{errors,discards}_total` | ifIn/OutErrors、ifIn/OutDiscards，count | 标准 Counter32；不虚构 HC error/discard OID |
| `snmp.interface.{rx,tx}_{errors,discards}_per_second` | 公共 Counter rate，count/s | 缺可信计数上限时未知，原始计数仍可查询 |

来源、模板/转换版本、config revision、raw lineage ID、位宽与中断证据随公共 observation 持久化。具体 OID 来自 `collector.ts` 固定目录与包文档；Counter 中断 epoch 带 `ifCounterDiscontinuityTime` 原始 ticks（或 unknown），证据类型区分 boot/reset/source_change/initial。端口维度为 if_index + interface_epoch，名称、描述、MAC 只参与身份指纹，不扩展指标维度。

历史带宽查询选择已持久化的 `*_bits_per_second`，使用公共查询的 gauge last/min/max/mean。原始 SNMP counter 定义只允许 last，拒绝绕过采集时位宽、速度与处理版本边界重新计算 rate；公共 rate 计算仍用于生成这些派生观测。无需更改冻结 wire schema。

## 质量及连续性

- 初次采集、进程/设备重启、ifIndex 身份变化、消失后重现、来源/位宽/速度/配置切换均重新建基线。一次完整空表会清理退休接口状态；整表读取失败不会制造“消失”。
- uptime 前后回退、异常增长及 TimeTicks wrap 均保守中断，不声称可区分 agent 重启与设备重启。ifCounterDiscontinuityTime 缺失/非法时不生成连续速率。标准 MIB 无法区分两次轮询之间完全相同身份、相同中断证据的物理替换；不宣称硬件唯一身份或厂商实机兼容。
- Counter32 上升也必须满足容量×时间小于 2^32；下降没有明确 wrap 证据时未知，不猜测回绕。32/64 位增量超过容量上限均拒绝。缺口走公共 gap 规则，非零计数不会被替换为零。
- 单字段 malformed 不回退到低位计数；未知、unsupported、权限失败与 timeout 有区分。ifX 失败保留健康状态字段并标记计数未知，下一次重新发现；完整失败由既有 Worker 有限重试。unsupported capability 到期后可重新探测。
- SNMP attempt/capability 只代表 SNMP；不读写 SSH 配置备份状态。

## 既有厂商 Extension

`createSnmpPackage(reviewedCatalog)` 与 `new SnmpDiscovery(clock, reviewedCatalog)` 必须使用同一已审核 `HuaweiMibCatalog`，资源属性 `snmp.vendor_fixture` 必须匹配版本。implementation ID 含完整目录摘要，包摘要含映射/比例/OID 文档，不能误用另一目录。CPU/memory 仍为 `huawei.device.*_percent` Extension，与 Canonical 走相同 normalization/storage/query/quality；默认标准包没有 enterprise OID。温度因冻结单位目录无 Celsius 而不映射。`fixtures.json` 只复用既有 `huawei-adapter.test.ts` 的 vrp-test-1 示例，不新增或验证私有 OID。

## 回退与验收边界

停用新绑定或不注册新包即可回退；保留观测和状态以供审计，旧采集器/数据库 schema/生产启动路径均未切换。验收由脱敏 fixture、真实 localhost UDP SNMP 模拟器及隔离 MySQL 完成，不等待 UI/消费方任务，不证明任何厂商实机兼容。具体命令及结果见 `validation.md`。
