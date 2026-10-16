# MAX-187 默认文字蓝更正验收

本次将项目默认 accent、默认浅色文字、外观默认预设及按钮 palette 改为 `#265F99`。保留 MAX-184 的布局、国际化、偏好同步实现，不迁移无法判断来源的历史个性化值。

## 版本与实现

- 基线：`c8eef9590a8674af5c022f328346c21fe71efa3e`（main），包含 PR #198 实际 merge SHA `1b059e4ec5b89232b3c0254e56d112b17f7d4903`。
- 受测实现提交：`81ccbdbddfed54b1997d575a71386c7b191e33c9`；后续验收文档提交不改变实现。
- 前端默认常量集中在 `frontend/src/app/ui/accent-color.ts`；CSS 的无脚本默认与后端新偏好默认同步修改。
- 浅色默认文字直接使用新蓝；显式自定义色继续使用既有浅色文字混色规则。暗色文字向白色混色，填充色保持用户选择，并按亮度选择黑/白前景；显式按钮 palette 优先。
- 活动侧栏文字及资源概览链接复用 `--accent-text`，移除资源概览对主要按钮的局部 palette 覆盖。既有字重和布局保留。
- `#409eff` 的显式保存值保留，用户点击外观中的“默认蓝”才更换为新默认。图表分类色、Provider 色与历史证据未批量替换。

## 可复现验证

在根目录安装仓库声明版本的依赖后执行：

```bash
pnpm --filter slide-frontend typecheck
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm lint
pnpm --filter slide-frontend test
pnpm --filter slide-frontend build
pnpm --filter slide-api exec vitest run src/user-preference-service.test.ts
MAX187_ISOLATED=1 pnpm --filter slide-frontend exec playwright test --config playwright.max187.config.ts
```

浏览器验收启动一次性 MySQL 8.4、生产 Fastify/JWT/WebSocket 服务和 Vite（3187 / 29887 / 5187），测试自行清理进程与容器。正常页面和偏好读写均经过真实服务；仅数据库业务行、无偏好账号和随机登录密码为隔离测试夹具，无业务 HTTP mock。模型 Provider 仅在此一次性数据库中禁用，未触及共享环境。

浏览器覆盖：无偏好默认、浅/暗主题、1440×900 与 390×900、活动导航 600 与普通链接 400 的颜色、页内活动标签、主按钮对比度、hover/focus、保留显式旧蓝、点击默认预设、跨标签页、持久化刷新、全新浏览器真实登录、自定义 `#14b8a6` 和显式按钮 palette 的保留。

## 结果与证据边界

- 前端全量：129 个文件、1,132 项测试通过；后端偏好 focused：5 项通过。
- 后端扩展全量首次为 349 文件 / 3,351 项通过，另 8 文件在独立 MySQL 初始化/迁移/清理时报连接关闭（745 项跳过，1 项失败）；这 8 文件在相同实现、单 worker 下 119 项全部恢复通过。未修改这些测试或业务代码来绕过失败。
- 前后端 typecheck、契约检查、qualification matrix 37/37、build/CSP 通过；lint 0 errors（254 个仓库既有 warnings）。
- 最终浏览器验收：3/3 通过，覆盖 1440×900 / 390×900，均无整页水平溢出；隔离进程退出 0，容器已清理。
- 实页默认浅色蓝为 `rgb(38,95,153)`，即精确的 8 位 `#265F99`。默认蓝底白字主要按钮对比度约 6.61:1；浅色活动标签在实际合成浅背景上约 4.77:1；暗色文字 `rgb(125,159,194)`，活动标签约 6.33:1。
- 浏览器最终结果和逐项测量见随任务附件提供的 `measurements.json`、截图及 `cleanup.json`；以文件中记录的实现 commit 为准。
- 浏览器验收数据库中 `agent_runs=0`，无新增产品模型调用；本任务不修改共享 Provider、binding、采集或部署配置。

## 集成接续

PR #196 / MAX-186 尚未合并，与本题的 `tokens.css`、`layout.css`、`app-settings.ts`、`btn-palette.ts`、`appearance-settings.ts`、`dashboard-styles.ts` 等有交集。Chief 集成时应保留本题的新默认和避免二次压暗规则，同时保留 MAX-186 的共享组件及交互成果；不能通过整文件覆盖解决冲突。其旧默认 palette `#1870c9` 不能替换本题默认 `#265F99`。

当前共享 5173 属于 MAX-186 的验收运行态，并非本题实现。本次没有切换该运行态，也没有取得或代用用户浏览器会话。原共享验收账号由旧“默认蓝”改选新默认、MAX-186 页面“查看进展／发起调查”的最终同色复核，应由 Chief 在审定集成到该运行态后沿用既有接续完成。本题的隔离账号已通过真实外观 UI 执行旧蓝→新默认，不能据此宣称共享账号已更新。

PR 创建、完整 CI gate、实际合并 SHA 和共享运行态验收分别记录；本地通过不替代完整 CI 或共享环境接续。
