# T08 数据库告警与 Analysis 兼容实施计划

> **Execution:** Follow this plan within existing authorization and repository rules. 不派生代理；父独立 Review 保留。

**Goal:** 数据库告警进入统一只读调查，旧结果显式链接且不补跑。

**Architecture:** 复用已批准 implementation-baseline.md、菜单决定及 T02–T07。按告警持久冻结执行 lane；MySQL 锁串行化旧/新入口。新自动入口复用 source-bound event ingest、服务身份和共享 ledger，手动入口复用 SessionBridge。只读 legacy link 不产生 request/job/Run。

**Tech Stack:** Fastify、TypeScript、MySQL、Lit、Vitest、Playwright。

1. 在最新 main 上有界复核 Analysis/告警权限、现有 dispatch 和实时授权。保留托管起始 commit、用户文件、原模型 5/6 停发历史。
2. 新增正式 additive migration、数据库告警桥与分来源 flags。数据库告警所有 RCA 调用复用持久 owner；旧 active/unknown 不被新 lane 接管，flag 回切不接管新 job。自动权限/预算拒绝及基础设施失败不 fallback 双发。
3. 新增 legacy-analysis-bridge：首次显式查看/转入时唯一 link、原资源权限和 analysis actor 权限、归档只读调查。SQL/健康/故障/告警历史不补造 Run、证据、置信度或恢复结论。
4. 注册认证桥接入口，告警页面响应调查 ID 并导航 Workspace；Workspace 展示 legacy 原结果，沿用旧路由。公开契约同步。
5. `legacy-analysis-bridge.test.ts` 与 `alert-bridge.test.ts` 覆盖受控隔离 MySQL 正式迁移、并发/回切/归属/撤权。真实 JWT/HTTP/WS/Chromium CPU 与慢 SQL 夹具核验同 ID、一个请求链；受控 provider 明确标注合成，外部模型零新增。
6. 运行受影响模块、typecheck/build/contracts、安全 gate；保存确切结果及限制，独立 PR 当前 head CI、父 Review 后方可普通合并。不以部分证据宣称 T12 总验收或生产上线。
