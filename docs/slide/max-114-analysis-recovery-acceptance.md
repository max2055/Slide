# MAX-114 / W06b 验收与交接

基线：`main@db4b7d0515a31a5c733fed5ade81a286510fc823`。分支：`codex/max-114-analysis-recovery`。最终精确 head SHA 记录于 PR 和 issue 交付评论，避免文档自身提交哈希循环。2026-10-03，隔离 worktree；未改用户原工作树。

## 已验证行为

- 同事务创建 `ai_analysis`、不可变请求、已投递 outbox 和 runnable workflow job；注入 outbox 写失败则全部回滚。并发受理复用同一 ID。
- 真实子进程 SIGKILL：提交后、claim 后、发送前退出可恢复；假 HTTP 供应商接收后、响应后、完成落库前退出归 unknown，不自动再次调用；完成落库后退出保留结果，不重复调用。
- 双 owner 和旧 attempt/fencing/run 身份不能迟到回写；完成事务内租约过期会回滚结果和请求状态。
- 当前会话、权限、资源范围撤销阻止恢复发送；配置变更和后续调用也重新校验。供应商异常后禁止执行器内部再次调用。
- active 缓存只有匹配 live lease 才成立；失效 unsent admission 返回 pending，保留可重领 intent。完成缓存必须同时匹配证据、配置、权限 SHA-256 与 TTL。重新采集时间进入证据 hash，通常不会命中旧结果。
- unknown 普通重试返回旧 ID；严格 boolean 确认后创建 `retry_of` 链接的新 ID，保留旧记录。明确确认可将自动 unknown 转为当前操作员的手动请求；拒绝另一账号手动请求和不同 subject。旧 TopSQL cache key 不绕过 unknown。
- 普通无 execution identity 的完成、失败和 status writer 不可修改 durable 分析。
- legacy pending/running 保留原状态、已有结果和原因，全部按无法证明已发送与否归 unknown；不虚构 provenance。只读 inventory 区分可证 unsent、有结果、未知三组。
- 前端展示 unknown 和再次计费后果，停止轮询；共享 app-dialog 确认后重试。实例诊断链接到同一查询/确认入口。
- `ANALYSIS_DISPATCH_ENABLED=false` 拒绝新受理、阻止新 claim 和后续供应商请求；恢复扫描、历史查询保留。

## 验证证据

环境：Node/pnpm 现有工具链，Vitest；Docker MySQL 8.4、独立临时数据库、假凭证、假 HTTP 供应商，无真实供应商或生产数据。

| 命令/层级 | 结果 |
| --- | --- |
| `pnpm --filter slide-api test` | 312 文件通过、25 文件跳过；2925 项通过、199 项条件跳过 |
| 最终分析/接入 focused Vitest（见下方） | 12 文件通过；168 项通过、2 项条件跳过 |
| `bash scripts/qualification/run-analysis-recovery.sh` | 独立容器 2 文件、36 项通过；脚本退出时已清理容器 |
| `pnpm --filter slide-frontend test` | 82 文件、565 项通过；后续未改 UI |
| 两端 `typecheck` | 通过；最终后端再次通过 |
| `pnpm contracts:check` | 生成契约一致 |
| `pnpm qualification:matrix` | 37/37 |
| `pnpm security:scan` | 无 secret scan 错误 |
| `pnpm lint` | 0 errors、259 warnings；已有警告保留 |
| `pnpm --filter slide-frontend build` | 通过，生产 CSP 检查通过；已有 chunk 大小警告 |
| `git diff --check` | 通过 |

最终 focused 命令（假凭证仅测试进程使用）：

```bash
ANALYSIS_TEST_MYSQL_PORT=<isolated-port> \
ANALYSIS_TEST_MYSQL_PASSWORD=<fake-test-password> \
pnpm --filter slide-api exec vitest run \
  src/analysis/analysis-recovery.mysql.test.ts \
  src/analysis/analysis-provider.test.ts \
  src/analysis/analysis-recovery-schedule.test.ts \
  src/ai-agent-bridge.test.ts src/fault-diagnosis-service.test.ts \
  src/fault-diagnosis-contract.test.ts \
  src/resources/resource-agent-diagnosis-service.test.ts \
  src/resources/resource-routes.test.ts src/alert-rca-service.test.ts \
  src/adapter/__tests__/direct-adapter.test.ts \
  src/workflows/worker-runtime.test.ts src/lifecycle/metric-quality-startup.test.ts
```

首次完整后端 gate 的启动 VM 缺新服务替身为本次接线影响，已修复；WebSocket 5000ms 超时在并行负载下出现，隔离复核和最终完整 gate 均通过。新增迁移发现启动注释 invariant 缺失，已补齐；真实全量 MigrationRunner 首次执行和再次执行均成功。新测试最初误用 ledger 状态 `applied`，改为真实 `completed` 后通过。最后 store/SQL 变动只重跑受影响模块、迁移和类型/契约/扫描，复用未变模块的完整 gate。

## W08 共享契约

`AnalysisRequest` 冻结 purpose、subject、actor、message、systemPrompt、evidenceVersion、configVersion、authorizationVersion 和 sessionKey；不持久化供应商凭证。

执行身份为 `(analysisId, jobId, attemptNumber, ownerId, fencingToken, currentRunId)`，`currentRunId` 透传到 DirectAdapter runtime。所有供应商请求前和 completion 回调使用可信调用方提供的回调，模型不能指定 owner/fencing。请求状态 `unsent → sending → responded/completed`；可能已发送而失联则 `unknown`。安全 unsent 保留 workflow retry；unknown 仅显式确认新建后继。

`analysis_dispatch_attempts` 保存历史尝试；`analysis_dispatch_keys` 持久 admission scope；缓存 hash 不代替运行身份。`analysis.recover` 通过每 10 秒 durable job 自续排程，启动时也执行扫描；每次扫描最多处理 100 条。旧 run 无权覆盖新 run。

API：资源诊断 POST 接受 `{retryOf, confirmUnknownRetry:true}`；unknown 未确认返回 409；通用 `/api/ai/analysis/:id/reanalyze` 对 unknown 要求 `confirmUnknownRetry:true`。后继如需兼容其他状态必须同时更新 server、公共 API 契约和前端读取。

## 迁移、止损与回滚

1. 在正常发布迁移流程执行 `109_analysis_dispatch_recovery.sql`；全量 baseline + 至 109 已在独立 MySQL 验证，重复 MigrationRunner 不重执行完成记录。
2. 关闭 `ANALYSIS_DISPATCH_ENABLED` 即停止新分析和后续付费请求；保留数据库、workflow jobs、attempts 和查询入口。已在调用边界之前发出的请求无法撤回，按 unknown 治理。
3. 不删除 109 schema、不清除 unknown、不抹掉旧结果；禁止直接退回不理解 unknown 的版本。回滚目标必须保留 unknown-aware 查询与持久身份保护。
4. 历史修复只提供 `analysisRecoveryInventory(pool)` dry-run 列表；无派发身份的旧记录不存在“未发送”证明，不自动重发。需要重试时由授权用户确认再次计费。

## 未验证与资源

未调用真实付费供应商，未验证供应商查询/幂等能力；因此不启用未知窗口自动重发。未做生产迁移、历史修复或重启用户服务。前端验证为组件测试、typecheck 和构建，未执行人工浏览器/真实付费端到端。CI 八项由父任务在当前 PR head 串行核验后合并。

范围 v1 与 v2 原因保留在实施计划；硬预算未设定。实际 raw/cached input、output 和费用遥测不可用，不用内部预算代替实际消耗；子代理总数 0、深度 0、代理并发峰值 1。
