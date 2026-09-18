# 内置采集包与不可变版本

MAX-67 基于 MAX-64 CollectorPackage 和 MAX-66 公共处理器。Monitoring Template 就是 CollectorPackage 的发行物，不建立另一种模板身份。实现入口：`apps/db-ops-api/src/metrics-v2/packages/index.ts`。

## 发行物与版本规则

`PackageRelease` 的 `package` 使用已有冻结契约。附件包含 Extension 定义、DerivedMetric DAG、公共 Transform 版本引用、推荐参数、权限和发现说明；不接受 Canonical 定义、CoreProfile、SQL/Shell/OID 或第三方脚本。附件与 package（排除 digest 自身）按对象键排序、数组原顺序编码，整体计算 SHA-256 写入 `package.digest`。摘要校验是完整性校验，不是签名或发布者认证。

`PackageRegistry.install()` 校验所有依赖、单位和语义签名，跨 collector/derived 检查重复输出；同一 ID/version 内容不可修改，同一包跨版本不能改变资源类型。相同内容重复安装幂等。实现只接受代码内白名单；改变固定读取/解析语义时必须新增 implementation_ref 版本，不能修改原版本实现后沿用旧包摘要。

发行物 schema 和四个发行物快照见 [schemas.json](schemas.json)、[builtins.json](builtins.json)。运行覆盖和凭据引用不进入发行物；没有 `latest` 或隐式自动升级。包级 `Selection` 是用于版本选择的输入，不是另一个持久 CollectionBinding；MAX-69 将其对应到既有绑定/策略存储。

`switchVersion()` 必须明确给出 ID/version/digest，原版和目标版都必须存在。它复制保留 credential_ref 和 overrides；不修改原对象，不把新推荐值写入用户配置。用户显式设置优先于推荐值，未覆盖项使用所选版本推荐；如果保留的覆盖违反目标版时序约束，明确拒绝升级，不能静默删除覆盖。降级使用同一方法。旧发行物没有删除 API，可以继续固定/回退。

## 内置范围

| 包 | 适用条件 | 固定实现/发现 | 映射与处理 |
| --- | --- | --- | --- |
| mysql-basic@1.0.0 | MySQL 5.7、8.0、8.4；不宣称 MariaDB 或其他版本兼容 | 复用 MySQLProvider 的 `SHOW GLOBAL STATUS` Queries/Uptime 固定批量查询；只读单实例，无库枚举；需 SHOW GLOBAL STATUS 权限 | Uptime → Canonical db.uptime_seconds；Queries → Extension mysql.queries.total（精确 uint64）；公共 derive@1.0.0 的 rate → mysql.queries.per_second |
| linux-basic@1.0.0 | os.family=linux，具备 Linux procfs | 复用 ServerMetricProvider 的固定 uptime/load_1min 命令与解析；单资源，无输入路径；普通 SSH 登录与 procfs 读取权限 | linux.uptime.seconds / linux.load.one_minute；公共 normalize@1.0.0；load 不是 CPU 百分比 |
| if-mib-basic@1.0.0 | SNMP v2/v3 标准 IF-MIB，各厂商 | 复用 SnmpClient 和现有标准 MIB catalog 的 ifTable；按 ifIndex 发现；需只读 IF-MIB 视图 | Canonical network.interface.oper_up；1→1，2→0，其他合法枚举→unknown/null；维度为 if_index/interface_epoch |
| linux-host@1.0.0 | os.family=linux；驱动提供 boot/interface/device epoch | 复用 ServerMetricProvider 的固定 top/free/df/findmnt/procfs 命令和解析；无输入命令或路径 | Host CPU/内存 Extension、Canonical filesystem/network、Linux block Counter；公共 normalize/derive/Counter/query；完整口径见 [../host/README.md](../host/README.md) |

这是三种协议的首批代表包，不表示已迁移所有历史指标或所有数据库引擎。未知厂家与 Huawei 均只读取标准 `1.3.6.1.2.1.2.2`，没有 enterprise/private OID。SNMP agent 的 sysUpTime 不映射为数据库或设备真实启动时长。旧 MySQL CPU heuristic 不映射为 Canonical CPU 利用率，Host CPU/内存也不归因给单个数据库。所有 Extension 使用相同 Observation schema、单位、维度、质量和类型校验及公共处理器。

