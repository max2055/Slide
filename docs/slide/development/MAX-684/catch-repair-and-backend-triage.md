# MAX-684 MF-C1 修复与 backend 首错分析

MF-C1 本地回归已闭环；backend 监督门禁仍未闭环，整体验收仍 BLOCKED。原任务保持 in_progress、PR #1010 保持 draft，不合并、部署或关闭 #1009。完整提交 head 和推送后的单次 CI 快照由本轮交付评论绑定。

## 版本与最小改动

main base `451ab8c9969f18d94f17392a74301294de82b5e1`，实施起点 `9204f0ffc3cedc804c94bd1fb462fa38033e24b3`；继续原 `agent/15-backenddev-01/max-684`。产品仅在 cron-routes.ts 的列表、jobs 创建、scripts 创建三个 catch 增加 return，关联发送与异步 handler 完成。状态、错误脱敏、权限、scope/owner、业务参数、其他 CRUD、全局 hook 和监督源码均未修改。AGENTS.md 的原有运行规则差异不提交。

## MF-C1 同配置真实 TCP 红绿

在原回归文件增加三个存储异常用例，真实 loopback TCP、生产 registerChatRoutes 异步 hook、registerHttpSecurity 和原异步 onSend；身份与服务存储失败受控，不冒充真实数据库故障注入。

旧候选路由与新增测试先执行：6 项中 3 通过、3 失败，退出 1。三个失败均为预期 503 下 body 长度 0；在非空断言前验证了每个目标方法仅调用一次、其他两个方法零调用、reload/trigger/Chat 准入及发送均零调用。创建入参包含必要 task_description；不存在只到 400 的伪复现。无重试，无第二次 POST。

仅修改上述三个 return 后，相同测试文件全部通过；相关七文件 91/91 通过、退出 0。三个异常均为 503、非空 application/json、精确 `{"error":"INTERNAL_ERROR"}`。原成功、scope/权限拒绝和执行/runId/requestKey 矩阵保留；requestKey 恢复零 trigger。错误回执不证明存储未写入，客户端不得据此重发未知 POST。

执行入口为 pnpm --filter slide-api exec vitest run，选中 cron-script-lifecycle、cron-run-lifecycle、cron-security、cron-actor-scope、cron-job-service、cron-run-store、cron-timeout-config 七文件；本次实际通过显式 Node 直接执行同一 vitest.mjs，准确 argv 见附件命令记录。后端 typecheck、pnpm ci:source-policy、git diff --check 均退出 0。公开契约未变。macOS ARM64、Node24.22.1/pnpm11.19.0/Vitest4.1.8；沿用既有任务副本的依赖链接，未冒称新 frozen install。被测副本的 4782 个既有受控文件与本轮工作文件逐字节一致（AGENTS 运行规则除外），改动的源码/测试另有 SHA256 绑定。

## 当前 backend 首错与时间线

复用 Reviewer 认证取得的原始包，不重新读取旧 CI 状态、不手动重跑 CI：

