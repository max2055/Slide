# Sandbox shared nonce Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; track acceptance evidence. No delegation required.

**Goal:** 同一有效签名在 controller 多副本和重启后最多执行一次。
**Architecture:** 保留 HMAC；共享 MySQL InnoDB 唯一键认领，数据库时间复核窗口，提交后执行，故障返回 503。
**Tech Stack:** TypeScript、mysql2、Vitest、隔离 MySQL Docker。

1. `src/request-auth.test.ts` 覆盖签名、窗口、重复和存储失败；`request-auth.ts` 改为注入异步 nonce store，取消本地 Map。
2. `src/nonce-store.ts` 原子 INSERT SELECT（数据库时间窗口校验）；独立批量清理，严格过期才删除；`096_sandbox_request_nonces.sql` 建 InnoDB 表。固定认证域，所有副本共用权威写库。
3. `src/server.ts` 三个入口统一等待鉴权并将存储异常映射为 503；Compose 配置专用凭据和数据库网络。补部署恢复说明。
4. `src/nonce-store.integration.test.ts` 用两个真实 controller 子进程及假 docker 无害执行器，验证并发/顺序重复、进程重启、数据库重启/故障恢复、TTL、独立请求；只操作测试自建容器。
5. 运行 `pnpm --filter slide-sandbox-controller test`、`typecheck`、客户端兼容测试与 deployment-security 检查；记录证据后提交分支/PR。生产拓扑未核实不冒充已验证；不部署生产。

基线：origin/main c53e137，相关 controller 与已审阅 711f5cb 无差异。预算未设定，实际遥测不可用。
