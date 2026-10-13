# MAX-147 T05-B 实施计划

> **Execution:** Follow this plan within existing authorization and repository rules; track dependencies and acceptance evidence. No delegation.

**Goal:** 在已父核验 T04/T05-A 基线上实现持久消息观察、脱敏证据和 V2 结果。

**Architecture:** 使用已有 MySQL/MigrationRunner、调查 live authorization、Canonical Facts 和 Parts。观察器以 Session→Investigation 锁序建立持久事件/水位；WS 通过有界轮询重放持久事件，无订阅间隙且不成为执行 owner。证据与结果使用调查/request/Run 绑定、实时全资源授权和原子版本/幂等键。

**Tech Stack:** TypeScript、mysql2、Fastify、DirectAdapter WS、Vitest。

1. 先建立 stream/evidence/result focused tests，运行并记录 RED。补充真实隔离 MySQL fixture，正式迁移、真实 actor/JWT/WS。
2. 新增 117 调查观察迁移；stream.ts 持久 sequence/cursor、水位、Parts 兼容投影和重放；同 ID 事实去重、过期游标 replay_required、乱序 reducer。
3. evidence-store.ts 在写入前脱敏；区分 observed window/collected at，绑定原 request/Run，7 日原始快照及 tombstone，显式保留策略。
4. result-schema.ts 严格验证本调查/原 request/Run 引用与 provenance；版本原子、并发幂等；模型不得制造人工/实验验证或 resolved。保留 v1 reader，执行摘要无无约束 reasoning/confidence 准确率。
5. 最小 DirectAdapter watch/unwatch 和 HTTP 装配；接通持久后台事实，逐次及 periodic live ACL，撤权关闭订阅，断线不取消 Run；同步公开契约生成类型。
6. focused→相关模块测试、真实 SQL/JWT/WS、旧 Chat/Run/Parts 回归、API typecheck/contracts、安全扫描与受影响前端检查。按当前代码记录证据和 FINAL-0084 消费裁定，不修改父 Review 矩阵。
7. 独立 MAX-147 PR；准确 head CI、父独立 Review 后普通合并并确认 main 包含 head/merge。父 Review 缺失保留 PR 与具体阻塞，不自动释放后续 stage。

排除：新模型调用、生产操作、System/source 工具、事件生产 hook、完整 workspace、feedback/关闭写入、V2/V3、共享授权/ledger/store/executor 泛化改造。无硬预算，遥测若不可用明确标注。
