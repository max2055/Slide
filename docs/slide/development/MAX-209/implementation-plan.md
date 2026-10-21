# 平台数据库进程内恢复实施计划

> **Execution:** 按 MAX-209 已批准 R1、仓库规则和现有授权执行；主代理实施，不委派。

**Goal:** 平台数据库中断后 HTTP 保活、单 worker 安全排空及恢复，页面保留会话和草稿并恢复只读数据。

**Architecture:** 保留稳定 MySQL pool 与单次 HTTP/schema 初始化。增加单实例恢复协调器，创建不可复用的 WorkerStartup 代次，先排空再重新选举；认证依赖失败单独分类，浏览器共享只读恢复通知。

**Tech Stack:** Fastify、mysql2、TypeScript、Lit、Vitest、Playwright。

## 1. 根因与 RED

- 基线：远端 main `d9ee65a5b02d1a42d1f77f4389f0ee86acf40e06`；当前本地源码 `63b0ef66` 的产品代码与其一致，工作树基线快照 `aeac4385` 含用户文档，不纳入修复 PR。
- `src/lifecycle/worker-startup.test.ts` / 新 `worker-recovery.test.ts`：验证 TTL 以上断连、重复断连、并发故障只关闭一次、他方持租不抢占、standby 不自动晋升、排空阻塞不建新代次、stopping 不再恢复。
- `src/auth/security-boundaries.test.ts` / 新依赖故障测试：真实无效 JWT 保持 401，DB 读取/轮换事务错误为服务失败；HTTP/WS 不继续使用旧授权。
- `frontend/src/api/index.test.ts`：刷新 5xx/网络错误保留会话，未知轮换不重试，真正 401 清除，写请求不因恢复重放。
- `frontend/src/app/ui/views/dashboard.test.ts`：恢复通知重新读取且筛选/日期草稿不丢失，卸载不再读取。
- 执行对应 Vitest，记录失败断言后最小修复。

## 2. 后端生命周期

- 新 `src/lifecycle/worker-recovery.ts`：管理 ready/degraded/recovering/standby/stopping；单次恢复探测、上限退避及抖动；只有已运行者恢复，旧资源未排空则保持安全阻塞。
- `worker-startup.ts`：在停止时同步撤销资格；跟踪迟到初始化和租约查询，排空后才能确认停止；恢复模式不把 release 的暂时失败当成资源排空成功或失败。
- `db-connection.ts` / `worker-lease.ts`：保留 pool，连接和租约检查有界、超时连接销毁/迟到连接释放，保留准确脱敏 SQL 错误码、等待阶段/耗时以区分锁与连接等待。
- `server.ts`：API 初始化和最终关闭只执行一次；所有代次回调捕获自己的 startup；后台定时器停止并等待真实在途工作；新代次重新获取租约和 Agent 实例，不重放业务写操作。
- `get-agent-engine.ts` / `direct-adapter.ts`：单例创建 single-flight；停用后不能重新返回已 dispose 实例；停止接收并取消/等待在途 Agent 操作及 transport 关闭。
- 依赖故障返回 503，存活探针仍 200，就绪反映真实角色/数据库/schema；最终信号停止恢复并关闭资源。

## 3. 认证及页面恢复

- `auth/actor-context.ts`、`auth-middleware.ts`、HTTP refresh 与 WS 入口：身份错误和依赖读取错误分类；拒绝无法实时验证的权限，不伪报过期。
- 新 `frontend/src/api/service-recovery.ts`：失败后单次有界只读 readiness 探测，恢复一次通知；无每页轮询，页面可见时接续，监听可清理。
- API client 不清除网络/5xx会话；轮换结果未知时阻止再发原 refresh token，保留现场并报告需核对/重新认证。
- dashboard 监听恢复，清理只读缓存后重新读取，保留本地筛选/分页/输入；其余当前页面按已有只读刷新入口接入，不重建页面。
- WS 临时故障保持自动重连；达到快速重试上限后由共享恢复通知接续，主动断开和真认证失败保持终止。

## 4. 验证与交付

- focused GREEN 后执行生命周期、认证/授权、工作流、Agent、前端恢复相关模块回归。
- 最终 gate：双方 typecheck、frontend build/CSP、contracts:check、安全测试。
- 隔离 MySQL 和候选服务演练：短中断、>30 秒、重复中断、租约行锁导致检查超时；同浏览器与同应用 PID，真实 overview API 和页面 60 秒内恢复。确认无重复后台实例/写操作；关闭阻塞、他方持租用受控生命周期验证并标明证据层级。
- 保存精确提交、进程身份、日志、截图/业务响应、限制与回退记录；不触碰现有共享 DB/应用，不调用产品 LLM。
- 只提交本任务文件，PR 指向原目标 main，关联 MAX-209；读取当前检查并创建该 PR 的 30 分钟 checks 接续；一次最终 issue 评论交付。

## 停止条件

旧代次未确认排空、外部结果未知、只能操作共享数据库或需要扩大权限时停止对应步骤；其余独立工作继续。必要验证缺失不宣称完成。
