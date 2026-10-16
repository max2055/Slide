# MAX-186：整合 MAX-187 默认文字蓝

## 版本与冲突决定

原 PR196 head `7c0f214d00932f616aff518668aa6cba31af5395`，定向合入 MAX-187 实际 merge `37f60ce60d3b0825eecfa6eb888e1c8a86669e66`。整合提交 `892adc2a` 的两个 parent 正是上述提交；后续 `a61da6c1`、`8f115642` 仅完善受影响浏览器验收。受测最终候选 `8f115642593f62f980cbebacf9dfa01b0cf05875`，frontend tree `b4ad839f90c1ea08eb2365b0ede60e59282183bd`；后续交付文档不改变产品源码。

三处冲突逐段处理：

- `btn-palette.ts` 默认主按钮背景/边框采用 MAX-187 的 `DEFAULT_ACCENT_COLOR`，保留 MAX-186 的 `primaryFill()`、白字及显式 palette 优先级。
- `appearance-settings.ts` 采用新默认预设；保留 MAX-186 的场景说明、真实尺寸/刷新预览、白字对比度处理，不恢复局部预览尺寸覆盖。
- `dashboard-styles.ts` 保留 MAX-186 的布局及共享按钮继承，不恢复 MAX-187 基于旧总览的局部 ghost/secondary 覆盖；`--overview-action` 继续消费 `--accent-text`。

自动合并的 `tokens.css` 中残留旧 `--accent-solid: #1870c9`，已定向修为 `#265f99`，保证初始化前默认也一致。保留 MAX-187 的默认浅色文字不二次混黑、暗色混白、自定义强调色文字原规则及后端新偏好默认。自定义填充按钮延续 MAX-186 已审白字/加深背景策略，其他 accent 填充表面保留 MAX-187 自动黑白前景；显式 palette 不被默认选项覆盖。

## 验证结果与复现

- 前端全量 130 文件 / 1141 项通过；最终新增默认 `primaryFill` 不二次压暗断言另有 2 项 focused 通过。前后端 typecheck、build/CSP、contracts:check 通过；根 lint 254 个既有 warning、0 error。
- 后端偏好 focused 5 项通过。前轮未变首审/R2/R3/R4/R5 的业务、空/失败/撤权与布局矩阵复用，不把历史蓝色截图当新默认颜色证据。
- 组件 Chromium 21 项通过（button-consistency + form-fields）：普通/Shadow DOM 同源、明暗、三密度、1440/390、自定义 palette/圆角、焦点/Enter/禁用/加载、减少动画/强制色。
- 正式 Fastify + 一次性 MySQL + 真密码登录/JWT 颜色测试 3 项通过：无偏好默认、600/400 字重同色、默认/暗色按钮、旧蓝→默认 UI 操作、跨标签页、刷新持久化、新浏览器登录、自定义色及显式 palette。
- 另一正式隔离服务刷新测试 1 项通过：七页面 × 六主题/密度/视口配置共 42 组，默认使用新蓝，刷新计算样式一致、透明底/边框、实际点击与键盘焦点保持。

实测默认浅色侧栏 600 与普通证据链接 400 均为 `rgb(38,95,153)`；主按钮蓝底白字对比度 `6.605:1`，浅色活动标签 `4.769:1`，暗色活动标签 `6.334:1`。自定义 `#14b8a6` 白字主按钮填充为 `rgb(14,131,118)`，对比度 `4.639:1`；显式 `#123456` palette 在选择默认与重载后仍保留。

正文沿用的“查看进展/发起调查”称呼，在当前 PR196 实际页面对应证据入口与“创建手动调查”。本轮测量真实的“查看证据”入口、纳管主按钮及创建调查按钮，并检查打开表单、Esc 和焦点恢复；不新增或改名业务动作，不提交调查或启动模型。1440/390 明暗截图无整页横向溢出，已人工查看代表总览原图及暗色窄屏调查页。

初次新增焦点断言未切换键盘模式，第二次未移出鼠标导致采到主按钮 hover 色。均定位为验收脚本问题，只修正实际键盘步骤和非悬停采样；初次日志保留，最终全部通过。未改产品交互来迎合断言。

复现：

```bash
pnpm --filter slide-frontend test
pnpm --filter slide-frontend typecheck
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm lint
pnpm --filter slide-api exec vitest run src/user-preference-service.test.ts
pnpm --filter slide-frontend exec playwright test --config playwright.audit.config.ts button-consistency.spec.ts form-fields.spec.ts
MAX187_ISOLATED=1 MAX187_OUTPUT_DIR=/Users/max/Coding/40-Slide/outputs/MAX-186/color-integration/service pnpm --filter slide-frontend exec playwright test --config playwright.max187.config.ts
# 任务自有一次性 MySQL 33186 就绪后；不得指向共享数据库
MAX186_ISOLATED_MYSQL=1 MAX186_OUTPUT_DIR=/Users/max/Coding/40-Slide/outputs/MAX-186/color-integration/refresh-service pnpm --filter slide-frontend exec playwright test --config playwright.max186.config.ts -g 'button consistency'
```

证据为独立库中持久化合成资源，无业务 HTTP mock；全部临时 API/Vite 进程已退出，两次最终容器已移除，刷新测试 schema 核无残留。颜色库 `agent_runs=0`、产品模型新增 0，原批次账本不重置。本轮没有共享账号、Provider、binding、采集或 SSH 操作。

## 共享 5173 更新预览（尚未执行）

2026-10-16 本轮只读核验：前端 PID `66229`，监听 5173；cwd `/Users/max/Coding/40-Slide-max186-acceptance/frontend`，命令 `/opt/homebrew/bin/node .../frontend/node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173 --strictPort`。launchd `gui/501/com.slide.dev.frontend`，plist 与 stdout/stderr 均位于既有 `outputs/MAX-186/acceptance-runtime/`，日志 `frontend.log`。该树干净，HEAD `7c0f214d`，frontend tree `4cf8949780ec6a137be093b44b7d582fbeacba2c`。

后端当前 PID `77645`，3000，cwd `/Users/max/Coding/40-Slide/apps/db-ops-api`，tsx `server.ts`；stdout/stderr `/Users/max/Coding/40-Slide/.runtime/backend-main.log`，仓库 main `47f8f4f1`。这是进程 cwd 中的仓库身份，不将它冒充运行时重新编译证明。后端 PID 与前轮记录不同，本轮未启动/停止或改动它。

拟更新对象仅上述前端工作树和 launchd 服务：Chief 核定确切新 head 及既有授权后，操作前再次检查 PID/端口/cwd/命令/log/脏改；保留日志与原 plist，工作树干净才切换新 head；任何新增脏改先保护而不覆盖。沿用 3000/28888 代理，不重启后端。只做未登录只读 smoke 并阻断非 GET/HEAD 共享请求；真实默认选项及业务验收由 Max 本人完成。

最小回退为停止该确切 launchd 前端、干净验收树切回 `7c0f214d00932f616aff518668aa6cba31af5395`、用原 plist 恢复；此前 `rollback-refresh-reference.sh` 回到更早 `f79a793f`，不能冒充本轮回退到 7c0。现有历史回退入口保留。本轮未切共享服务，新颜色尚未在用户原 5173 提供。

PR196 保持 draft，交 Chief 定向复审及本 head CI 接续；不自动合并/done，不把隔离测试当作 Max 已完成共享业务验收。
