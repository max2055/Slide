# MAX-54 投递幂等与不确定结果恢复验收

基线 `origin/main@3481e9f`；批准设计后实施。业务实现 `7f6457f`，历史投递显式恢复补丁 `c6c1430`。未部署、未合并；原任务工作树的修改保留。MAX-53 的执行上下文已在主线，本次完成生产 handler + 两 Worker + 真实 MySQL/本地 SMTP 联调，因此该技术依赖已满足。

## 投递语义

- 业务键为 `notification:<alertId>:<channelId>` 或 `report:<reportId>:<channelId>`。数据库事务锁定当前工作流和业务状态，校验 owner/fencing token/有效 lease 后才授予发送权。网络请求不持有数据库事务。
- `notification_delivery_states` 是业务发送闸门，不是第二套队列。复用 workflow_jobs、notification_delivery_attempts、report_notification_deliveries、notification_delivery_replays。
- 每次实际发送有 attempt UUID；attempt 审计采用 job ID + 单调 fencing token，dead-letter replay 的 attempts 归零不会覆盖旧记录。
- 目标配置、消息和幂等声明第一次准备成功后冻结，完整请求使用项目 AES-GCM 加密存储，查询仅返回摘要。后续配置变化不改写历史请求；当前渠道禁用/删除仍禁止发送。
- 发送前配置/准备失败为 retryable，有失败 attempt 可查。SMTP/普通 webhook 只调用一次传输；成功后写入失败、超时、发送中取消、崩溃遗留 sending 均保守视为 unknown。普通队列重试不会再次发送，最终保留 dead-letter 供处理。
- 显式声明 `idempotency_contract: "receiver-deduplicates"` 且设置 `idempotency_retention_seconds`（1–604800）的通用 webhook，在冻结的保留期内发送相同 Idempotency-Key 和请求。发送前再次检查截止时间，使用截止取消信号。声明必须对应接收端真实契约，接收端应按发送方/部署隔离键空间；配置声明本身不赋予 exactly-once。
- SMTP Message-ID 是稳定业务键的摘要，仅用于对账，不保证收件端去重。取消无法撤回已在途/已接收请求。管理员显式接受重复风险的重试可能产生重复效果。

## 查询与恢复

`GET /api/notification/jobs/:id/delivery` 需要 `notification:view`，返回 delivery、最近 100 个 attempts 和最近 100 个 decisions。遗留 sending 若原 lease 已失效，对外显示 unknown；原始 attempt 仍可显示 started，直到接管/恢复将其归档为 unknown。

`POST /api/notification/jobs/:id/recover` 需要 `admin:*`：

```json
{
  "version": 3,
  "decision": "retry",
  "reason": "已核对接收端日志",
  "reconciliation": "接收端无法确认该请求是否已处理",
  "acceptDuplicateRisk": true
}
```

- decision 为 sent（确认送达）、abandon（放弃）或 retry。
- reason、reconciliation 必填。retry 必须明确 `acceptDuplicateRisk: true`。
- 使用查询返回的 version；存在活跃 lease 或版本冲突返回 409。重复同一恢复请求不会重复执行。
- 决策审计、状态 CAS、工作流完成/取消/重新入队在同一事务内。
- 若查询来自同业务键的另一重复 job，使用 delivery.workflow_job_id 对应的拥有者 job 发起恢复。
- 普通 `/replay` 不能绕过 sending/unknown；先在上述恢复接口对账。报告投递同样可查 dead-letter 和恢复。

## 验证证据

初始 RED：生产报告 handler 的“外部成功、审计失败”复现测试原本观察到 2 次发送，期望 1 次（提交 `5570eea`）。补丁后通过。

最终候选 `7f6457f` 的完整后端 gate：

```bash
cd apps/db-ops-api
DELIVERY_TEST_MYSQL_PORT=55001 node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
cd ../..
pnpm contracts:check
pnpm lint
```

