# MAX-177 审批历史实施计划

> **Execution:** 在已有 R1.1 授权及文件写锁内执行，不委派、不修改后端。

**Goal:** 紧凑浏览审批历史，独立筛选审批与执行结果，按需查看完整证据。

**Architecture:** 继续使用 unified API；有限数据内客户端稳定排序、筛选、6 条分页。SQL 历史详情读取现有详情/事件 API，Agent 详情展示当前 feed 原值及执行证据限制；消费 app-card、app-data-table、app-dialog、app-badge。

**Tech Stack:** Lit 3、Vite、Vitest、Playwright、现有 Fastify/MySQL 隔离验收工具。

1. 仅修改 `frontend/src/app/ui/views/approval-dashboard.ts`：分离历史与待审批布局；解析 JSON 及状态，不由审批通过/Agent consumed 推断执行成功；拒绝与成功证据冲突标记冲突，保留原值。
2. 历史支持摘要/目标查找、审批/执行独立筛选，改变筛选回首页；刷新和详情返回保留筛选/页码，sessionStorage 恢复同标签页上下文；记录读取上限。
3. 历史使用共享弹窗展示完整 SQL、AI、备注、执行结果、审批事件和 Operation 原值；加载/失败/部分证据明确可见；原待审批动作及执行选择沿用原接口。
4. 创建 MAX-177 专属 Vitest 和 Playwright 文件：覆盖拒绝/失败/未知/冲突、长内容密度、分页及刷新、竞态、完整证据、权限失败、弹窗焦点、待审批动作。真实服务使用独立 MySQL 与当前 server.ts；不绑定或执行生产目标、不调用产品模型。
5. 代表页先完成实际数据截图与 R1.1 对照，再核验待审批；桌面/768/390、明暗、空/加载/失败/权限/未知/部分/冲突；截图记录 commit/视口/来源。
6. focused 测试 → 前端 typecheck/build/完整测试及必要安全门禁。提交 codex 分支、创建关联 PR、回读实际关联并设置 30 分钟 checks wakeup；保留未完成项，交 Chief 审阅。

停止条件：范围内功能、视觉、真实服务证据及本地 gate 完成可交审；外部权限或隔离环境不可用时交付已验证结果及精确阻塞，不伪报完成。
