# MAX-74 Implementation Plan

> **Execution:** Follow the approved design within existing authorization and repository rules.

**Goal:** 配置目录、包、策略及三类资源配置闭环。
**Architecture:** Lit 共用配置组件；Fastify 复用 PolicyService、runner 与 MySQL reservation。试采不写正式存储。
**Tech Stack:** Lit / TypeScript / Fastify / MySQL / Vitest / Playwright。

1. `src/metrics-v2/config/service.ts`、`routes.ts`：目录、资源权限、最近尝试、有界试采；验证恶意字段、403、并发锁、超时与 CAS；保持已有 policy API。
2. `src/metrics-v2/config/access.ts`：资源自己的已有数据库/SSH/SNMP 接入；禁止客户端目标和凭据；缺少生命周期证据保持 unknown。
3. `frontend/src/app/ui/components/metric-configuration.ts`：共享资源配置编辑，inherit/set，完整保存覆盖，预览/试采失效与 revision 冲突保护。
4. `frontend/src/app/ui/views/metric-settings.ts` 和已有设置/资源详情：稳定列和兼容路由、三类详情入口、只读权限。
5. focused Vitest、前后端 typecheck/build、隔离 MySQL HTTP 与浏览器流程、文档目录门禁。结果记录 `config-ui/verification.md`，提供 PR。

验收与排除范围沿已批准 design.md。硬预算未设定；真实遥测不可用；生产发布不在授权范围。
