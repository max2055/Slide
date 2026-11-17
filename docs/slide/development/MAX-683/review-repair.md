# Chief 首轮复核返修

2026-11-16。返修起点 `eed274e29f1ae03d74bc0e903648915cb480597f`，重新获取的 main 仍为 `92aa557b887729e19ce2aa4a9e8a957d4e2935ac`。最终提交 SHA 随交付评论及附件清单记录。

## 问题与修复

| 复核项 | 结果 |
|---|---|
| dashboard 和调查工作区仍断言旧地址 | 保留旧 URL 输入测试，将规范落点断言改为 `/workbench`；入口上下文、精确版本和拒绝后返回验证保留。 |
| 关注事项五项 E2E 找已取消的组件 | 迁移至完整应用的事件中心；两种旧入口仍使用真实 JWT、实时 SQL 权限及事件服务。覆盖 open/investigating/handled，排除 resolved 后可切换历史列表；同时间数字 ID、读取顺序、刷新、空态、503、异常格式、撤权、会话过期与迟到响应继续验证。 |
| 首次异步权限未选择行动页签 | 增加的两个单测在返修前均失败（事件通知、属性更新）。现在权限更新时解析纯 `/workbench` 默认页签；使用 replaceState，不额外增加历史。显式查询上下文及手动选择不被改写。 |
| 接替页面未保留键盘与安全状态 | 聚合事件权限待加载时不挂载列表，撤权卸载旧内容；失败清除列表、统计和详情，不呈现成功空态；卸载使在途请求失效。事件行使用有名称的原生按钮与可见焦点，详情带精确 ID，支持 Escape/返回恢复焦点和原搜索；支持按 ID 搜索和有名称的严重度控件。服务端权限未修改。 |

`workbench-clarity` 原有同名事件、搜索/状态筛选、键盘详情返回、撤权、失败/空态、命令面板和诊断分组测试同时迁移，不通过删除或新跳过来消除失败。旧的可选真实 HTTP 用例原配置条件未变；本轮缺少对应配置，仍按原条件跳过，不算业务通过。

## 可复核的验证入口

从 frontend 运行下列命令。SQL 类入口必须显式提供任务独占的 T06_TEST_MYSQL_PORT 和 T11_TEST_MYSQL_PORT（密码通过对应环境变量），不可使用生产库。

| 命令 | 本轮结果 |
|---|---|
| `pnpm exec vitest run src/app/ui/views/workbench.test.ts src/app/ui/views/event-center.test.ts src/app/ui/views/event-management.test.ts src/app/ui/workbench-routing.test.ts src/app/ui/app-navigation.integration.test.ts` | 5 文件，58 项通过。 |
| `pnpm exec playwright test --config playwright.investigation.config.ts`（新增登录文件之前） | 原 12 文件完整套件 81 项通过。 |
| 同配置定向 `workbench-authority.spec.ts --workers=1 --output=test-results-authority` | 3 项通过，作为新纳入该配置的文件单独验证。完整应用、真实密码/JWT/实时 SQL 权限；行动列表为受控空响应，只验证首次登录及无缓存刷新时序，不替代真实处置。 |
| 同配置定向 `attention.spec.ts --workers=1 --output=test-results-attention-final` | 最终 5 项通过、退出 0。模型和工具调用计数均为 0，读列表/开详情/切换状态无隐式写操作。窄屏历史截图后恢复桌面再操作，解决新增点击被移动导航层拦截的测试上下文问题；未增加超时。 |
| `pnpm exec playwright test --config playwright.workbench.config.ts` | 16 项通过，1 项原条件跳过；包含延迟权限事件的首次挂载、刷新及显式深链接；保留既有尺寸/主题用例。 |
| `pnpm exec playwright test --config playwright.audit.config.ts dashboard-overview.spec.ts` | 21 项通过。 |
| `pnpm typecheck`、`pnpm build`，根目录 `pnpm ci:source-policy` | 通过；构建包含 CSP 检查，打包体积提示为警告。 |

SQL 环境使用本轮独占 MySQL 8.4，native AIO=OFF、768MiB 与小缓存。所有数据库和服务由夹具隔离并关闭，本轮容器完成后停止。没有修改宿主 AIO，也不声称该宿主问题已修复。相关后端源代码和授权链本轮未变，复用此前 8390 通过/1901 原条件跳过及 162 项真实 SQL 授权证据；不重复无关后端全量。

## 当前边界

此前 CI run 43798567829 已结束且失败，原因是遗漏迁移；不能称运行中或完整 CI 通过。本轮只交付本地返修和验证，不等待外部 CI，release-artifact/ci-gate 未在本地重建。

普通对话权限由 Max 明确移至 MAX-684，不是本 PR 验收依赖；既有核查材料保留为历史，未实施全局聊天授权重构。非作者独立复核由 Chief 承担，本材料仍是作者自查。

真实目标恢复/未改善/证据不足，以及真实计划详情/弹窗桌面业务验收仍阻塞：旧 manifest 已过期、目标 SSH 握手前断开、采样端点拒绝连接。本轮没有重试、续签、重放批准或更换目标。需安全渠道提供本轮有效受信配置、恢复原目标和健康采样，再用新计划及新的独立批准执行。受控详情测试不充作该业务证据。

未合并、未部署；Issue 保持 in_progress。保留键盘、焦点、控件名称和自动化检查，不设置人工读屏或 VoiceOver 听读门禁。
