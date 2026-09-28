## MAX-87：结构迁移验收

基线与最新 `origin/main` 均为 `07b3e6ce458b0b4576d356a97d78ab17df3ddd66`，无基线差异。
实施分支：`agent/15astra/f362d50f1ab6`。使用 `multica repo checkout` 获取隔离 checkout 后 fetch main。

范围仅为 T1：保留 AgentRunner façade；将循环、模型请求、工具执行、旧 checkpoint 和 context helpers 分离。
不修复四个已知完成判定缺陷、不调整默认阈值/时限，不启用后续阶段 policy。无硬预算，未委派子代理。

### 迁移边界

- `AgentRuntime` 组合 provider getter 与工具 executor；`TurnLoop` 每次 run 创建独立 `TurnState`。
- `ModelStep` 保持 streaming 与 batch 超时差异、finalization retry 和实际 provider settlement 回调。
- `ToolExecutor` 接受明确依赖；移除空 provider 的临时 Runner，保留 public runTool 参数、并发结果顺序及 guard。
- `LegacyCheckpoint` 保留旧 metadata API、dedup/backfill 和 callback payload，不改业务完成事务。
- `legacy-context.ts` 仅搬迁现有 context helpers，尚未实现 T4 ContextManager。
- 版本化结构快照仅白名单保存 phase/modelSteps/providerAttempts/toolCalls；不保存原始消息、工具参数、signal、Promise 或 provider。
  恢复校验版本、阶段、计数合法性及单调性。这是独立的 T1 状态 API，尚未接入业务 checkpoint 的预算恢复（后续阶段负责）。
- legacy 连续 empty/length 计数仍按原行为在工具后重置；新增累计结构计数不重置。
- `response_ready` 在 T1 仅映射旧 completed 行为，不表示已通过 T2 guard，更不等同于持久化 completed。

### 验证证据

迁移前：agent-core 10 文件、87 项测试通过，其中四个 runner 文件 33 项。
迁移前生成并冻结 7 组完整 trace snapshot，覆盖四个已知缺陷、正常/异常回复、stream thinking 与 mid-turn injection。
trace 包含 hook、provider 请求/settlement、messages、usage 与 checkpoint；迁移后不更新快照，全部匹配。

迁移后命令：

```bash
pnpm --filter @slide/agent-core exec vitest run src/__tests__/runtime-compatibility.test.ts src/__tests__/runtime-state.test.ts src/__tests__/runner-lifecycle.test.ts src/__tests__/runner-checkpoint.test.ts src/__tests__/runner-timeout.test.ts src/__tests__/runner-resource-lifecycle.test.ts
pnpm --filter @slide/agent-core typecheck
pnpm --filter @slide/agent-core test
```

结果：focused checks 6 文件/56 项通过；typecheck 通过；模块测试 12 文件/110 项通过。
额外边界包括非法状态转移、无凭据快照 roundtrip、计数回滚拒绝、跨 run 隔离、并发结果顺序/独占 batch、补救请求超时后的实际 settlement。
定向 lint 无 error（两个搬迁前已有的 unused 警告保留）。GitHub CI 和合并证据以 PR 当前 head 的检查记录与任务交付评论为准。

实际 input/cached input/output/费用遥测不可用；子代理数 0、深度 0、主线程并发峰值 1。
停止条件：必需检查失败、人工审批或外部环境阻塞时不合并、不放行 T2；按持久化 wakeup 恢复。
