## 统一候选完整入口发现的既有阻塞（2026-10-21）

首轮统一候选 `9752d2aad98993ec8fff5a5047753de02ca88bb5` 在 MySQL 9.6 的完整平台快照、隔离 API/Vite、真实登录后触发连接池饥饿。API PID 10080、前端 PID 10081：9 个连接等待 `metric_policy_lock` 行锁，持锁事务等待同池库存查询，控制面 checkout 4 秒超时。Worker 按既有安全边界降级并等待排空，不以替换 worker 绕过在途工作。

`MysqlPolicyStore.transaction` 在固定 main 基线与所有相关候选中都先占连接、再等待全局锁；策略 effective/发布回调会通过共享 pool 读取库存。这是有真实证据的相关既有缺陷，直接阻塞 MAX-209 的稳定服务验收，故回原 PR 修复；不在集成分支另起产品实现。历史未留数据库层证据的其他超时仍不能归因于此。

修复仅把同一 pool 的策略事务等待移到连接 checkout 前，跨 store 实例共用 FIFO admission，最多等待 100 个请求，超限 503；仍通过数据库行锁跨进程串行化，事务内实时授权、CAS、提交/回滚不变。异常及 checkout 失败均释放 admission。不增加 pool 大小，不延长租约，不跳过 fencing。

真实 MySQL 双连接回归：两个 store 并行事务、各自需要同池库存读取，修复前 `ER_LOCK_WAIT_TIMEOUT`，修复后两项通过（含异常回滚后后续事务完成）。完整入口失败日志、SQL等待诊断和 RED/GREEN 记录归统一集成交付；更新后的候选仍需完整入口复验及最终 gate，不能仅凭 focused 测试或旧 head 的绿 CI 判为通过。
