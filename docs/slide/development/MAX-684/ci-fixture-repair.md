# MAX-684 CI 测试合同修复

PR #1010 保持 draft。base `451ab8c9969f18d94f17392a74301294de82b5e1`，旧 head `e5c5489a5147e0753e069f22f65c8328dc8af18e`；新 head 见本文件所在提交。不改生产代码、权限政策、调查归属、恢复准入或门禁。

## 四组差异与验证

- canonical-store：隔离 schema 的用户 7/8 仅授 chat:view，经实际 JWT 验签生成 actor；原事实、冲突、事务断言不变。新增撤权拒绝读写并检查消息/事实零变化。真实 MySQL 36 PASS。
- agent-run-recovery：隔离 schema 最小授权，直接 claim 正例传入真实验签 actor，绑定 version/exp；保留 WS、取消、断连恢复断言。新增缺绑定取消、恢复不重放且不写消息。真实 MySQL 26 PASS。
- execution-recovery：普通聊天 investigation 前缀正例传入已有真实认证 owner；不更改调查绑定。独占 MySQL 定向用例 1 PASS，139 未选中。
- session-bridge：按全局无聊天权 CHAT_FORBIDDEN 与仅会话不可见 CHAT_SESSION_NOT_FOUND 分断言，检查无 messages，保留 HTTP404、调查授权和四表零新增断言。真实 MySQL 41 PASS。

四组均为本次聊天合同变更引出的旧夹具不兼容。不能据此宣布完整 CI 通过。

## 新验证及失败分类

证据目录：`outputs/max684-ci-repair-diagnostics/`（共享产物目录、不入库）。Node 24.22.1，pnpm 11.19.0。Vitest 入口为 `pnpm --filter slide-api exec vitest run <文件>`；真实测试显式设置 AGENT_RUN_TEST_MYSQL_PORT/PASSWORD，session-bridge 另设置 AUTH_TEST_MYSQL_PORT/PASSWORD。独占容器 max684-ci-repair-mysql，动态映射端口，空测试密码，无模型外部调用。

首次组合运行在新增负例中误用需授权的 snapshot，已改成直接 SQL 快照并重新通过。首次 execution 全文件运行的首个有效错误是未触及 bounded-queue 场景期望 completed 实际 running，后续出现共享3308连接拒绝，137条失败不等于137个根因。未将其归为本次产品回归，也未改动该场景。定向前缀用例在独占 MySQL 通过；全文件 qualification 未通过。

真实运行 `pnpm --filter slide-api exec tsx ../../tests/qualification/startup-readiness.test.ts` 退出1：leader liveness 超时。日志到数据库连接、迁移账本、SQL历史就绪及 strictTypes 提示；没有进入 lease 断言。保留锁、总超时及 fatal handler，未猜测修启动。旧68项与原 Reviewer PASS 仅适用于旧 head 的原范围。

## 三组未知与最小下一步

1. fatal：读取旧 run 44099338948 Edge artifact 14336166310；只有浏览器 trace/error-context，无 API rejection 栈。qualification artifact 14335426944 也只有浏览器产物。根因/引入分类仍未知。建议 Chief 决定后，在受控测试启动入口增加诊断：仅记录异常类型和白名单源码栈帧；不输出 message、cause、任意对象、JWT、请求或SQL参数；保留原 fatal 退出。增加含密钥/URL/query/cause的脱敏测试和真实拒绝子进程测试，再以相同 browser/Edge 命令复现；若修改产品 fatal 链须原 Reviewer 复核及浏览器/恢复验收。
2. leader liveness：本轮真实复现，首个失败仍在 /api/health 等待，report缺失是后续观测问题。建议只改测试观测，在失败 finally 保留子进程退出码、PID、监听探测时间线，并由独立 SQL 连接采样 performance_schema 等待对象与 worker_leases 状态（仅schema/表/锁类型，不含SQL文本、用户、参数）。监听前注册阶段加固定阶段名/耗时的测试诊断；不调总超时、不解锁绕过。复现入口同上，受影响 startup/恢复环境检查。现有日志不足以唯一定位监听前阻塞点。
3. standby503/startup probes：读取 shard8 artifact 14336341217 的 api.log/startup.jsonl/recovery-observation；确认401→503及启动记录，但没有对应请求的响应body、API子进程状态/lease快照。生产 onRequest 在认证前以 recovery/readiness 拒绝503，测试等待启动文字不能单独证明每次请求状态。建议在原测试失败路径保存响应稳定码、时间、固定 recovery状态、脱敏lease状态、子进程退出码；定向命令 `pnpm --filter slide-api exec vitest run src/operations/server-composition.mysql.test.ts`。确认具体分支前不改401断言或产品恢复逻辑。分类仍未知。

诊断方案尚未实施，不把建议当已有观测能力。新候选只含四组测试与本文档；完整 CI、独立复核、合并均未完成，不合并、不部署、不关闭#1009。
