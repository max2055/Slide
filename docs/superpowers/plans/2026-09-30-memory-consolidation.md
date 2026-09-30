# MAX-100 无损 consolidation 实施计划

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 旧 MemoryStore API 有限消费历史时，不丢未消费、并发新增或写失败的数据，重启重试不重复归档。

**Architecture:** 历史 entry 使用持久化 envelope ID，旧文件首次变更时迁移。消费先冻结 ID 快照并持久化 pending journal，再写不可变 archive、带 batch marker 的 MEMORY 和 cursor，最后按快照 IDs 清理 history。所有临时文件 fsync 后 rename，并同步目录；同进程多个 Store 按 workspace 串行写，跨进程并发写不支持。

**Tech Stack:** TypeScript、Node fs、Vitest；不新增依赖、模型请求或后台工作。

## 执行契约

父任务基线和本次目标均为 `6c22d2a51d7bf17ec3cd36526032671b104849dd`，相关差异为空。仅实施 MAX-100；其他子项各自独立交付，禁止提前实施依赖项。硬预算未设定；遥测不可用；子代理 0。

## 步骤

1. 在 `packages/agent-core/src/__tests__/memory-consolidation.test.ts` 建立 51/1000 条分批、归档失败、cursor 失败、重启、并发 append、并发 Store、旧文件、损坏文件和 compact 的 invariant 回归。先运行并确认旧实现失败。
2. 新增 `packages/agent-core/src/memory-history.ts`：共享进程锁、稳定 IDs、strict JSONL 读取、durable atomic write、pending journal、immutable archive、按 ID acknowledge；归档期间 append 不受消费锁阻塞。
3. 修改 `packages/agent-core/src/memory.ts`：委托历史操作；consolidateToMemory 每次默认处理最老 50 条，参数为批次上限；compactHistory 先归档再裁剪，clearHistory 保留显式删除语义；MEMORY 发布按 batch marker 幂等且与 updateMemory/writeMemory 串行。
4. focused 命令：`pnpm --filter @slide/agent-core exec vitest run src/__tests__/memory.test.ts src/__tests__/memory-consolidation.test.ts`。修复后运行 agent-core 完整 test/typecheck；相关失败阻塞此 PR，无关失败明确分类。
5. 记录数据保留不变量、跨进程边界及原 API 兼容变化，独立提交 MAX-100 PR。合并和后续真实整链验收不计为本次已完成。

## 验收与停止条件

每个源 ID 在 archive 或 pending history 中至少出现一次；同 batch 的 archive/MEMORY 不重复。journal/cursor/history 任一步失败，都可用新实例恢复；快照之后的 append 不被确认。archive 写失败不推进 cursor；损坏源文件报错并保持字节不变。检查不引入付费请求、后台工作和生产部署。迁移破坏原内容或上述 invariant 失败时，停止交付并修复。