- [run44154655935](https://github.com/max2055/Slide/actions/runs/44154655935)，attempt1，[backend/job134292183067](https://github.com/max2055/Slide/actions/runs/44154655935/job/134292183067)。实际 checkout `d35591cb0d6976f974207d6a5a266b4aa86cc05b`，parents 为上述 main base、旧候选 head，tree `61ecb3aac083e061a5a193849fca77f4418a53b4` 与旧 head 相同。
- native 入口 142/143 通过、1 失败、退出 1；监督 harness status=1，mjs timedOut=false、signal=null，collectionErrors 为空。目标 serve-e2e.sh 的 wait=0 与上述 harness 失败是两个结果。
- [artifact14359154832](https://github.com/max2055/Slide/actions/runs/44154655935/artifacts/14359154832) 实际上传已由 Reviewer 核实。本轮从认证下载的 Reviewer 包再次取出原 artifact：57,400 字节，SHA256 `fdfe8a612ecf33dfeb7e94cf09268d475208ebb8f212dce63b9df575f24445d1`，CRC 通过；120 项 manifest 的独立核验归属 Reviewer。本次上传不再列为未验证，也不证明 watchdog 已修复。
- Reviewer 入口附件 170,986 字节，SHA256 `e5a8463396d7c0089a9aeae94c1dc2504fcec1ae9d1099dadc167bca91110aa0`，本轮认证 CLI 下载后核对一致。报告提交 `97fd25ede211c49abb0e74e62048dd8ad30e0e8a` 尚未推送，不声称已进入本 PR。

完整 diagnostics-invalidated/bash.trace 为 67,611 字节，bytesSeen=bytesRetained、truncated=false、error=null。下列时刻均为 2026-11-17 UTC：

| 时刻 | 证据与含义 |
| --- | --- |
| 19:06:17.691473 | identities 保存 supervisor5372、tracker5391、API5395/child5396、Vite5423/child5425 的 pid/ppid/start 身份 |
| 场景 elapsed=0 | signal-sent 记录对5372发送 INT 成功；记录在撤销诊断文件、创建同名目录之前，缺精确发送时间和系统调用级接收记录 |
| 19:06:18.031043 至 19:06:29.032284 | 持续经过 check_stop/child_finished/record_service_tree；没有停止标记观测，未进入 cleanup。不是目标已退出后 harness 等管道 EOF |
| 19:06:29.068261 | 12秒 watchdog 快照：原 supervisor 在 do_wait，tracker 在 poll，四个服务/子进程在 sleep，均与原 start 身份相符；随后 watchdog 发送 TERM |
| 19:06:29.235987 | 首次 signal_observed，位于 top399；该事件仅表示原赋值 trap 生效后的首个 DEBUG 边界，不是精确 trap 入口，也不能将它归属于最初 INT |
| 19:06:29.936156 | check_stop 后进入 cleanup；stop_our_processes 开始 |
| 19:06:30.649343 | 首轮 record_service_tree 结束，开始 TERM 已记录服务树 |
| 19:06:32.350362 | cleanup 最后边界；harness wait 记录目标退出0；场景约15秒，因 watchdog-fired 文件存在判 FAIL |

**有证据的分类：本次直接失败是监督 INT 停止请求未在原预算内转成可观察的停止标记，触发 watchdog 的业务断言；不是目标非零退出、120秒整体超时、清理阶段先卡住或证据采集失败。** 失败位于最初 INT 发送成功记录与 trap 赋值生效之间，具体是发送边界、Bash 信号处理还是观测介入尚未确定。不能把发送成功等同于 handler 已执行。监督源码未变；Cron 因果及引入归属未定，不认作已确认产品回归或豁免门禁。

辅助诊断采用独占、无网络 Linux ARM64 容器（Ubuntu24.04/Bash5.2.21/Node24.22.2/Python3.12.3），只运行小模型，不重放业务请求或完整 CI。同步信号/DEBUG、阻塞 printf、read/command-substitution 边界以及原树遍历函数的有/无 trace 固定时点矩阵未建立同一失败的确定复现。早期模型存在引号初始化错误、信号晚于子进程退出的无效样本和诊断超时，均不计门禁通过或根因证据；修正后12项树遍历诊断只证明这些受控时点能观察到 INT，不覆盖实际 CI。所有容器前台退出并自动移除，无遗留服务。没有据此修改监督代码、放宽12/120秒预算、削弱断言、手工触发 CI 或循环碰绿。

具体子根因与修复仍待定。下一步须在准确监督脚本和原断言下取得最初 INT 的精确发送/接收及执行边界关联，区分赋值未执行和观测干扰后再修复；当前 trace 不足以支持选择其中一种实现修复。

## 复用与剩余项

原五阶段绑定、Reviewer 26项、作者88项、真实 MySQL/JWT 和原 managed 浏览器成功路径证据按原核验边界保留；本次91项补足三个 catch，并不替代真实持久化或浏览器。MF-T1/T2、MF-I1/I2/I3 关闭与未失效 TLS 继续复用，不机械重跑九文件/TLS/浏览器。历史 signal/watchdog、401/fatal 因果及观测限制保留，不恢复人工听读。

未完成：监督 INT 子根因与修复、当前候选全部选中上游及 release-artifact/ci-gate 完整成功、Chief 安排原 Reviewer 增量复核。本轮完成 MF-C1 和首错定位这一部分，整体仍 BLOCKED。推送后只取一次现成候选 CI 快照；未完成如实待定，不等待、轮询、手动重跑或新增订阅。
