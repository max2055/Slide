# MAX-172 登录提示与校验验收

基于已审定 main `61cdb2917cef17115e67591f876009361b11696d`，分支 `codex/MAX-172-login`。本次仅修改登录视图及 zh-CN/en 的 login keys，配套测试和本文；认证、权限、密码策略、布局和外观组件未修改。无产品模型调用、共享部署或在线采集。

## 基线复现与修复

在该 main 的当前工作树启动独立 Vite，由 Chromium 实际点击空登录，记录到：密码 placeholder 为“可选”，操作为“连接”，表单错误为“请输入用户名和密码”。源码还将失败地址写死为 localhost:3000，并对密码执行 trim。

修复后：密码提示为“请输入密码（必填）”/“Enter password (required)”，操作为“登录”/“Log in”；原生 form 统一处理按钮和 Enter 提交。缺用户名或密码时本地阻止请求；仅裁剪用户名，密码按原值发送，与后端非空校验一致。提交时显示双语进度并防止重入，失败后可重试。网络、服务器和非 JSON 响应错误展示实际同源登录请求 URL。保留密码显示按钮、输入值和按压状态，并翻译显示/隐藏的可访问名称。

## 验证结果

| 验证 | 当前候选结果 |
| --- | --- |
| focused：login-gate、login-labels、appearance-settings 单测 | 19/19 |
| 更新既有 chat-notices 网络错误断言后 focused 回归 | 14/14 |
| 最终前端完整单测 | 110 文件、938/938 |
| 前端 typecheck | 通过 |
| 前端 build / CSP | 通过；2 个生产脚本 CSP 检查通过 |
| 全仓 lint | 0 errors，263 个已有 warnings；本次变更 TS 文件定向 lint 为 0 warnings / 0 errors |
| 既有 appearance-settings 浏览器专项 | 当前工作树独立 Vite，14/14，受控 API/WS |
| 新增登录浏览器专项 | 15/15，真实后端 3 场景 + 受控异常矩阵 12 场景 |

首次全量测试发现旧 chat-notices 测试写死中文错误，已改为按当前语言及实际请求地址断言，最终完整单测已通过。测试环境曾因未配置模型和测试数据格式失败，现已改用独立本地拒绝调用端点；最终运行后端配置、主题初始化和异步请求计数均已验证。

### 真实业务链路（未截获正常 API/WS）

使用本任务独立 MySQL 8.4 容器、随机 schema 和随机临时密码/JWT/加密密钥，启动实际 `apps/db-ops-api/server.ts` 与当前工作树 Vite。测试完成后关闭服务并删除临时 schema/工作目录；资源夹具关闭采集，未连接外部资源。模型仅配置到本地拒绝调用端点，afterAll 断言请求数为 0。

- 错误密码：实际 POST `/api/auth/login` 返回 401，表单显示凭据错误。
- 正确密码（含首尾空格）：实际 bcrypt 验证、HTTP/JWT、权限加载、WS 接入、服务器页面展示 SQL 夹具；刷新仍保持登录。
- 成功为空：删除当前隔离库中的服务器夹具，刷新看到“暂无服务器”。
- 无权限：零角色用户正常密码登录，实际 permissions 为 `[]`，服务器导航隐藏，访问 `/api/servers` 返回 403。
- 失效：SQL 增加账号 session_version，刷新后 HTTP/WS 实时鉴权回到登录页，密码输入为空且显示必填提示。
- 语言集成：真实登录后进入外观，确认数据库选项译名，保存路由 ID `servers`，切换英文并刷新，英文和路由 ID 保持；偏好 API 为真实服务。

### 受控状态与键盘

1280×900、768×900、390×900 × light/dark × zh-CN/en 共 12 场景。仅登录接口被控制为延迟 503 或 200 非 JSON 网关响应，正常认证证据不来自这些拦截。

每场景验证：空表单 Enter 不发请求；Tab 顺序为用户名→密码→显示按钮→登录；Space 显示/隐藏密码并保留原值；登录按钮 Enter 触发请求；加载态禁用按钮，再按 Enter 仍只有一个请求；失败展示当前 origin 的 `/api/auth/login`，按钮恢复；非 JSON 结果留在登录页。全部截图无水平溢出，已目视复核窄屏英文深色错误、桌面中文浅色加载和会话失效页。

## 重现命令与证据

```sh
pnpm --filter slide-frontend exec vitest run src/app/ui/views/login-gate.test.ts src/app/i18n/locales/login-labels.test.ts src/app/ui/views/appearance-settings.test.ts
pnpm --filter slide-frontend test
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm lint
# T06_TEST_MYSQL_PORT 必须指向执行者自己创建的隔离 MySQL 8.4。
T06_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-frontend exec playwright test --config playwright.login.config.ts
# 单独在当前工作树启动 Vite，使用实际 URL，不能依赖默认端口上的其他工作树。
PLAYWRIGHT_BASE_URL=<owned-vite-url> pnpm --filter slide-frontend exec playwright test --config playwright.config.ts appearance-settings.spec.ts --workers 1
```

截图以任务评论附件 ZIP 交付，`login/` 包含 24 张矩阵加载/失败图和 6 张真实业务图；`appearance/` 为既有专项截图。代表文件：`controlled-failure-en-dark-390.png`、`controlled-loading-zh-CN-light-1280.png`、`real-session-expired.png`、`real-login-data.png`、`real-login-empty.png`、`real-no-permissions.png`、`real-appearance-reload.png`。不交付含临时认证数据的浏览器 trace。

## 边界与待审项

- PR/current head、CI 状态及 checks wakeup 以最终任务评论与平台回读为准；本地通过不表示已合并或共享线上通过。
- 零权限用户直达服务器页时，既有页面显示通用加载失败 toast 和空列表，添加按钮仍可见；实际 API 为 403。本题只验证登录不越权，不修改该资源页已有的权限/空态表达，交由父任务记录后续范围。
- 未测浏览器性能指标或屏幕阅读器，不以截图推断这些指标。未发起模型推理，产品测试预算没有扣减项。
