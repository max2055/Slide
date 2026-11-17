# MAX-684 startup 认证关联诊断

base：451ab8c9969f18d94f17392a74301294de82b5e1。
旧head：aad7c61d434a069e0e019b3e82985c0f68e16c8b。
新head为本报告所在提交，完整SHA见任务交付评论。产品未改；AGENTS.md既有修改未提交。

测试差异：独占MySQL上限从512MiB提高到1GiB（此前Docker已确认OOM），保留32MiB缓冲池、锁、全部等待上限及断言。登录固定请求标识startup-login；预加载器只对白名单请求包装实际账号查询和密码校验方法，保留原返回/异常；观测仅布尔结果、固定阶段、状态码，数据库关联仅输出当前数据库及任务principal是否匹配。不输出账号、哈希、密码、SQL结果或原始异常帧。独立连接分别在bootstrap后、登录前查询账号并比较合成密码，仅记录visible/active/passwordMatches。

本次只运行一次完整startup，退出0，全部原断言通过：
- 慢依赖>35s持续续租；双API只有一个后台引擎。
- standby真实登录成功，leader退出保持standby、trigger503、不自动接管。
- 过期lease拒绝续租；保留有效owner与旧日志、过期owner转unknown。
- 缺Memory workspace与部分初始化失败显式退出，释放lease。
- workflow权限拒绝时readiness503，恢复权限后200。
- 数据库暂停时readiness503/liveness200并排空；恢复后同进程新引擎generation。
- Compose渲染及真实测试容器收到五项配置。

两次独立账号观察均visible=true、active=true、passwordMatches=true。本次未复现旧401，不能归因为密码错误、bootstrap丢失或限流，亦不能宣称其根因已解决。成功入口没有触发测试的失败输出分支，API内部方法的关联日志保留在子进程内存、未导出；因此没有独立持久化的API数据库关联/校验分支证据，不将完整PASS扩大为该观测已闭环。若401再次出现，失败路径会携带固定请求的分支观测，可据此归因，不提出猜测产品修复。

旧512MiB OOM、另一轮无OOM的401分别保留在login-lifecycle-repair.md，不用新PASS覆盖历史失败。此次提高内存后完整通过支持测试资源配置调整，但不证明旧401由内存导致。未循环重跑。

环境macOS arm64、Node24.22.1、pnpm11.19.0，任务独占MySQL8.4动态端口；虚假测试凭据、受控Provider，无付费调用。完整命令：
pnpm --filter slide-api exec tsx ../../tests/qualification/startup-readiness.test.ts
后台依赖采用现有安装，pnpm显式verifyDepsBeforeRun=false。证据为受控outputs/max684-startup-auth/startup.log；原日志不作为脱敏附件。测试finally已清理所有任务API与容器，未触碰生产数据。
诊断回归3 PASS；后端typecheck、source-policy、diff检查通过。第一次typecheck因新工作树缺前端依赖链接失败，补齐后通过，无产品修改。

Linux现有max683-supervisor-env:local为arm64，检查无microsoft-edge/certutil。缺少具备仓库CI浏览器/NSS依赖的兼容Linux隔离环境；未运行TLS场景、未修改系统信任/降低校验，仍阻塞。既有托管Edge登录1 PASS、真实权限65 PASS及相关路由/安全检查沿用上一候选证据（生产代码未变）；fatal仅保留未复现结论。完整CI与独立复核均未宣称通过，稳定候选后由Chief交原Reviewer一次复核。不合并、不部署、不关闭#1009，保留draft。
