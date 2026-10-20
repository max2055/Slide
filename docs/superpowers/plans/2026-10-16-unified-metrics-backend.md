# 唯一指标后端实施计划

> **Execution:** 在既有 R2 授权和仓库规则内执行，逐项保留验收证据；不重复派发并行前端工作。

**Goal:** 单一语义采集、存储和正式读取，完成正常配置至正式出数及统一暂停。

**Architecture:** 复用现有不可变包、策略 CAS、工作流队列、来源 fencing 和正式发布存储。中性命名迁移保留历史血缘；配置 API 分层表达状态，并编排试采、发布和来源验证。

**Tech Stack:** Fastify、TypeScript、Zod、MySQL、Vitest、pnpm 11.19.0。

1. 固定 `docs/slide/development/unified-metrics-backend-contract.md` 和 `src/contracts/metrics/configuration-status.ts`；逐项映射旧采集能力、消费者和持久表，先提交契约供并行前端消费。
2. `metrics/config` 加入 status、recommendations、activate；`metrics/policy` 加入权限过滤组查询。测试未知、缺绑定、无权、失败、版本不兼容和 CAS 冲突，不能从核心列空值推断绑定。
3. `metrics/scheduler` 统一资产/global/policy 开关，入队、每次远端请求和提交复核；停止 monitor/server/network 独立周期调度。验证停用无新尝试、在途落盘被拒、重启恢复。
4. `metrics/rollout` 将真实样本、质量、来源和 revision 门禁接入持久调度；新源初始化与历史源迁移分开，不制造零差异 gate。验证正式 API 仅接受当前 generation。
5. 中性目录/import/API/env/table 迁移；历史 SQL 不修改。新增受锁保护、冲突检查的原子改名；备份、重跑、并发、回退实库检查。
6. 运行受影响 focused、后端 typecheck、contracts 和迁移门禁。本机 MySQL 正式 API 至少三周期，VM 停用与启用真实验证；记录代码、配置和环境，不调用产品 LLM。
7. 一个主 PR，推送后在本任务登记 checks/30m/on-timeout wake，读取准确 head 已完成结果；完整交付转 in_review 交 Chief 独立审查。未通过的必需验收明确保留。
