# MAX-684 登录响应生命周期修复

base：451ab8c9969f18d94f17392a74301294de82b5e1。
旧head：eb1fc43c6129b557c61b8aa73b5fb6af1976ef0e。
新head：本报告所在提交，完整SHA见任务交付评论。

产品差异仅server.ts登录成功、通用500错误分支返回reply；其余400、401、503路径已经返回reply。认证、响应内容/状态、恢复链、fatal handler未改。保留原AGENTS.md修改，不纳入提交。

## 对照与入口验证

新增login-lifecycle.test.ts读取实际server.ts登录注册片段，使用TypeScript转换后注册真实Fastify；依赖为显式受控替身，使用真实socket及相同两个异步序列化hook。覆盖成功、通用错误、依赖不可用、无用户、密码错误、缺字段、非法body七条路径。此测试不冒充完整生产启动。
修复前5 PASS/2 FAIL（成功与500分支空JSON），修复后7 PASS；与原相关HTTP、健康、认证、聊天路由合计59 PASS。

实际独占MySQL8.4（max684-http-mysql，动态60646）与受控模型端点：
- server-composition.mysql、chat-authorization.mysql、chat-permission-contract.mysql完整三文件65 PASS，退出0。
- 托管Edge浏览器登录完整入口1 PASS，退出0，53.3s：REST200、登录门消失、导航可见。SLIDE_TEST_PROCESS_EVIDENCE=1使用既有白名单诊断，未观察到FATAL_UNHANDLED_REJECTION；不能由本次登录通过推断历史fatal根因解决。
- startup完整第一次退出1。完成慢依赖续租/双进程单后台、leader退出保持standby/trigger503、过期lease拒绝、真实恢复保全场景；第198行初始化失败场景之后数据库连接丢失。Docker事件确认该任务容器slide-w07-57093发生oom，与PROTOCOL_CONNECTION_LOST相符，分类为测试资源问题，非登录空响应回归。未放宽锁/总超时/断言。

安全相关HTTP/fatal/权限边界四文件67 PASS。后端typecheck、contracts、source-policy、diff检查退出0。
Linux Edge/TLS继续使用上一轮明确的环境缺口结论：现有隔离环境缺Edge/certutil、宿主Docker aarch64；未重复运行缺依赖环境，未降低TLS校验或修改系统信任。需要具备仓库CI依赖的兼容Linux隔离执行环境。旧execution139 PASS/1 SKIP与bounded未复现仍为阶段历史证据，不替代新候选完整gate。

## 可复现命令与产物

Node24.22.1，pnpm11.19.0（显式verifyDepsBeforeRun=false复用现有安装），macOS arm64。受控日志目录outputs/max684-login-repair，不附原始输出/凭证。
从根目录执行：
- pnpm --filter slide-api exec vitest run src/login-lifecycle.test.ts src/http-lifecycle.test.ts src/health-routes.test.ts src/auth/dependency-recovery.test.ts src/auth/chat-authorization.test.ts src/auth/chat-routes.test.ts
- OPERATIONS_TEST_MYSQL_PORT=60646 MAX684_ACCEPTANCE=1 MAX684_MYSQL_PORT=60646 MAX683_CHAT_MYSQL_PORT=60646 pnpm --filter slide-api exec vitest run src/operations/server-composition.mysql.test.ts src/auth/chat-authorization.mysql.test.ts src/auth/chat-permission-contract.mysql.test.ts
- pnpm --filter slide-api exec tsx ../../tests/qualification/startup-readiness.test.ts
- 托管浏览器沿用http-lifecycle-repair.md环境，端口60646，--grep 'qualification login authenticates'；无共享生产Provider/付费调用。

日志before.log、after.log、integration.log、browser.log、startup.log、startup-isolated.log、security.log、typecheck.log、contracts.log、oom-events.txt。整体仍有Linux TLS及完整startup门禁待闭环，保留draft；不合并、不部署、不关闭#1009，稳定后由Chief交原Reviewer一次复核。

单独重跑startup-isolated.log退出1：第157行登录期望200实际401；此前仅完成慢依赖与双进程场景。该次无对应OOM事件。夹具在第113行显式bootstrap管理员、登录使用同一合成密码；尚未关联到用户查找、密码校验、限流或其他认证分支，不能将其归为本次reply修复或沿用首次OOM解释。未修改认证策略/夹具断言，未再次循环重跑。下一步最小诊断是关联这次401的固定请求标识和拒绝分支，仅采白名单状态/类别，不记录密码或任意响应正文；确认原因后决定是否另有产品或夹具差异。完整startup仍未通过，两次运行结果分别保留，不能拼接为通过。
