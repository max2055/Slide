# MAX-71 执行契约 v1

基线 `eea42aaa6c97b0a208386d03e18a5fe3381a92a6`（main），包含 MAX-68 PR #81 的 `809853320c56903ed60c1a3fea61281fa07ccbaf` 与 MAX-70 PR #83。实施分支 `agent/15astra/max71-database`；原任务工作树已有改动保持原样。

范围：四引擎代表连接/限额 gauge、事务 counter/rate、MySQL/PG已有大小语义及 MySQL Canonical uptime/Extension Queries，经已有公共链路接入。独立代表包避免修改旧不可变 release。依赖内接口复用，PG 多维度公式隔离是直接阻塞本项接入的必要 runner 修复。

排除：全量诊断扩展、CPU/内存假利用率、新 UI/告警/Agent 消费、生产切换和其他引擎实库资格认证。只使用隔离 MySQL，不操作现有数据库数据。

验收：

- 确定性合成 driver fixture：四引擎、MySQL三个版本家族、精确 counter、缺失/NULL、权限/timeout、取消、重启及旧新连接 gauge 对比。
- 同语义 uptime 契约一致；不同连接/事务/大小语义独立 ID，不允许强映射 Canonical；PG database 维度不广播。
- 隔离 MySQL 8.4 真实 SQL → PolicyService → 既有 Worker/MetricScheduler → normalized 存储与派生 → SemanticQueryService，验证重建 Worker/store 后续算及版本属性独立存储。
- focused checks → 受影响模块与兼容回归 → 最终一次完整后端 gate；类型、文档目录、fixture/release、API 契约与秘密扫描检查。

硬预算未设定。实际 input/cached-input/output token 与费用遥测不可用；子代理0，最大子代理深度0，并发代理峰值1。测试资源仅一次性 localhost MySQL 容器及隔离工作树。

停止条件：前置未合并、必须验收被不可恢复环境阻塞、涉及生产副作用或需未授权凭据时停止受影响步骤并报告；不以环境缺口代替必需 MySQL 验收。无关失败记录，不扩展为通用修复。完成后提交 PR 等待人工验收，CI 状态单独披露。
