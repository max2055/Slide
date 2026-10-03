# MAX-114 分析持久派发实施计划

> **Execution:** 在已有实施授权与串行规则内执行；不委派代理。

**Goal:** 分析与派发意图原子持久化，安全窗口恢复，未知窗口不自动再次计费。

**Architecture:** 复用 MySQL workflow_jobs 和 outbox_events，新增不可变请求快照、分析尝试和去重键。worker 持有 owner/fencing/租约；发送与完成均校验身份和当前权限。供应商没有查询或幂等契约，发送后不确定结果停在 unknown，用户明确确认后创建新分析并保留旧记录。

**Tech Stack:** TypeScript、Fastify、MySQL、Lit、Vitest。

基线：origin/main@db4b7d0515a31a5c733fed5ade81a286510fc823。范围版本 v1；仅 W06b。排除 HA、供应商付费验证、历史 provenance 补造和生产数据修复。硬预算未设定；实际 token/费用遥测不可用；子代理 0。

1. 在 `src/analysis/analysis-recovery.mysql.test.ts` 使用独立 MySQL 数据库、假供应商与退出子进程。复现提交后/发送前退出丢失、发送后重复调用、迟到完成越权；先观察失败再修复。
2. 新增 `109_analysis_dispatch_recovery.sql`、`analysis-dispatch-store.ts`。创建/绑定分析、快照、outbox、workflow 同事务；按去重键串行受理。记录 attempt、owner、fencing、request state；租约失效后 unsent 安全重领，sending 变 unknown。每次写入都受当前 workflow 租约约束。
3. 修改 `ai-agent-bridge.ts`、故障和资源诊断服务，使 HTTP 受理只提交 durable intent；移除其进程内监控锁。完成缓存仅在证据、权限、配置和 TTL 一致时复用；无来源历史结果保持可读但不参与该缓存。
4. 新增 `analysis-dispatch-handler.ts`；修改 DirectAdapter invoke options 支持可信完成回调和发送前回调。供应商异常后禁止执行器再次调用供应商；权限撤销、配置变化或租约丢失禁止后续请求与完成。普通无身份完成路径不得改写 durable 分析。
5. 在 server worker registry/startup 接线派发与定期恢复。legacy pending/running 保留原状态/结果和原因；dry-run 分类已有结果与无法确认，不自动派发。关闭派发开关仍可查询未结任务。
6. API 显式 unknown 重试确认；前端展示结果未知与再次计费后果。生成 API 契约，添加受影响状态与权限回归。
7. 运行 focused Vitest、隔离 MySQL 故障测试、受影响 typecheck；最终候选统一运行模块 gate。提交最小文件集、push 并创建指向 main 的 MAX-114 PR；保存精确 SHA、命令、环境、迁移/回滚和未验证项。进入 in_review；合并由父任务串行处理。

验收：同事务失败不残留分析；创建提交后退出仍可执行一次；发送前退出可安全恢复；发送后/响应后完成前退出归 unknown、不自动重发；完成落库后退出不再次调用；双 owner 迟到工具不可覆盖；失效 active 不无限复用；unknown 普通重试不计费，显式确认创建新尝试；权限撤销不执行；legacy 结果和原因可查。

停止条件：既定交付全部具备可复核证据，或真正缺少外部权限/强制审批；环境失败先排查，不扩大范围。

## 范围增量 v2（保留 v1）

TopSQL、告警 RCA 和事件触发仍预创建分析或依赖进程内锁，直接阻塞“分析+派发同事务”验收；因此一并改为持久受理并传递 actor。增加真实全量迁移验证，因为生产启动要求表/字段注释；补充旧 TopSQL cache key 与自动 unknown 经明确确认转为手动请求的兼容回归。其余范围、预算和停止条件不变。累计子代理 0；实际 token、cached input、output 和费用遥测不可用，未重置累计统计。
