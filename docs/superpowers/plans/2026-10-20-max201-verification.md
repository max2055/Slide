# P08 效果验证与结案实现计划

> **Execution:** 沿已批准 implementation-1.2 / functional-delivery-1 执行，不派子代理。

**Goal:** 完成 B13 固定窗口、不可变效果报告、独立证据引用与人工结案。

**Architecture:** 在已审 P07 89435614 与 P10 c9fe7452 的组合基线实现；沿既有 action_verification_reports 追加版本。受信采样端口提供固定目标健康与历史快照，HTTP 不接受样本或验证标准；读取/采样/落库/结案均重新授权。结果只表达时间相关性。

**Tech Stack:** TypeScript, Fastify, MySQL 8.4, Vitest。

1. evidence-adapter.ts：固定定义哈希及窗口、采样绑定与判定。测试 120 秒历史、60 秒就绪、300 秒/10 秒健康、无改善/恶化/缺样本、篡改。
2. verification-store.ts：执行锁串行化，固定 execution/plan/result/investigation 修订，追加 immutable versions 与事务 outbox；历史读取和实时权限；无新迁移。
3. verification-service.ts / verification-handler.ts：发送前预注册历史快照；只读受控采样及断点恢复；GET 无副作用，POST 不接受客户端样本；未知执行不重发。
4. 最小扩展 feedback-types/contracts/feedback：独立 actionReport 引用，经同事务验证完整链/最新结果/报告哈希/有效期/调查修订；旧人工证据路径维持，新 Run/重开使旧引用失效。
5. 隔离 MySQL + 受控 HTTP + 可控时钟测试真实存储与人工反馈、安全负例。运行 actions/investigations 相关回归、API typecheck、contracts:check；交准确 head PR/CI/矩阵给 Chief 独立审查，不合并或部署。

停止条件：本包完整实现与适用验证，准确 PR head CI 已收集；或具体外部阻塞已保存可恢复代码与证据。测试身份与采样为 synthetic，不作生产资格或因果结论。
