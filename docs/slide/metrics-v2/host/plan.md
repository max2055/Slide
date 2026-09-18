## MAX-72 执行契约

日期：2026-09-18。基线从 `origin/main` 的 MAX-68（`8098533`）与 MAX-70（`eea42aa`）合并后开始。

### 范围

- 将现有 Linux CPU/内存 gauge、文件系统 gauge、网卡及块设备累计 counter 接入 CollectorPackage、公共规范化处理器、V2 存储和语义查询契约。
- Canonical 与 Linux Extension 使用同一种 Normalized Observation，保留来源、转换版本、interface/device/filesystem 维度及 counter 生命周期证据。
- 固定 fixture 覆盖重启、设备增加/删除/改名/同名重现、超过 JavaScript 安全整数的 counter、权限失败和部分成功。
- 记录 Linux memory、设备过滤、维度生命周期、旧路径兼容和采集命令成本。

### 排除项

- 不删除 `server_metrics` 旧接口，不把 Host 实测值改写为单个数据库实例用量，不新增 DB CPU/内存估算映射。
- 不新增用户可配置命令、Shell、路径或设备发现范围；只复用现有 ServerMetricProvider 的固定命令和解析器。
- 不改变 SSH 指纹策略，不部署生产，不接触真实生产主机。
- 不修复与本项验收无直接关系的测试、告警、前端或通用调度问题。

### 验收和测试层级

1. focused：主机包、现有包、ServerMetricProvider 与旧 ServerCollector 测试；V2 包快照校验。
2. affected：metrics-v2 合同、处理器、查询、存储、调度测试及 TypeScript typecheck。
3. final gate：slide-api 全量测试、目录门禁、lint、包导出校验及 diff check；代码无变化后不重复。
4. 隔离 Linux 主机：必须是 Linux SSH 采集，经 V2 存储后由语义查询读取；仅 fixture 或本机非 Linux 命令不能代替。

### 资源预算和停止条件

- 硬 token/费用预算未设定；采用单代理、并发峰值 1、无子代理。只记录可取得的测试时间与命令数，不虚构 token 或费用遥测。
- 验收通过即停止；若缺少隔离 Linux/MySQL 环境，仅对应现场闭环保持未通过，不扩展到生产访问或环境搭建。
