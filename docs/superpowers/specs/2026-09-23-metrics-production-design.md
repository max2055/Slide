# MAX-85 生产接线设计

沿用 MAX-85 任务正文及 2026-09-23“好的，继续实施”批准的方向，以 main `2da7b2d` 为基线。本文记录实施边界，不代替完整生产验收。

## 生命周期与数据流

API 进程先执行 migration ledger，再由持有既有 WorkerLease 的实例注册 `metrics.collect`。`METRICS_V2_COLLECTION_ENABLED=true` 才启动周期 tick，缺省关闭。JobRegistry 和 WorkerRuntime 仍只有应用已有的一套；tick 只负责幂等入队。关闭时停止 tick、停止 claim、等待在途任务；租约丢失关闭本实例 workers。

生产访问按服务端资产 ID 重查成员资格，凭据仅通过资产服务解析。数据库缓存连接必须与当前地址、端口、用户、数据库和凭据一致。SNMP discovery 按资产隔离，在目标或凭据改变、缓存淘汰、进程重启时重置，缓存不保留明文秘密。缺少权威 SQL/Host epoch 时仍拒绝推导计数速率。

每次 Worker 在远程读取前，持有策略锁并捕获该资源已登记序列的 source/generation/revision/package pin。只在计划、pin、revision 匹配时写 applied；提交时再次验证工作租约、fencing token、策略 revision 和来源 ticket。没有匹配 ticket 的结果只入 shadow 存储，新的动态维度也必须显式登记后才能正式发布。Raw 和 Normalized 证据同事务落库；Raw 永远不进入 publications。

正式 V2 消费者只从 publications 连接 observations 和 rollout 读取。pending 或 legacy 读取模式返回缺失 V2 证据；不从 shadow 自动兜底，不把缺失/未知转换为健康或零。历史 publications 保留，latest 在新 revision 未产生正式结果前返回空。

## 迁移与兼容

098–101 保持原文。新增 102 给 rollout 序列登记资源身份；已有 latest 能安全恢复身份时回填。无 latest 的旧登记无法从单向 series hash 反推资源，不猜测归属，保持未接线状态并列入上线核查。

## 验收分界

本地验证覆盖生命周期、资产隔离、Raw 落库、动态 ticket fencing、shadow 隔离、MySQL 新建/升级与修复、既有三类隔离测试及工程门禁。真实生产验收仍要求权威 epoch、完整旧写入/消费接线、真实目标版本/物理设备、峰值容量、分批放量与回退。没有这些证据时保持 NO-GO。
