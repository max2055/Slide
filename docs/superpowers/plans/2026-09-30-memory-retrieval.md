# Memory Retrieval Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 实现权限与来源有效性优先、预算内的低权限记忆检索，替代请求全文读取。

**Architecture:** core MemoryRetriever 负责记录过滤、来源校验、词项排序、预算投影；ContextBuilder 只注入 reference。业务服务绑定认证 actor/session；旧人工引用必须显式绑定 scope。

**Tech Stack:** TypeScript、Lit 项目现有 Fastify/DirectAdapter、Vitest、MySQL、pnpm。

### 1. 检索核心与兼容人工引用

新增 `packages/agent-core/src/memory-retrieval.ts`、`src/__tests__/memory-retrieval.test.ts`，修改 `memory.ts`/`index.ts`。定义 maxCount=5、maxTokens=4096、maxRecords=1000、maxQueryBytes=4096 默认值及有效范围。验证 scope 后过滤，再核验所有 source id/hash/quote；排除不确定、superseded、invalid 和未解决冲突。BM25 查询、updatedAt/ID 稳定决胜；中文二元组匹配。按整个 ContextBlock 投影估计 token，逐条选择，超限跳过。人工 MEMORY 按行/段有界投影，明确低权限与无来源历史标签。

测试具体断言：私有跨 actor/session/workspace 不返回；显式分享有效，源删除/篡改返回零；无匹配/空 query 返回空；kind/subject、冲突/uncertain、超长单条、JSON escaping、token/count 极小值、失败空降级、相同 query 顺序稳定。执行 `pnpm --filter agent-core exec vitest run src/__tests__/memory-retrieval.test.ts`。

### 2. Context 与业务入口

修改 `context.ts`、`adapter/memory-service.ts`、`adapter/direct-adapter.ts`，添加相关 context/backend 测试。请求明确传入 scope，默认无 scope 不读 memory。BusinessMemoryService 的读取授权和 canonical reader 不能从模型接收 actor。日志脱敏，只含 IDs/count/budget。更新旧 context-authority 样例以显式绑定人工 owner；恶意 memory 由安全参考策略排除，但保留 summary 注入/审批不变量测试。

执行 context/memory tests 和 `pnpm --filter slide-api exec vitest run src/adapter/__tests__/memory-service.test.ts src/adapter/__tests__/direct-adapter.test.ts`。provider input 的 memory role 必须为 derived tool，user bytes 不变，policy/registry/canonical 无变化。invoke 缺少认证身份返回空。

### 3. 冻结评测、真实入口与集成候选

新增固定 JSON 样本、评测脚本和回归断言；标签在运行前固定，覆盖英文/中文、复合查询、共享/跨 actor、新旧更新/冲突和无匹配。产出每条 query 的 relevant/selected IDs 与估计 token；全量/recency baseline 使用相同权限有效候选，另报原始全文体积。验证 Recall@5 ≥0.90、中位输入估计缩减 ≥50%、所有 scope/source 负例零。扩展隔离 MySQL qualification，真实认证 WS 进入 chat，受控 provider 捕获消息，来源修改后第二个真实请求不再注入。记录未使用真实 LLM。

最终一次运行双方 test/typecheck、变更 lint、deterministic runtime qualification，保留日志与 JSON/MD 证据。仅对本次直接阻塞问题修复。提交独立 PR 并设置 in_review；CI 未完创建 until-pr checks wakeup，冻结 head/合并策略，最终一条 Issue 评论附证据。无需生产部署。
