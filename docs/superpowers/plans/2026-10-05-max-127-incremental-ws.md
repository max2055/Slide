# MAX-127 增量 WS 与恢复实施计划

> **Execution:** Follow this plan within existing authorization and repository rules; track dependencies and acceptance evidence. No child agents.

**Goal:** 新端真正追加正文，断线仅恢复展示，旧端保留累计替换。

**Architecture:** 按已授权比较报告方案 B，纯共享 stream 契约负责 epoch/订阅/区间校验；Adapter 的同步 authority 负责有界投影、续传窗与 snapshot(W)+suffix；Gateway 与 S2 reducer 原子替换全投影。attempt、durable 与展示游标独立。

**Tech Stack:** TypeScript、Fastify/DirectAdapter/ws、Lit、Vitest、Playwright。

## 执行契约

base=`a70de824199e9d2e013e47e5d7dc815f741230e4`，前置 PR #130 已 MERGED 且八项 CI SUCCESS。范围严格 S3；不改 provider/执行/事务，不逐 token 写库，不新建 Gateway，不重做页面。硬预算未设定；子代理 0。起始平台 usage 所有 raw 为 0（当前 active 尚未报告，不能解释为零耗用），标准化 token/费用不可用。

## 1. 共享协议与正文规范化

- `packages/agent-core/src/display-stream.ts`：定义 snapshot/delta、epoch、run/turn、订阅 ID、fromSeq/toSeq 与独立水位；重复忽略，缺口冻结，旧订阅/epoch丢弃；snapshot 通过 restoreMessageProjection 一次替换。
- `apps/db-ops-api/src/adapter/message-projection.ts`：相同 text part 从累计 partText 计算真正 append，reset 仍使用 anchor；旧 event.delta 不变。
- 测试 `packages/agent-core/src/__tests__/display-stream.test.ts` 与既有 projection 测试：重复、缺口、终态、完整快照、epoch切换。

## 2. 同步 authority 与硬边界

- `apps/db-ops-api/src/adapter/display-stream.ts`：同步 publish/watch，捕获 W、替换订阅、先 snapshot/续传再 suffix；不在 capture 和 register 之间 await。
- 每 run 默认 2000 ops/1MiB，terminal TTL 10min；全局 bytes/events/run、单 snapshot bytes/parts 与每连接订阅数均配置并校验。正文 40ms/8KiB，同 part/attempt 合并；progress 200ms，reset/tool/terminal先flush；首个正文/重要状态立即发送。
- Snapshot 包含 S2 完整状态；超限保留本轮尾部、计时/有界工具预览，显式截断标记与授权历史详情 ref。不能续传时 snapshot；冷恢复只读 durable，不重放工具。
- `direct-adapter.ts`：auth 能力协商、会话授权后 watch、终态持久确认后 publish，保留 legacy watcher 与 bounded writer。

## 3. Gateway 与统一投影

- `frontend/src/app/ui/direct-gateway.ts`：协商能力、带订阅身份与游标 watch，重连保留本页游标，刷新走快照；缺口仅请求 watch，不 chat.send；未知 capability 回旧模式。
- `frontend/src/app/ui/chat/message-projection.ts`：stream snapshot 与水位原子替换；delta 复用 S2 reducer。reset/terminal 同步逻辑收口，不依赖 rAF。

## 4. 验证与交付

- focused：共享区间与 Adapter authority 单测；真实 authenticated WS 集成故障注入，Gateway/reducer 比对无断线投影，执行 counter 保持不变；慢 peer 与正常 peer terminal、多订阅、长结果/淘汰/捕获竞态。
- 相同 1000片段/100KB fixture 记录 WS 总字节、正文、元数据、帧数，正文下降至少80%，首发/屏障立即发。
- 模块：Core/API/frontend tests 与 typecheck；最终候选一次 workspace gate、lint、contracts、build/CSP、Chromium audit 与现有 deterministic qualification。必要真实 MySQL/browser qualification 保持原验收断言。
- `docs/slide/runtime-v2/MAX-127-display-stream.md`：验收矩阵、容量、配置、协议兼容/冷恢复边界、原始测量与回滚。
- 单 PR 标题含 MAX-127，推送前确认既有 continuous CI rule 有效，回读关联与当前 head checks；in_review 交父 MAX-124，子任务不 merge/done/启动后继。
