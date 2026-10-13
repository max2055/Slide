# T07-C 治理只读事实实施计划

> **Execution:** 在已有授权和文件所有权内完成，不派生代理。父独立审查前保持 in_review。

**Goal:** 为 T06 提供真实策略配置状态、实际预算配置及持久账本用量的版本化 HTTP/生成类型。

**Architecture:** 沿用已批准 T07-C 方案。生产目前没有 TriggerBinding 注册，策略返回未配置/未接入；不把持久事件历史或测试夹具当作注册源。预算复用 investigationBudgetConfiguration，并展示正式 domain 快照是否匹配。账本采用 ai:view 与既有 config:manage 的全局聚合管理授权交集，先在同一只读 SQL 事务重验 live 主体，再计数/分页；不提供普通资源用户的全局访问。成本按币种分组，仅费率估算，unknown 保留非零账本额度。

**Tech Stack:** Fastify、TypeBox、mysql2、正式 MigrationRunner、Vitest、JWT。

## 1. 严格公开契约和读服务

创建 `apps/db-ops-api/src/investigations/governance-contracts.ts`、`governance-store.ts`、`governance-routes.ts`。三个 GET 路径 `/api/investigation-policies`、`/api/investigation-budget`、`/api/investigation-usage`。策略 items 为空且说明未配置；预算投影现有全部 admission 配额和两个环境金额、Profile 上限引用以及持久快照匹配状态；usage 仅支持 limit 1–50、offset 0–200000，计数先鉴权、分组固定按 currency/state/mode 排序，返回五种 state 数量、usage 可用性、预留/保守额度和已知 token、每币种估算成本。全历史窗口明确声明，分页不宣称跨请求稳定快照。只返回全局分组汇总，不返回调查/账本明细标识、domain/actor/operation/request snapshot/prompt/事件内容。

## 2. 真实 SQL/JWT/HTTP 验收

创建 `governance.mysql.test.ts`；正式迁移后使用隔离数据库与真实 TCP HTTP。通过既有 ledger 写端口准备 reserved/sent/settled/unknown/cancelled 和缺费率已知 usage 夹具；读取测试本身不写。断言 cachedInput 属 input 子集、unknown 保留、不同币种不合计。验证全局聚合管理授权交集、ai:view 单独拒绝、普通 config:view 拒绝、bounded 主体拒绝、同 JWT 撤权/角色失效/禁用/session 撤销、服务身份禁登录、非法分页、只读方法、秘密不泄漏、读前后正式表行值不变。接入 `scripts/qualification/run-auth-boundary.sh`。

## 3. 最小注册与回归

只修改 `server.ts`、`src/contracts/public-api.ts`、`generate-public-api.ts` 的注册，运行 `pnpm contracts:generate`/`contracts:check`，生成类型随 schema 更新；不改前端 UI。运行真实授权 gate、调查相关模块、后端/生成类型 typecheck、security:test、security:scan、lint、diff 检查。记录当前代码 hash 和真实日志于独立验证材料。

## 4. PR 与交接

保留起始托管分支、AGENTS 用户改动及私有 .multica；只提交本阶段产品文件。独立产品 PR 排除私有文件和历史工作树差异。准确 head CI 收集一次前台 watch，父独立 Review 为合并前置；先交付 in_review 供父核验，不自行启动其他任务。零模型请求、无生产操作、无硬预算，实际 token/费用遥测不可用。
