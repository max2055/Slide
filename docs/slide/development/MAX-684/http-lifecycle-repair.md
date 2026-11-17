# MAX-684 HTTP 生命周期兼容修复

base：451ab8c9969f18d94f17392a74301294de82b5e1。
旧head：754ffadcc9e005306cea563303ab13dfe701f641。新head见本报告所在提交及任务评论。

产品差异仅为 auth-middleware 四个拒绝分支 await reply，以及 health-routes liveness 返回 reply。授权判定、状态码、响应字段、恢复链、锁、超时和 fatal handler 不变。额外诊断仅统计引擎 script 映射失败类别，不输出原始URL/帧，不改变白名单。

## 实际验证

环境 macOS arm64、Node24.22.1、现有依赖；独占 mysql:8.4 容器 max684-http-mysql，动态端口58246，空测试口令。所有日志在受控 outputs/max684-diagnostic-followup，下述日志不作为脱敏附件。

- http-before.log：新增真实socket回归5 FAIL；四个拒绝均误入业务handler，health JSON为空。修复后同配置5 PASS。
- http-after.log：上述回归、health-routes、auth/dependency-recovery、auth/chat-authorization、auth/chat-routes 共52 PASS。
- http-integration.log：OPERATIONS_TEST_MYSQL_PORT、MAX684_MYSQL_PORT、MAX683_CHAT_MYSQL_PORT显式58246，MAX684_ACCEPTANCE=1；server-composition、chat-authorization.mysql、chat-permission-contract.mysql完整3文件65 PASS，退出0。真实SQL/JWT/HTTP/WS、受控模型端点，未调用付费Provider。
- http-base-composition.log：git archive导出的实际base源码运行其原server-composition完整入口1 PASS，退出0。未切换工作分支。证明base该入口通过，不足以确定具体引入提交。
- http-startup.log：完整startup-readiness入口退出1。已通过原liveness阻塞并完成“慢依赖>35s持续续租、双API仅一个后台引擎”；随后standby登录HTTP200，JSON解码为空（源码第157行）。原锁与总超时不变，不能宣称完整startup通过。
- http-edge-login3.log：托管前端及隔离受控Provider，macOS Edge真实登录入口1 FAIL；REST200断言通过，登录门仍可见。此次未观察到FATAL_UNHANDLED_REJECTION，不能据此宣称原fatal修复。API映射观察仅非file URL拒绝，各1帧；不是原6帧fatal，不能归因。旧fatal仍待可重现的实际API事件。前两次启动失败为本地pnpm依赖自动检查/入口准备问题，最终使用11.19.0并显式verifyDepsBeforeRun=false复用现有依赖，无仓库配置修改。
- Linux环境检查：现有max683-supervisor-env:local容器仅有node，缺Edge及certutil。宿主Docker为aarch64；未自行新增系统适配/信任更改。Linux Edge/TLS需具备仓库CI依赖的兼容Linux执行环境，仍阻塞。
- 后端tsc --noEmit、contracts生成器--check、source-policy、diff --check退出0。diagnostics测试3 PASS，保持fatal退出1和敏感数据不输出。

命令使用仓库既有vitest.mjs、tsx和tsc入口（本工作树依赖指向现有安装）。execution旧139 PASS/1 SKIP与bounded未复现保留为旧阶段证据，未重新运行，不冒充新候选全gate。无完整CI/独立复核结论，仍非稳定可合并候选。

## 剩余最小产品候选

startup直接观察到登录HTTP200/空JSON；server.ts登录成功分支reply.send后不返回，与已对照证明的HTTP生命周期风险吻合，但尚未对该登录分支做修改对照。建议下一步仅在登录成功/错误发送分支返回reply，先做同配置对照再复跑startup和Edge；此处仅交证据，不扩大本次已释放五处分支修复。不能推断它会修复fatal。

保留draft，不合并、不部署、不关闭#1009；由原Reviewer在稳定候选后唯一复核。
