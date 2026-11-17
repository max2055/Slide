# R4 之后的 CI 登录限流修复

输入 head：`01086ce8f0ecd4eadbba5438cf4f100d25117a8f`；PR #920 base/merge-base：`451ab8c9969f18d94f17392a74301294de82b5e1`。R4 已由原 Reviewer 在该输入版本独立 PASS/关闭，其他已关闭项不重开。本页记录后续 CI 配置修复，完整交付 head 见同次 Issue 和受控证据报告。

## 首个有效错误与产物边界

单次核对 run `44072316104` 的最终结果为 **completed/failure，attempt 1**，head 为上述输入，实际合成提交 `640e8f203f750fc468b32af3df29dfb5c35efaa9`。30 jobs 中 27 success、3 failure。

首个有效错误是 browser-qualification / `Login, authorization and persistent Agent cancellation`：新增的并发审批与取消/retry 场景在 `/api/auth/login` 返回 429，未进入其审批业务断言。原实现把七个用例合为一次 managed API 启动，连续管理员登录超过 `loginRateLimitConfig` 的每账号每分钟 5 次预算。这是本次 CI 选择范围扩展引入的测试生命周期问题，产品限流按预期工作。

release-artifact 的 `Require all selected checks before packaging` 及 ci-gate 的 `Validate selected checks and release result` 均因 browser-qualification 失败而失败，是同根因传播。没有证据说明打包过程本身发生构建故障。该 run 的一次最终列表包含 16 个调查/资格验收 artifact，没有适用 Slide 发布包；本轮不下载这些调查包，不填造 RELEASE SHA、tar 大小、校验和或包源码/扫描结论，旧包结论也不迁移。

## 最小修复

CI 保留原四个登录/授权/取消场景，另以独立 Playwright 调用执行三个 R4 SQL/审批场景。每次 managed 调用启动新的 API 进程及进程内登录限流存储，并在该 job 的独占 MySQL service 重建资格验收 schema。两次顺序执行，不并发争用 schema。三个 R4 场景继续完整执行，未提高限流阈值、关闭限流、添加等待、自动重试、跳过测试或降低业务断言。

本轮只改 CI 调用边界及交接记录，不修改产品逻辑、SQL/浏览器用例、Provider 或凭据 helper。五条消费者记录中的 CI 文件哈希随本次配置更新，原独立复核 head 的哈希另存 `sha256AtReviewedHead01086ce8`；其余源码、目标绑定和历史记录保留。

## 本机真实验证

使用本任务独占 MySQL 9.6、随机 DB 密码、与其不同的平台资格验收输入、独占 Fastify/Vite/本地合成 Provider 和 Chromium，实际执行三组：

| 选择范围 | 结果 |
|---|---|
| 修复前七个用例的一次调用 | 退出 1，5 passed / 2 failed；同样在两次管理员登录处得到 429 |
| 修复后原四个用例的一次独立调用 | 退出 0，4/4 PASS，包括真实 Agent 取消/持久化终态 |
| 修复后三个 R4 用例的另一次独立调用 | 退出 0，3/3 PASS，包括真实 SQL/reload/并发审批与浏览器取消/retry |

有效完整命令为：

```bash
pnpm --filter slide-frontend exec playwright test \
  release-critical-paths.spec.ts release-security.spec.ts agent-cancellation.spec.ts \
  --grep 'qualification login|qualification security boundary|viewer cannot|Stop cancels' --workers=1
pnpm --filter slide-frontend exec playwright test release-security.spec.ts \
  --grep 'direct SQL execution|concurrent approval reviews|approval cancellation and retry' --workers=1
```

实际执行另显式指定受控输出目录及 reporter；完整配置来源、镜像身份、进程/容器记录及命令留在受控脚本。原取消用例使用已有 CI 的资格验收管理员输入，数据库密码为本次随机值；没有把该输入描述为随机管理员值。每次调用均启动并清理独占服务，最终容器及匿名卷清理退出 0，无任务服务残留。没有写入共享库、调用真实模型或改变共享账本。两个指标场景仍不计为实际业务通过。

`node --test scripts/ci/*.test.mjs`：65/65 PASS。与本轮配置变更有关的源码策略和秘密增量检查为 0；其余源码、类型检查及原独立复核证据未失效时复用，不机械重跑全仓检查。原始失败日志、三组实跑结果与 SHA256SUMS 保留在项目受控 `outputs/max-681-r4-ci-followup/`，不上传 trace、认证请求、实际端点或凭据。

## A1–F1 与后续完成事件

| 项 | 当前状态及责任边界 |
|---|---|
| A1 | R4 五条消费者更正已独立接收；本轮只刷新 CI 哈希并保留原值。活动消费者和旧账号仍待 Chief 协调 |
| B1 | 持久注入、两次独立 claim 未执行 |
| B2 | 凭据输入保护与显式空值证据保留；本轮修正 CI 服务生命周期，不代表所有旧入口完成迁移 |
| C1 | 真实共享 JWT 轮换及旧认证失效未执行 |
| C2 | 独占 SQL/reload/审批实跑通过；共享两库轮换、旧池/事务和采集未执行 |
| C3 | 共享业务、密文/备份及唯一账本保全未验收；本轮无真实模型请求 |
| D1 | R1/R2、技能/lock、R3、R4 保持独立关闭；本次 CI 增量交 Chief 安排补核 |
| D2 | 当前源码扫描结论不等同包验收；旧 PF 身份及二进制深层边界保留 |
| E1 | 历史下载继续暂停，shallow/远端闭包、历史产物和外部副本未闭环 |
| F1 | 已接收旧 run 的真实终态与首错；新候选的必需 CI、适用发布包、RELEASE/大小/校验和/源码一致性/扫描仍须沿完成事件单独核验 |

保持原 Draft PR 与 Issue `in_progress`，不自审放行、合并或发布。不增加 watch 或状态/产物轮询；新候选的完成接续及具体规则 ID 以同次交付评论为准。
