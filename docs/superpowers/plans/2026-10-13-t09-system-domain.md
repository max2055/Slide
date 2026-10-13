# T09 System 领域实施计划

> **Execution:** 在既有授权和文件所有权内执行；不派生代理。共享装配由父任务移交后继续。

**Goal:** 持久异常先落库、异步摄入统一事件，并提供严格版本匹配的只读 System 证据工具。

**Architecture:** 复用 workflow_jobs 保存有界脱敏原始事实及投递幂等键；后台 handler 消费数据库事实并复用 MysqlOperationalEventIngest 的权限、聚合和预算事务。System 工具绑定调查，复用实时授权与 SourceManagementService；事件 Commit、当前 deployment 和签名 manifest 必须一致。

**Tech Stack:** Fastify、TypeScript、mysql2、Vitest、既有 Workflow/Investigation。

批准输入：MAX-150 当前 v1.2.16、父任务 implementation-baseline.md / menu-addendum.md。保留 T09-A 历史。起始托管 Commit `6fa44775`，main `99462990` 已合入托管分支；用户 AGENTS / 私有 .multica 不进入功能 PR。

1. 新增 `investigations/system-event-bridge.ts`：不可变 durable fact、重复 payload 校验、只消费数据库原件、source-bound ingest handler、关联调查的有界事实查询。无新 schema、无第二 execution owner。
2. 新增 `platform/system-failure-publisher.ts`：有界非阻塞提交、明确 lost-event 计数和 drain；默认未装配。修改 observation / runtime / collector / worker 的失败挂钩；不把请求体、job payload 或模型文字录入异常。
3. 新增 `investigations/system-tools.ts`：既有五个 System 工具；实时权限和工具策略交集；有界 log/job/error 查询；精确 event/deployment/manifest 匹配；缺失/不匹配只返回 gaps。源码为不可信实现参考，不是根因验证。
4. 新增直接单元测试和真实隔离 MySQL 正式迁移测试：durable 写入后无 admission，后台摄入、去重/冲突、服务重建及独立进程查询、400/403、engine 防递归、撤权、数据库失败；源码完整/缺失/错 Commit/partial/读取期间版本变更。
5. 运行 focused、相关 platform/worker/collector 回归、API typecheck、contracts、安全扫描。此阶段不改同步链路；若实际需要改动同步服务再运行专项真实 HTTP sync 验收。
6. 交付最小 PR、准确 head CI 和验收材料。完整生产 System 链路受 server / handler 注册 / executor BACKGROUND_SAFE 的共享所有权约束，提出具体移交 patch，不能把测试装配称作生产接入；父 Review 前不自行合并。

停止条件：领域交付可审阅；仅未授权共享步骤暂停。零新增外部模型请求；无生产部署；无硬 token/费用预算，实际遥测不可用时如实说明。
