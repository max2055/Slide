# MAX-125 工具事件实施与验证契约 v1

目标：保留真实 toolCallId，逐调用发布计划、排队、执行、结算及 checkpoint 持久化边界；修复 text→tool→text 重复前缀。
基线：c3195b46c81f6855bab32ee4e5b622575d7ce031。设计依据：[比较报告](../evaluations/2026-10-04-agent-streaming-comparison.md) §6.2。
排除：完整 Parts reducer、增量 WS、快照续传、生产部署、付费模型调用。硬预算未设定；实际 token/费用遥测不可用；无子代理。

## 实施清单

1. `packages/agent-core/src/tool-stream.ts` 提供 browser-safe 工具协议、字段校验、唯一 wire→UI 规范化和有界脱敏预览。旧无 ID 工具帧不猜配；历史沿用现有 MessageParts 转换。
2. `runtime/tool-executor.ts` 在每个执行边界发事件，progress 捕获调用 ID；快工具不等待整批结束。`turn-loop.ts` 仅在 tools_completed checkpoint 成功后发 persisted。取消/超时未知结算不标成功。
3. `direct-adapter.ts` 转发执行器事件，正文保留旧累计 delta，新增 partId/partText。`direct-gateway.ts` 在工具屏障 flush 并校验/规范化。`app-tool-stream.ts` 保存独立身份、阶段、计时及段顺序。
4. focused 测试覆盖同名并行、重复帧、error、取消/unknown、边界校验、预览安全和真实 Adapter→Gateway→UI。受影响模块测试及 typecheck/build 作为最终本地 gate；仓库完整 CI 由 PR 当前 head 执行。
5. 验收证据记录 SHA、环境、命令、结果与未验证项，创建 MAX-125 PR 并核验平台关联。进入 in_review，父任务负责检查及合并。

停止条件：真实权限阻塞、未合并前置、或不可恢复验收环境；保留可审阅候选与准确未验证项。回滚入口为撤回本任务 PR；无 schema 迁移。
