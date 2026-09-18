# MAX-70 采集计划与 Worker 集成实施计划

> Execution: 在既有授权、冻结契约及仓库规则内执行。

目标：从已生效策略生成共享 Collector 计划，经既有 Worker 调用公共转换/Counter/Derived，持久化调度、应用 revision 与受 fencing 保护的输出。

基线：origin/main ee4485926083b6a525bfc7c440559c4f13132174；包含 MAX-66 #78、MAX-67 #80、MAX-69 #82、MAX-53 #61、MAX-52 #62。分支 agent/15astra/max70-scheduler。

范围 v1：纯计划编译；包 runner 的可选计划过滤、取消检查、共享请求与逐输出失败隔离；MySQL 调度适配器与 JobRegistry 注册；隔离 MySQL/双 Worker、fake clock 测试及文档。复用 collection-scheduler 的到期计算和既有 WorkerRuntime，不经 Cron。资源级周期继承冻结策略，不增加每指标周期配置。

排除：生产启用、UI、MAX-71～76、平行 runtime、公共取消缺陷重做、外部 exactly-once 承诺。内部入口显式注入资源专用 transport/evidence；无公开 HTTP 采集入口，不将管理权限当跨资源凭据权限。

预算：硬预算未设定；主线程执行，无子代理；实际 input/cached/output/费用遥测不可用。停止条件：验收通过并交付 PR；必要前置或接口冲突无法在授权范围解决时保存证据并阻塞相关步骤。

## 设计与取舍

使用既有 workflow_jobs（有限重试、退避、lease、fencing）和增量调度状态表，调度扫描可重复执行；重启从持久状态恢复。拒绝单独内存 timer runtime（无法跨 worker 协调），也不把包执行迁到 Cron（无额外收益）。数据库 named lock 在未收敛 handler 生命周期内保留资源互斥及全局预算槽；锁不是 fencing 替代，结果提交同时校验当前配置与队列 owner/token/lease。连接丢失/进程崩溃不保证目标请求撤销；记录不确定性与测试边界。

## 实施顺序与验收

1. `scheduler/compiler.ts`：校验生效配置、展开依赖、唯一来源及共享查询分组，确定周期/错峰。单元测试验证禁用/无效配置、高成本周期、维度模板。
2. `packages/runner.ts`：可选 Collector/指标过滤；每次 transport 调用前检查取消；每输出独立 normalize，保留公共 derived 和状态；测试部分失败、取消后无新请求。
3. `scheduler/store.ts`、`scheduler/service.ts`、增量 migration：持久调度与原子入队；资源/全局锁；实际应用 revision；同事务输出、Counter 状态及 schedule 提交；记录迟到/不确定结果。
4. `scheduler/*.test.ts`：fake clock 频率、错峰、超时；隔离数据库双 Worker 丢租、旧 owner fencing、新 owner 成功、版本切换、重启、去重、并发预算。
5. 运行受影响模块、公共 Worker/权限回归与目录 gate，记录命令、结果、查询量、峰值、duration；提交 PR。本地和 CI 分开报告。

回退：停止调用调度 tick/注册器，保留新增表及历史；原采集路径未切换。不删除状态或回滚已有指标表。
