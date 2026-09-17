# MAX-53 Worker 取消与生命周期验收

## 执行契约 v1（2026-09-17）

- 基线：实施前 fetch 并复核 `main@de02dc0`；独立分支 `fix/max-53-worker-cancellation`。原工作树修改未纳入本 PR。
- 范围：WorkerRuntime → JobRegistry → 业务 handler 的取消传播、续租失败/异常/超时、关闭、迟到请求与资源清理；保留 owner + fencing token + lease 数据库谓词。
- 排除：审计05的持久投递状态机、外部 exactly-once、审计03的 Agent/Cron 在途执行取消、无关重构。不撤销已经提交的请求/写入。
- 测试层级：运行时和真实业务服务 focused tests；双 Worker + 生产通知注册 + 真实 Nodemailer + 隔离本地 SMTP；最终后端测试、类型检查、契约、资格矩阵、lint。
- 硬预算未设定。停止条件：范围内实现和可独立运行验证完成；审计05未提供实现时保留联调缺口，不扩展实施其状态机。
- 无范围扩张。业务服务检查点属于原有“实际 handler 丢失租约后不再开始后续操作”的必要接线。

## 执行契约

`runOnce((job, context) => registry.execute(job, context))` 传递每次执行独有的 `signal`、`workerId`、`fencingToken`。JobRegistry 在入口和返回处检查取消，并通过 AsyncLocalStorage 将同一上下文传入嵌套业务服务；并发 API 请求不会共享该信号。单独调用 registry 时保留兼容的独立未取消上下文。

- 续租 false、异常和超时：signal reason 为 `Error('WORKFLOW_LEASE_LOST')`，停止心跳，不再发起 complete/fail；合作 handler 返回后 runOnce 为 `retry`。
- shutdown：reason 为 `Error('WORKFLOW_SHUTDOWN')`，拒绝后续 claim；默认最多等 5 秒，返回 false 表示仍有未收敛执行/续租请求。已经提交的终态 SQL 也不能撤回。
- 未合作的 handler：保持该 Runtime 的执行互斥，不使用 Promise.race 后释放槽位；挂起期间 runOnce 返回 running（关闭后 cancelled）。可由其他 Worker 在 DB lease 过期后接管。完全不检查取消的代码仍可能产生副作用，必要时由进程隔离/重启处置。
- 未返回的底层 DB 续租：计时器和 abort listener 清理后，仍保留一个等待槽位，禁止重复调度累积底层查询；迟到成功/失败不会恢复旧 signal，查询结束后才允许下一轮。
- claim 期间关闭：迟到 claim 不启动 handler，租约自然过期。数据库驱动请求本身不支持本次取消。
- Fastify onClose 和进程关闭路径均停止定时调度并调用 shutdown。

通知/报告生产 handler 提取到 `src/workflows/notification-handlers.ts`，仍由 server 注册。网络、SMTP 和落库步骤之间检查 signal。通知退避使用可取消等待，HTTPS 使用原生 AbortSignal。SMTP 在途发送不能保证撤回；连接/问候/套接字等待设 10 秒超时，发送结束 finally 关闭 transport。超时是阶段/空闲边界，不是外部 exactly-once 或总执行时限。

诊断、容量、基线清理、告警及事件/RCA、报告生成与调度的异步业务步骤检查相同上下文。清理内存锁先于抛出取消；诊断监控取消后不再发起下一轮。已提交的 DB 操作或已派发 Agent 仍按在途操作处理，Agent 执行取消属于审计03。报告 occurrence / delivery 的 started、running 或部分业务写入可能保持不确定状态，恢复/对账策略属于审计05；本变更不将取消伪装成 sent、failed 或 exactly-once。

## 验收映射

| 验收项 | 结果与证据 |
| --- | --- |
| 1. 续租 false/异常/超时取消，stale worker 无后续终态写入 | 已验证：worker-cancellation.test.ts、worker-runtime.test.ts；保留原 MySQL owner/token/lease SQL 谓词测试 |
| 2. 合作 handler 无新副作用，重复 runOnce 不累积资源 | 已验证：取消通知退避、嵌套诊断、RCA 锁清理、底层续租隔离；定时器归零；迟到续租后恢复 claim |
| 3. 双 Worker、恢复、不合作和在途行为 | 已验证：notification-worker.integration.test.ts 使用生产注册的两个 handler 和真实本地 SMTP。A 在渠道读取期间丢失 lease；B 过期接管后接收端各收到一封，只有 B 终态落库；另测 SMTP 已接收后关闭，只保留 started，不伪造结果。运行时另测不合作挂起、关闭超时、关闭期间 claim |
| 4. 与审计05联调 | **未完成**：MAX-54 当前为 todo 且无实施版本。已提供上述隔离接收端和同一生产 handler 的联调夹具，尚未验证审计05的持久投递状态、业务幂等和恢复决策；不得据此关闭整个问题 |

SMTP 测试只连接 127.0.0.1 的动态端口，不向真实联系人发送通知。双 Worker 测试的 WorkflowStore 为具有 owner/token/expiry 谓词的内存模型，不是真实 MySQL。既有 MySQL SQL 谓词单测不等同于真实数据库故障注入。未启动生产服务、未迁移生产数据库。

## 验证命令与结果

- RED 证据：初始取消传播三项失败；通知实际重试逻辑从预期一次变三次；嵌套诊断取消后仍 checkHealth；迟到续租仍允许 claim；RCA 取消后锁未释放。对应修复后 focused checks 通过，RED/GREEN 检查点保留在 Git 历史。
- `pnpm --filter slide-api test`：255 个文件通过、1 个文件跳过；2148 项通过、13 项跳过。原有可选集成测试的跳过不计为通过。
- `pnpm --filter slide-api typecheck`：通过。
- `pnpm contracts:check`：通过，生成契约未变化。
- `pnpm qualification:matrix`：37/37 findings 映射通过；这不是代码覆盖率。
- `pnpm lint`：0 errors，263 warnings；未扩展修复无关警告。
- `git diff --check`：通过。
- 未测量行/分支覆盖率；不将测试数量或资格矩阵冒充覆盖率。

## 审计05对接要求

在本 PR 分支上复用 registerNotificationHandlers 和 JobExecutionContext；在新业务状态转换、外部请求及重试前检查 signal。signal reason 可区分 lease lost 与 shutdown，fencingToken 只证明执行代次，不是稳定业务幂等键。

继续扩展隔离接收端场景：发送前失败、对端成功但本地落库失败、对端接收但应答超时、进程恢复。取消后的 started/未知结果应依照通道语义对账，不能盲目重发。MAX-54 实现准备好后，针对该实现重新联调这四类场景，再关闭 MAX-53 的第4项验收。

## 资源记录

子代理数 0，最大深度 0，并发代理峰值 1（主线程）。raw input、cached input、output、费用实测遥测不可用；未提供估算或虚构实际消耗，未创建 Goal 账本。未设置硬预算。
