# MAX-102 验收证据

基线 main `0e80676bb956bdbf4deb266e17c260346b75984a`，直接依赖 MAX-99 #104 与 MAX-101 #105 已核验 merged。独立分支 `agent/15astra/max-102-retrieval`；原工作树与用户 AGENTS.md/.multica 改动未改写。

## 结果与预算

检索先 workspace/actor/session/显式共享权限过滤，再排除 superseded、invalid source、冲突和 uncertain 的结构化陈述；不同 owner 显式共享后同 kind/subject 内容矛盾，也在排序前排除，不能以 recency/count 截断解决。canonical user 源 ID/hash/逐字 quote 每次重验；共享记录按真正 owner scope 校验，owner 失效不能由 recipient 保留。BM25 的 IDF 只计算可访问有效池；updatedAt/稳定 ID 决胜，支持 kind/subject。无匹配不返回 recency 或全文。scan/query/IO 失败返回空并记录明确错误码。参考数据不授予工具权限或审批。

默认 maxCount=5、maxTokens=4096、maxRecords=1000、maxQueryBytes=4096；可通过构造配置修改。业务环境变量 `SLIDE_MEMORY_RETRIEVAL_MAX_COUNT`、`SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS`（0 禁用，上限 20/32768）启动时校验。检索随现有 `SLIDE_MEMORY_PIPELINE_ENABLED=false` 默认关闭，没有额外模型调用或新的自主 worker。

token 口径是现有 `estimatePromptTokens` 的保守 UTF-8 上界，包含 JSON escaping、来源、角色和完整 C2 reference pair；不是实际供应商 tokenizer 或付费 usage。ContextBuilder 再次核验 count/token，单次参考块不写 canonical。无 actor 的 invoke 不读取用户记忆；认证 chat 用服务端 actor/session scope。日志只含 selected record/source IDs、计数、估计/预算、状态及固定错误码；`requestId` 为 `memoryHash(runId)`，可从 run ID 计算定位，不输出查询、正文或异常秘密。

人工 MEMORY 不从 cwd 自动取得权限。ContextBuilder 的 `legacyMemoryScope` 显式绑定且请求 scope 相等才读取（64 KiB/扫描数上限）；业务人工内容通过既有 `memory.import` 进入私有 scope。原文不覆盖；按行摘取引用，标注 `legacy/unknown` + `uncertain`，原文件行/hash或原 import ID 可追溯。单行过大跳过，展开超扫描上限明确空降级。无参数 `getMemoryContext()` 返回 null。

## 冻结检索评测

冻结文件 `packages/agent-core/src/__tests__/fixtures/memory-retrieval-v1.json`：360 条记录、75 条 query，另有 2 条 scope 负例；50 个 DB 运维主题，每个含 active/旧 superseded/跨 actor/两个未解决冲突/失效 source/跨 session 变体，另有 10 条显式共享记录。relevant IDs 在评分前固定；同一集为英文、中文、复合查询与无匹配查询。fixtureHash=`39b3b716077460a84a6e1ef4d74159f5f171e93ae6b5d5663213c7fe82450c9f`（`memoryHash` 对精确 JSON 文件文本，使用 JSON 字符串编码后 SHA-256）。

| 指标 | 检索 | 全量有效池 | 纯 recency（同预算） |
|---|---:|---:|---:|
| Recall@5 | 100% | 7.14% | 7.14% |
| 选中集合 precision | 49.57% | 1.90% | 1.43% |
| 中位 memory 输入估计 | 1,709 | 23,969 | 2,501 |

Precision@5=22.86%（固定分母 5），Recall/precision 均在 70 条非空 relevant query 上宏平均。无匹配 query 单独报告零返回。全量有效池仅用于输入体积；其 top-5 与 recency 同确定性顺序。原始未过滤全文估计 146,185。检索中位输入比全量有效池减少 **92.87%**，所有 query 在 count/token 内且重复结果稳定。跨 actor/workspace、失效/superseded/uncertain 和无匹配的禁止返回数均为 **0**。完整每条 query 的 relevant/selected/source IDs 与三种成本见附件 `MAX-102-retrieval-metrics.json`。

该集为人工合成的词法 benchmark，不代表生产分布或语义同义词召回。precision 49.57% 说明通用词仍可能带回其他可访问主题；没有掩盖为“全部结果都相关”。没有按评测失败临时改标签、embedding 或 LLM judge。

## 验证命令与边界

- `pnpm --filter agent-core test`：最终 580 tests，25 files，通过。
- `pnpm --filter slide-api test`：2,757 tests 全量通过，最后共享冲突改动对应的受影响 backend 66 tests 再验证通过；129 tests / 21 files 因环境条件跳过，不计通过。
- 双方 `typecheck`、新实现及评测脚本 scoped oxlint（0 警告/错误）、`git diff --check` 通过。DirectAdapter 既有 2 个 unused import lint 警告未改动；仓库 lint 门禁仍由 CI 核验。
- `MEMORY_RETRIEVAL_REPORT=../../.multica/MAX-102-retrieval-metrics.json pnpm --filter slide-api exec tsx ../../tests/qualification/memory-retrieval-eval.ts`：冻结指标与硬断言通过。
- `bash scripts/qualification/run-agent-runtime.sh --mode deterministic`：210 个 normal 样例，falseRejects/misses/extraNormalRequests 均为 0，恢复与累计 usage/预算验证通过。
- `MEMORY_RETRIEVAL_MYSQL_REPORT=../../.multica/MAX-102-provider-input.json pnpm --filter slide-api exec tsx --env-file=<已授权 DB 环境文件> ../../tests/qualification/memory-retrieval-mysql.ts`：隔离真实 MySQL 初始化、真实 JWT 验证/actor 重验、真实 WS chat.send、durable completed 和 provider 入口通过。选中 private record 的 ID/source hash 可定位；另一个 actor 的来源未出现；修改与删除来源后不再产生 memory reference；无匹配不回退全文。临时数据库、WS/PID 与工作目录均已清理。provider input/canonical 对照见附件。

崩溃恢复测试使用只复制持久化模块的子进程，新静态依赖曾使 3 条测试无法加载；已改为仅 `retrieveLegacy` 动态加载检索模块，原进程退出/恢复断言通过。真实 WS qualification 等待服务器本次 message handler 的提取维护 drain 后才发下一轮，避免完成事件先于维护结束的并发限流；未改生产 completion/审批/settlement 流程。

真实供应商 LLM **未使用/未验证**，provider 为受控实现，其 usage 是测试数据；实际认证、网络和 MySQL 都是真的。M1 已记录现有配置供应商 HTTP 402；本任务检索不需要模型调用，未扩大付费或部署授权。生产启用/真实模型质量/部署灰度不计通过。

## 资源与交接

硬预算未设定。模型 raw input/cached input/output/费用实际遥测不可用，未填估算为实测；Goal 工具账本未启用，普通 Issue 实施不是新建 Goal。代理总数 1（主线程），子代理 0、最大子代理深度 0、并发峰值 1。此次范围维持 v1，无额外提取器/向量服务/工具功能或生产发布。

独立 PR 交付；保留 in_review 等待门禁与验收。全部 CI 通过且 current head 与验证候选一致、无冲突后按 Issue 授权 squash merge main；若 CI 未完，用 until-pr checks 条件唤醒衔接，失败仅修复范围内阻塞，不绕过门禁。
