# MAX-98 Canonical History 实施与验证

> 执行：在已授权范围内实施，保持 Runtime、审批、预算和 completion pending/事务不变。

目标：事实历史不受模型上下文预算影响；稳定 ID 支持迁移、分页和恢复。
基线：main `a03e672`，包含 Runtime 2.1 与已合并 MAX-100 (#102)。工作区原基线 `f5a13a4` 较旧，因此在独立 worktree 实施，保留原有修改。
硬预算：未设定。实际 input/cached input/output/费用遥测不可用；无子代理。

1. `session.ts`：增加稳定 ID/run/turn、只读克隆分页和 hash。旧 JSONL 的确定性 ID 映射原子写回，坏行和旧裁剪可能缺口记录在 metadata。save 不裁剪；自动压缩只调整投影。事实硬容量超过时拒绝保存；显式 retention 只能删除完整已结算用户回合并记录边界。
2. `runtime/checkpoint.ts`：为 checkpoint 事实建立稳定 ID；按 ID 去重；只恢复真实 assistant/tool 数据，中断占位仅由投影 normalize 生成。保留运行预算和未结算 intent。
3. 业务 MySQL：现有 `chat_messages.message_id` 是 user/final 权威 ID；新增独立工具事实表，与业务消息合并为 actor/session scoped canonical 分页。旧 DB ID 不改写；旧消息确定性关联 user turn。completion pending 与最终答案事务保持原样。JSONL 只是业务缓存，读 MySQL 可重建，不承诺双写原子性。
4. `direct-adapter.ts`：WS/旧 chat handler 传入持久化 user ID；模型只消费 clone 投影；checkpoint 工具事实与 checkpoint 在 MySQL 同一事务保存，再保存文件缓存。业务 final 不在 MySQL durable commit 前充当 canonical fact。invoke 保留独立文件入口，subagent/cron 保留原 Runtime 入口。
5. 回归：501+ 并行工具样本、重复冷加载、坏行修复、ID roundtrip、投影/summary hash、明确 retention 边界、保存失败。运行 session/checkpoint focused checks，随后 agent-core test/typecheck 与 API 受影响测试/typecheck。真实隔离 MySQL 验证读取、失败、COMMIT ack 丢失、缓存重建、权限隔离；环境缺失明确标未验证。

排除：TurnLoop 重写、Message Parts 全量迁移、C2 摘要权限装配、无关架构整改。迁移破坏事实或权限/一致性不变量失败时停止交付并修复；CI 异步以条件唤醒续接，不本地轮询。

## 查询、容量与兼容边界

- 文件权威源：`Session.messages` 保持 legacy API；新消费方使用 `getCanonicalPage(limit, after)` 的独立快照，`canonicalHash()` 校验事实。模型使用 `getHistory()`，按完整用户回合选择；最后一个回合超过 count/token 目标时保留完整回合，由 ContextManager 继续处理或明确报 context overflow。
- 文件默认上限 100,000 条/64 MiB（SessionManager 可配置）。超限拒绝写入，不裁剪旧事实。主动保留使用 `retainCanonicalRecentTurns(turns, reason)`，保存后边界包含源 ID、数量和 hash；工具未结算则拒绝。`clear()` 是显式删除事实，记录边界；`deleteSession()` 是调用方请求的完整会话删除。
- 业务权威源：`CanonicalStore.getPage(actor, sessionId, limit, before)`，cursor 是 `turn_sequence:ordinal:tie`，一页最多 1,000 条，返回时间正序。调用和结果存 `agent_canonical_facts`，原 user/final 存 `chat_messages`。工具最多 100,000 条/单事实 4 MiB；业务 append 在 99,999 条前保留最终回答余量。超限需要显式保留或删除，不能通过 projection 扩大容量。
- DB 原消息 ID 完全不改写，旧 run/turn 关联从 session + 用户数据库序号确定性计算。旧文件 ID 按原记录位置及内容计算并原子写回；相同文本的不同记录有不同 ID。旧 checkpoint 仅在 request key 完全匹配时迁移到业务 checkpoint，未匹配且存在 pending intent 时明确要求核对。历史业务文件中的未提交回答不会提升成 DB 权威事实。
- JSONL 坏行数量、排除的旧摘要和旧版本可能裁剪的缺口存 `metadata.history_gaps`；不补造缺失事实。旧 `_last_summary` 保持 metadata，停止冷加载反复追加 system；具体摘要装配留给 MAX-99。
- 本阶段回退只能调整新 run 的 projection/policy。保留新事实表和 checkpoint；不要让会裁剪 JSONL 的旧二进制回写新文件，不盲重放 unknown 工具 intent。

## 验证结果（2026-09-30）

- `pnpm --filter @slide/agent-core exec vitest run src/__tests__/session.test.ts src/__tests__/runner-checkpoint.test.ts`：41 项通过；包含 505 条事实、并行工具、冷加载、repair、稳定 ID、独立 snapshot、summary/microcompact hash、保留与容量失败。
- `pnpm --filter @slide/agent-core test`：483 项通过；`typecheck` 通过。
- `pnpm --filter slide-api test`：2737 项通过，129 项按现有配置跳过；`typecheck` 通过。最新受影响生命周期、旧 chat handler 与最终提交聚焦回归通过。
- `pnpm lint`：0 errors，261 warnings；`contracts:check`、`qualification:matrix`、`security:scan` 通过。
- `pnpm --filter slide-api exec tsx ../../tests/qualification/canonical-history-mysql.ts`：真实隔离 MySQL 8.4 + JSONL，505 条及旧 ID 分页、actor/session 隔离、read share 只读、final 与 tool/checkpoint 的 COMMIT acknowledgement 丢失、pending/重建、文件写失败、显式保留全部通过。使用环境变量 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD；自动创建/清理随机隔离数据库，需要建库权限，不使用业务数据库。
- `pnpm --filter slide-api exec tsx ../../tests/qualification/agent-runtime-mysql.ts`：真实 WS 的 recovery/length/reject/deadline/cancel、幂等重连、进程退出前事务回滚、重启并发恢复全部通过；唯一最终回答不变量保持。

验证使用可控 provider，没有付费模型调用；没有生产发布或生产数据变更。部署与父任务后续 C2/记忆/流式整链验收不在本阶段声明通过。