推荐 60s 周期、5s 单读取超时、120s stale、300s 最大 counter gap、最多 100 行。运行覆盖允许启停、上述时序和 max_rows；周期 1s～24h，读取超时 250ms～30s，max_rows 1～100。实际单读取超时取覆盖值与 CollectorDefinition 上限的较小值；SSH 两条固定读取各自受限，SNMP 重试语义由已有客户端配置控制。没有包提供的路径/SQL/OID 参数。

## 执行与能力

`runPackage(registry, selection, execution)` 单次执行，返回独立的 observations、attempts、capabilities、states。`decision=attempted` 只表示已进入尝试，成功与否查看每个 attempt，不能当成功标志。读取失败不产生假零/伪观测，不推进计数基线；未知状态有真实响应证据时产生 unknown/null Observation。每个 collector 的解析/校验失败丢弃该批次，其他 collector 不受影响。derived 输出血缘引用其输入，不伪装成新的协议读取尝试。

资源类型/引擎/版本不适用：unsupported，带 resource/version 依据，不解析凭据、不发请求。缺少必要属性：unknown。权限/认证不足：失败 attempt.error=permission_denied，Capability unknown + permission 依据；不与不支持混淆。临时超时：attempt.error=timeout，保留仍有效且资源/metric/method 匹配的旧 Capability（保留原有效期）；无有效旧记录时为 unknown，不置 unsupported。解析错误、连接错误分别记录稳定类别，返回结果不含远程错误原文或秘密。

SQL 的 counter 必须带驱动确认并稳定保存的 `start_at` 或 discontinuity/epoch（bits=64）；缺失时拒绝该批次，不根据当前时间臆造启动时刻。驱动提供的是证据而非 delta/rate 算法；首样本、reset、wrap、乱序、间隔和版本变更均由公共处理器裁决。SNMP 发现必须提供每个 ifIndex 的稳定接口代际（接口删除/复用时变更），未提供则拒绝批次。重复 index、超额发现和非法响应同样拒绝，不静默截断。

调用方以完整资源身份提供 observed_at，clock 提供 collected_at；建议驱动以读取快照时间作为观测时间，不能把任意排队开始时间当真实采样时间。公共处理器保留输出窗口、质量、accuracy、production 和输入血缘。当前接口不负责持久化、锁/CAS、重放提交或全局维度基数累计。

## 凭据与接入边界

Selection 只接受 `credential:<opaque-id>`。`resolve(reference, resource, method)` 必须由上层返回已完成目标授权、凭据解析的资源专用 transport；包不能创建任意连接。MySQL 用 `bindMySql(pool)`；SSH 提供已有 SshSessionPool 与已获取的 Client；SNMP 用 `bindSnmp(client, config)` 闭包短期携带已解析配置。凭据不得写入 Selection、包、日志或返回结果；上层负责租用/释放连接与引用权限。

SSH 继续走已有可选指纹逻辑：未配置可连接，配置后必须验证，非法指纹拒绝；本项不恢复全局强制指纹。MAX-55 不构成本项前置。

```typescript
const registry = createBuiltinRegistry();
const release = builtinReleases()[0];
const selection = registry.select({
  package: { id: release.package.id, version: release.package.version, digest: release.package.digest },
  credential_ref: 'credential:resource-1',
  overrides: { interval_ms: 30000 },
}).selection;
// 传入 PackageExecution：资源属性、真实时间、来源身份、驱动证据、resolve 和上次 states。
// const result = await runPackage(registry, selection, execution);
// 调用方验证租约/CAS 后再提交 result.states 和 observations。
```

持久绑定与策略解析归 MAX-69，调度及状态提交归 MAX-70；本项不接入现有后台定时器、不迁移数据库、不改变 CoreProfile，也不宣称内存包测试完成这些外部保证。包升级导致公共处理器隔离基线，首样本 rate 为 unknown/null；回退同理。

## 验证与回退

[fixtures.json](fixtures.json) 为明确标注的合成协议响应，包级测试确实调用公共 normalize/executeDerived，不 mock 其算术。物理数据库/主机/设备资格认证不是本项包级 fixture 验收；后续接入须验证真实权限、启动证据和接口代际来源。

从仓库根目录执行：

```bash
pnpm --filter slide-api exec vitest run src/metrics-v2/packages
pnpm --filter slide-api exec tsx src/metrics-v2/packages/export.ts --check
pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts
```

回退选择旧 ID/version/digest，用户覆盖及凭据引用保留。代码回退撤销本项提交；共享 SQL 常量的文本与原查询相同，无数据迁移或生产发布。验证证据见 [validation.md](validation.md)。
