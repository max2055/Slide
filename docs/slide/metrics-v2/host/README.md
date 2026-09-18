## Linux Host 代表指标契约

`linux-host@1.0.0` 是 `server` 资源的内置固定采集包。它与 `linux-basic` 分开固定版本，避免改变已有 uptime/load 包的 pin。采集结果全部经过 `runPackage → normalize`；文件系统比例还经过公共 `executeDerived`，Counter 速率由公共 Counter/语义查询处理。旧 `server_metrics` 路径继续存在，迁移期间不双写成同一正式来源。

### 指标与口径

| 原字段 | V2 指标 | 类型/单位 | 口径 |
| --- | --- | --- | --- |
| `cpu_usage` | `linux.cpu.user_system_percent` | gauge / `%` | 固定 `top` 输出的 user+system，占其采样窗口全部逻辑 CPU 时间；是 Host 实测，不是 DB 进程份额 |
| `memory_usage` | `linux.memory.used_percent` | gauge / `%` | `free` 的 used / MemTotal × 100；used 按 procps 的 MemTotal−MemAvailable 口径；不是单个 DB 占用 |
| `filesystem_used_bytes` | `host.filesystem.used_bytes` | gauge / `By` | `df -B1` used，保留 mount/device/fs_type |
| `filesystem_size_bytes` | `host.filesystem.size_bytes` | gauge / `By` | `df -B1` total，保留 mount/device/fs_type |
| 前两项 | `linux.filesystem.used_ratio` | derived gauge / `1` | used / size；分母为零或缺失时为 unknown/null |
| `network_{rx,tx}_bytes` | `host.network.bytes_total` | cumulative counter / `By` | `/proc/net/dev`，方向规范化为 in/out，保留 interface |
| `disk_{read,write}_bytes` | `linux.block.{read,write}_bytes_total` | cumulative counter / `By` | `/proc/diskstats` sector×512，保留 device |
| `disk_io_time_ms` | `linux.block.io_time_ms_total` | cumulative counter / `ms` | `/proc/diskstats` 累计 I/O 时间，保留 device |

Canonical 与 Extension 都包含同样的 resource、metric semantic version、dimensions、quality、source、lineage 和 contract/package/transform/config versions。Host `accuracy=exact`、`production=measured`；与数据库启发式或估算值不能按同一 metric identity 混合。

### 设备过滤与聚合

- 网卡排除 loopback `lo`。bond、bridge、veth 及物理成员若存在，仍作为独立 interface 序列保留；`space=['none']` 禁止把它们盲目相加，因此不会把 bond 与成员重复计入整机值。
- 块设备排除 loop/ram/zram/fd/sr 与常见分区名（如 `sda1`、`nvme0n1p1`、`mmcblk0p1`、`md0p1`）。`dm-*`、`md*` 与物理整盘可能属于不同层，仍分别保留；`space=['none']`，调用方必须明确选择层级，不能整机求和。
- 文件系统、接口和设备行都有 100 系列的包级上限；超限整批报告 parse error，不截断后伪装完整。

### 维度和 Counter 生命周期

- `mount/device/fs_type`、`interface/direction`、`device` 决定序列身份。接口改名产生新序列；删除后停止产生样本，不写零；新增设备先建立基线。
- DriverEvidence 必须为 Host Counter 提供 boot epoch 以及每个 interface/device 的 epoch 和其开始时间。boot 改变或同名设备重现会改变 Counter period，公共处理器输出 unknown/null 并建立新基线，不跨代求差。
- 采集器不从数值下降猜测设备身份，也不把权限、解析或部分命令错误写成零。失败 collector 的观测缺失且 Capability 为 unknown；同包其他 collector 可独立成功。

### 固定命令与开销

包不接收命令或路径参数，只执行 ServerMetricProvider 已固定的命令。完整样本有 4 个 collector invocation、7 条固定 SSH 命令：CPU 1、内存 1、文件系统 3、网卡 1、块设备 1。调度事件沿用 MAX-70 的 SSH 逻辑读计数（每个 implementation 记 2，完整计划记 8）；fixture 同时断言真实固定命令数为 7，二者不冒充协议往返或现场耗时。

合成输入见 `docs/slide/metrics-v2/host/fixtures.json`，包含 Linux/kernel/procps/coreutils 标签，仅证明确定性解析与公共链路行为，不代表隔离主机现场验证。
