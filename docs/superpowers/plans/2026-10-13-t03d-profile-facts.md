# T03-D Profile 只读事实实施计划

> **Execution:** 在 MAX-144 T03-D 已授权范围内实施，保留托管历史与用户修改；不委派。

**Goal:** 为 T06 设置页提供真实版本化 System/Ops Profile 事实。

**Architecture:** 独立 GET `/api/investigation-profiles` 使用正式 verifyToken 的实时主体查询和既有 `ai:view` 设置权限。直接投影 INVESTIGATION_PROFILES，返回预置状态、Profile hash 与输出 schema 标识；不读取 Provider 凭据、原始 prompt 或用户信息。严格响应 schema 和 private,no-store 覆盖成功及拒绝响应。

**Tech Stack:** Fastify、TypeBox、JWT、Vitest、隔离 MySQL 8.4、正式 MigrationRunner。

1. 新建 `src/investigations/profile-routes.test.ts`：正式迁移、真实 TCP JWT GET；验证两 Profile 与权威定义一致、hash/预算/schema、无敏感字段，未登录/无 ai:view、禁用、删除/过期 role、session version 撤销、服务身份均拒绝；相同 JWT 权限更改立即生效；POST/PATCH 不存在。先运行确认新增端口 RED。
2. 新建 `profile-contracts.ts` 和 `profile-routes.ts`，使用 InvestigationProfileSchema 作为严格嵌套响应与显式投影；在 server.ts 最小注册。公开 contracts/generator 加入响应类型及 GET 文档并重新生成，不修改 UI。
3. focused 真实 MySQL 测试 GREEN；授权/Chat/bridge/HTTP 回归，typecheck/contracts/security/lint。将测试加入现有 auth qualification 命令，保证 CI 实际执行而非 skip。
4. `docs/slide/ai-native-operations/t03-d-validation.md` 记录接口、权限、状态语义、T06 消费与共享文件交还、准确命令和实际验收。独立 PR 仅包含本阶段必要文件，排除托管私有材料及原工作树差异。
5. 获取准确 head CI 结果，交付 in_review 等待父独立 Review；不自行合并或启动其他任务。无模型/生产调用。完整 gate 归 T12。
