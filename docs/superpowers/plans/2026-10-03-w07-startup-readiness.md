# W07 启动续租与就绪实施计划

> **Execution:** 按已批准的 MAX-115/W07 规格自主实施；不委派、不扩 HA，不操作实际环境或生产数据。

**Goal:** 慢初始化期间持续拥有全局租约，失去所有权立即取消并关闭资源，生产探针准确反映 D1 的派发能力。

**Architecture:** 独立 WorkerStartup 管理有界续租、AbortSignal 和统一关闭。API 必需初始化与 leader-only 副作用分开，每次启动副作用前确认租约；readiness 仅输出布尔值。继续保留 JWT+config:view 详细健康接口。

**Tech Stack:** Fastify、TypeScript、Vitest、MySQL 8.4、Docker Compose。

1. 在 `src/lifecycle/worker-startup.test.ts` 复现超过 30 秒初始化、失败/阻塞续租、半途失败及晚到资源释放；聚焦运行确认失败，再实现 `worker-startup.ts` 和 `worker-lease.ts` 的过期保护。
2. 修改 `server.ts` 分离 API 初始化和后台启动，所有异步阶段可取消且启动副作用前校验所有权。统一所有角色关闭路径，Cron 触发在启动/备用/失租状态返回 503，CRUD 允许无本地 scheduler。
3. `cron-run-store.ts` 恢复仅处理无有效 workflow owner 的中断运行；删除无法证明所有权的 legacy 全量 reaper。以真实 MySQL 保留活跃 owner、恢复过期 owner 为验收。
4. `health-routes.ts` 新增 `/api/health/ready`，数据库/派发表检查有界，未就绪和异常返回 503 `{ready:false}`；更新 schema、生成契约和权限测试。
5. `compose.production.yaml` 透传五个开关、使用新探针及 start period；配置示例保持默认关闭，启动日志仅输出允许的有效布尔/数字配置，启用 Memory 缺 workspaceId 明确失败。
6. 用隔离 MySQL 和两个真实 API 子进程运行 `tests/qualification/startup-readiness.test.ts`，验收超过 30 秒启动、备用不接管、数据库失联、半途失败、开关容器透传。聚焦检查完成后最终候选统一运行受影响模块完整门禁；文档记录命令、结果和未验证范围，推送并创建指向 main 的 PR。

基线 `6faff9dbd6fb7213a86c2fa959abed9809ee52fb`；硬预算未设定；token/费用实测不可用；子代理 0、深度 0、并发峰值 1。停止条件为交付 PR 和实际证据，或明确无法恢复的外部权限/环境阻塞。合并由 MAX-107 执行；不自行标 done。
