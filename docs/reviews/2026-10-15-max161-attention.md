# MAX-161：关注事项排序与读取状态验收

基线：main `3ca5c6fb9357b8e2eb1adb9aed9e266db825839c`。实现：`13df387a82d6c971be17e3c09ccca4939404dfc3`，分支 `codex/max-161-investigations`。

## 根因与变更

真实事件服务返回数值 `id`。相同严重度、相同更新时间的事项触发 `id.localeCompare` 异常，旧页面捕获错误后仍渲染空表，错误提示和“暂无关注事项”同时出现。

- ID 比较统一转为字符串，保留现有严重度、更新时间、文本 ID 的排序规则；兼容旧字符串 ID，不修改输入数组。
- 分开记录未读取、加载、成功、失败、登录失效；只有成功返回空数组才展示空状态。
- HTTP 401/403、网络失败、未知响应格式和权限尚未确认不再暗示业务为空。未知严重度/事项状态仍保留原值。
- 权限改变、会话失效、组件离开均使迟到响应失效，并清空旧事项和旧错误。
- 生产代码只修改 `frontend/src/app/ui/views/investigations.ts`，未调整资源概览或布局。

## RED → GREEN

- `090a25a9`：回归单测在基线执行，19 项中 14 项按预期失败；包括 `a.id.localeCompare is not a function`、错误后仍出现空状态、权限未知/失效文案。
- `fe3473b1`：Chromium 在当前基线页面、真实 JWT/实时授权、真实事件服务与独立 MySQL 8.4 下复现相同问题。3 条有效事件返回数值 ID，页面却显示空表。
- 修复后 focused 单测 22/22、前端全部 104 文件 / 872 项通过。

## 当前候选验证

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter slide-frontend test` | 104 文件 / 872 项通过，包含关注事项 22 项 |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm --filter slide-frontend build` | 通过，CSP 2 个生产脚本通过；保留既有大 chunk 提示 |
| `pnpm lint` | 0 错误；270 条既有警告；最终触及文件 lint 0 错误、1 条既有 fixture 未用参数警告 |
| `T06_TEST_MYSQL_PORT=<独立测试端口> pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts attention.spec.ts --reporter=line` | Chromium 5/5 通过 |

未改变公开 API 契约。完整仓库 CI 由关联 PR 执行，本地前端检查不替代其门禁。

## 浏览器证据及数据来源

入口为完整应用 `/attention`。夹具启动独立 Vite、Fastify、JWT 和 MySQL schema，使用正式 `alertEventService.getEvents`、实时授权与实例权限范围；GET 路由为生产列表无 instance_id 筛选分支的测试装配，未运行整个生产 `server.ts`。数据为合成事件；无线上采集、共享平台数据改写或产品模型调用，fixture `providerCalls=0`、`toolCalls=0`。

| 场景 | 来源与断言 | 截图 |
| --- | --- | --- |
| 成功有数据 | SQL 中 201/202 相同时间、相同严重度；203 较低严重度但更新时间较新；通过 HTTP 返回数值 ID，表格顺序 A、B、较低严重度，无错误/空状态 | `data-1280-light.png`、`data-1280-dark.png`、`data-390-light.png`、`data-390-dark.png` |
| 成功为空 | 真实服务返回空数组 | `empty-real.png` |
| 无权限 | SQL 实时移除 alert:view，真实 HTTP 403；不显示表格和业务空状态；测试后恢复夹具权限 | `forbidden-real.png` |
| 加载与失败 | Playwright 受控延迟及 503；加载按钮禁用、骨架表；失败后无表格/空状态 | `loading-controlled.png`、`failure-controlled.png` |
| 未知格式 | 受控 200 `{}`；显示格式异常；键盘重试切回真实服务后恢复成功空状态 | 与上一场景同用例 |
| 会话失效 | 受控 session-expired 事件与迟到响应；完整应用返回登录页，事项页移除，敏感迟到事项不恢复 | `expired-controlled.png` |
| 权限未知/拒绝 | 受控组件 permissions 为 null / 空 Set；分别显示确认中 / 无访问权限，不显示业务空状态 | `permission-denied-controlled.png` |

正常数据截图视口 1280×900、390×900，浅色/深色主题；页面无横向溢出，窄屏延续现有表格内部横向滚动。已人工查看桌面浅色、窄屏深色和失败截图，内容、主题及错误与空状态互斥符合本次范围。

键盘：刷新按钮 Enter 发起真实 GET；重新聚焦刷新后 Tab 移至事件中心按钮，Enter 导航到 `/events?tab=events`；失败后 Enter 重试恢复。正常路径未产生浏览器 pageerror。

截图在最终 Multica 交付评论作为图片及完整证据 ZIP 附件提供，ZIP 内包含本报告。未部署或合并，等待 PR CI 与父任务审核。
