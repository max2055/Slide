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

## v1.2.18 共享装配续接（2026-10-13）

既有批准方案与最小 patch 继续适用。T08 PR163 merge `1091de79` 已合入托管分支；原领域 PR165 保留，不重做 T09-A。

1. 诊断 CI38391559605 的普通 Chat 启动时延：下载原 trace/wire，分离持久化与浏览器调度边界；不重试旧 CI、不调整100ms门禁。相关既有缺陷仅有明确根因且属于授权范围时修复。
2. `system-composition.ts` 固定服务主体、四个 component policy、共享预算 domain；提供显式 install/close/drain/uninstall，事件及自动调查分别默认关闭。server 复用正式 pool 与 worker 生命周期，注册摄入 handler。生产不打开自动调查。
3. executor 按不可变调查 context 创建五个专属只读工具；每次 live tool 重新绑定实时 actor。System 无专属 registry 时关闭工具准入，不能退回普通 platform tools。canonical/fence/Run/ledger owner 不变。
4. System 专属只读 events/facts HTTP 契约、注册及生成类型；实际用户实时授权，原事件持久查询包括 suppressed，关联调查仍要求原 ACL，不能用 service 身份开放内容。
5. 在既有浏览器夹具复用正式 composition/worker/routes，新增持久错误→事件→调查→System tools→canonical→WS→workspace→两轮追问；真实MySQL重复迁移、撤权/400/403/自身故障、source版本缺口由相关SQL测试补齐。受控Provider仅证明受控链路。
6. 受影响 focused/security/contracts、本地浏览器、准确新head CI一次前台收集；更新原PR、证据与一次终态交接。父独立Review、真实Provider缺口或CI未齐全时保留in_review，不合并、不释放下游。

## v1.2.25 长期授权续接（2026-10-14）

Max评论01a137d7-4d36-757f-a0ad-2d92cb91299b覆盖旧模型调用授权限额和失败后审批，不更改产品技术保护。原两场景6051 token、四请求和T04五请求保留。

1. 已完成opt-in长期授权、哈希链/claim/累计usage、显式worktree路径映射；未知发送/usage继续失败关闭，零调用RED/GREEN保护测试15通过。
2. 已完成独占正式MySQL/重复迁移、已有配置SELECT与真实DeepSeek三次请求；模型自主消费全部五工具/原事件/精确版本/源码并生成最终回答。
3. 已完成真实completed SQL故障、新进程/新fence恢复和终态重投；同一Run、一版结果、五证据、零Provider重发。新增6485 token，T09累计12536，跨阶段12请求。
4. 准确新head CI及父独立Review/普通merge/main仍为完整出口；本轮交付in_review，不自行释放共享owner或T10/T12。旧144.5ms失败历史保留，100ms门禁不变。