结果：258 个测试文件通过、1 个跳过；2176 条测试通过、13 条跳过。类型检查、契约检查和 lint 均退出 0。本次数据库集成套件没有跳过；其余跳过项不计为通过。

后续审阅发现“升级前历史 attempt 的显式 retry 又被历史保护拦住”，新增测试验证 RED（`29abc23`），在 `c6c1430` 修复。最终受影响集成套件 **18/18 通过**，最终类型检查通过；完整 gate 未因文档或汇报重复执行。

18 项真实 MySQL 集成检查：

1. 两个独立连接竞争发送权，只授予一个；取消后不能获取发送权。
2–3. 通知/报告均通过本地 SMTP 真正接收，再用 MySQL trigger 注入审计写失败：unknown，重建 store/重复 occurrence 均不重发。
4–5. 两个真实 WorkerRuntime 经生产 handler 发送通知/报告：A 在途时 lease 失效，B 接管不再发送，A 不能写成功；实际 SMTP 接收均为 1。
6. SMTP 已接收但不返回确认，触发实际 socket timeout：unknown，不自动重发。
7. 持久 sending 后模拟进程中断：过期 lease 显示 unknown；对账后旧完成写被拒绝。
8. 发送前无效配置：接收为 0，retryable/失败原因可查询，修复配置并重新 claim 后接收为 1。
9. Fastify 路由注入 + 项目真实 requirePermission：匿名 401、普通用户 403、非法理由/风险确认 400；并发相同 version 的恢复得到 200/409；attempt token 不重置，冻结内容不变。
10. 升级前的失败/不确定 attempt 不被当成新投递。
11–12. 本地 HTTP 接收后断开响应：契约 webhook 两次相同键/内容请求只产生一个接收端效果；普通 webhook 仅一次请求、无自动重发。
13. 契约保留期过期后拒绝自动发送。
14. 取得发送闸门后立刻取消：真实 SMTP 接收为 0。
15–16. 确认送达/放弃拒绝活跃 lease，lease 结束后原子更新 delivery 和 workflow；重复决定冲突。
17. 准备失败不能抹去升级前不确定记录。
18. 升级前未知记录没有新 attempt UUID 时，管理员已批准且审计的 retry 仍可正确执行。

另保留 MAX-53 取消回归：本地 SMTP + 两 Worker 在准备阶段取消，只有新 Worker 发送一次；在途取消不伪造成功结果。

测试隔离边界：MySQL 8.4 为独立本地容器、独立临时数据库，测试完成删除数据库；SMTP 均为 loopback `.test` 接收端。HTTP 为真实本地服务器，测试替换 DNS/HTTPS request 路由到 loopback HTTP（没有替换消息、headers、请求体或响应处理）；并未将其冒充外部 HTTPS/TLS 的端到端验证。崩溃通过提交 sending 后丢弃执行、使 lease 过期及重建 store/连接模拟，没有声称真实 kill/重启整个 API 进程。没有向真实联系人发送测试通知。

可复现：启动专用 MySQL 8.4，开放仅 loopback 的临时端口、允许空 root 密码；设置 DELIVERY_TEST_MYSQL_PORT 后运行 `vitest run src/workflows/delivery-recovery.integration.test.ts`。测试不读取应用 .env，数据库名包含测试进程 PID。

## 升级和限制

先停止旧版本投递 worker，再执行迁移 093，随后启动新 worker。禁止新旧投递代码混跑：旧代码不认识发送闸门。迁移可重复执行；新增/修改 schema 字段保留注释要求。

历史已送达记录直接保护为 sent；历史 failed/started 保守保护为 unknown。历史版本没有保存完整请求快照，无法重建当时的接收目标；恢复前必须核对旧接收端与当前冻结请求的业务含义。操作员恢复不是自动补偿，不宣称 exactly-once。

范围未扩张到旧的非持久轮询/升级通知路径、UI 或通用队列架构。硬预算未设定；实际 raw/cached input、output、费用遥测不可用。子代理 0、最大深度 0、并发代理峰值 1；未创建或重置 Goal 账本。
