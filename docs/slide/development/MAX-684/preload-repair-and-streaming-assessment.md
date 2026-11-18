# MAX-684：诊断 preload 断链修复与 streaming 已有证据定位

## 对象与边界

- 审查基线 main：`451ab8c9969f18d94f17392a74301294de82b5e1`。
- 本轮父提交：`4f8c7512e1d929e3b9f7a9857dea01de6f55f57b`；修复提交为包含本文的提交。
- 原 [PR #1010](https://github.com/max2055/Slide/pull/1010) 远端仍是上述父提交，保持 draft。本轮不推送、不触发/重跑 CI、不自行召回复核。
- 只修改实际服务装配测试及本说明，不改产品、权限契约、streaming 性能代码、断言或门禁。

## 确认回归与最小修复

[CI 44207606228/1 的分片8](https://github.com/max2055/Slide/actions/runs/44207606228/job/134477584824) 在 `server-composition.mysql.test.ts` 的 API-only 初始化阶段失败：测试子进程 preload 已被收敛排除的 `scripts/diagnostics/request-evidence.mjs`，产生 `ERR_MODULE_NOT_FOUND`，未到达原 `WORKER_LEASE_UNAVAILABLE` 断言和业务检查。属于收敛引入的夹具断链。

回读删除前模块：它订阅 Fastify diagnostics channel，包装 handler/hook，输出限定请求的观测事件；不提供用户、权限、lease、数据库、路由或初始化装配能力。原业务断言不依赖这些输出，因此不恢复该工具，也不新增替代 preload。

`apps/db-ops-api/src/operations/server-composition.mysql.test.ts` 恢复为上述 main 的原字节：删除 preload/import/开关、附随请求头、health/lease 观测查询和额外观测文件，保留原进程启动方式、原日志落盘与清理、全部16处 expect 调用。匿名401检查回到原请求形式，API-only `WORKER_LEASE_UNAVAILABLE`、200/400/401/403/404矩阵、实时权限变化、实例作用域、保留lease owner与零 action_executions 全部保留。相对父提交为 +4/-30，不重构其他代码。

同根因检查覆盖 `7ce6621aa2bebcada300ddde91d099373722eb77`→父提交删除的全部14个非文档文件名，在代码、脚本、隐藏CI配置中做固定字符串引用搜索（排除 `.git`、依赖目录和文档）。修复后无匹配；此前唯一执行引用即本测试。此为静态引用核查，不扩称能识别任意动态拼接路径。

## 本轮真实验证

命令（仓库根目录；端口和密码由一次性启动器显式注入，不依赖私人配置或共享库）：

```sh
pnpm --filter slide-api exec vitest run src/operations/server-composition.mysql.test.ts --maxWorkers=1
pnpm --filter slide-api typecheck
pnpm ci:source-policy
git diff --check
```

真实测试使用 `OPERATIONS_TEST_MYSQL_PORT` / `OPERATIONS_TEST_MYSQL_PASSWORD`，任务独占 MySQL 8.4 arm64 容器、loopback 随机端口50769和随机schema；密码只存在启动器内存/测试环境中。未读取共享凭据、启停共享服务或调用模型。

- **真实测试 1/1 PASS、退出0**，总7.38s（业务6.69s）；原 `WORKER_LEASE_UNAVAILABLE` 断言及其后全部业务expect实际到达并通过。原服务日志包含lease标记，不含 `ERR_MODULE_NOT_FOUND`。不是只验证模块导入或健康探针。
- 完成 fixture.close 后独占容器内 `t11_feedback_%` schema计数为0；按精确容器ID与随机任务label核对归属后，stop/remove均退出0。容器ID `6c5c49e22f956b5a511c0bf958e6d35d4e50d994fddc36c328a4bf4321eb594b`。
- API typecheck退出0；source-policy为0 violation；diff检查通过。
- 环境 Node24.22.1、pnpm11.19.0；复用已有依赖，通过任务内链接令 `@slide/agent-core` 指向本worktree源码，不改共享依赖。`npm_config_verify_deps_before_run=false`，没有安装或宣称 frozen install。CI上轮Node24.22.2的差异保留。
- 初次环境准备因缓存pnpm.cjs没有执行权限失败，业务测试尚未启动；该次独占容器也已stop/remove。使用输出目录中的任务专用pnpm启动包装解决，没有修改共享文件权限；随后才进行上述唯一业务运行。
- 验证代码为父提交加上述单文件修复，测试文件 SHA256 `56a7af89b3c12d8b5bb0198634d541b780df7b2a2ad00ef9593420f5769dc41e`，与main原文件相同。之后只新增本文，不改已验证代码。

本地证据：`/Users/max/Coding/40-Slide/outputs/max684-preload-repair-20261118/result.json`（退出码、资源身份、清理与版本）；`test-private.log`/`server-private.log` 为0600私有日志，不附送或复制进版本库。没有制作zip、归档平台或额外探针。

## Streaming：已有证据支持的口径与边界

唯一使用的当前CI业务结果为 [44207606228/1 /browser-qualification](https://github.com/max2055/Slide/actions/runs/44207606228/job/134477584435)，head为父提交；合并checkout `8f450d85df96c2ac1cbed297ba7c5ccc816e7de6` 的tree与父提交相同。

### 80%实际计算

`frontend/e2e/streaming-live.spec.ts:201-232` 冻结第100个工具已开始并暂停、首次刷新前的两个数组，再在后续完成/刷新检查后计算：

```text
reduction = 1 - metrics(uninterrupted.parts).bodyBytes
                / metrics(uninterrupted.legacy).bodyBytes
要求 parts.bodyBytes >= 100000 且 reduction >= 0.8
```

`bodyBytes`递归累计键名为 `delta/partText/finalContent/thinkingContent/text/content` 的字符串 `Buffer.byteLength(JSON.stringify(value))`，包括字符串引号/转义和消息内重复出现的内容；不是去重后的正文长度，也不是完整JSON或实际WebSocket线速字节。`jsonBytes`、每帧加14的上界和元数据统计不进入80%公式。

采样两侧不在同一层：parts在服务端 `socket.send` 包装中、真正调用send及callback之前记录 `stream.delta/stream.snapshot`；legacy在客户端 `message` 记录收到的全部事件。双方冻结于相同业务时刻，不等于证明客户端已消费同一完整内容前缀。guard中接受、调用send、callback成功、客户端接收不能互相替代。

负载仍是1000个100字节片段、100工具、受控Provider。Provider→生产 `guardedChatProvider`→AgentRunner/hook→DirectAdapter `deliver`/projection→DisplayStreamAuthority批处理→BoundedSocketWriter guard/send→WebSocket→Gateway/reducer/Lit；SQL持久化、刷新恢复及唯一最终答复检查在80%之前执行。legacy同时接收原事件及相应projection，parts接收display stream。不能用终态正确证明性能门槛通过。

### 相对main的相关变化

- 测试原来的无chat权限手造actor/固定 `fixture` token/绕过HTTP认证，迁移为随机SQL用户、bcrypt密码、`chat:view`角色、UI登录、真实JWT/session及生产ActorContextService；HTTP使用createVerifyToken。Provider和工具负载、比较函数与边界、80%/两项100ms保持。自动trace关闭和凭据替换仅用于保护真实身份；不能据此证明无调度影响。
- `auth/chat-execution.ts` 新增起始凭证绑定及实时SQL授权，guarded Provider对每个content/thinking/tool delta先await scope.check；DirectAdapter.deliver又检查执行权限。这些await在发流热路径中，源码能确认调度变化，不能仅凭源码量化开销。
- `bounded-socket-writer.ts:29-44` 新增逐连接串行async guard队列，默认上限仍1MiB/128事件；DirectAdapter `setGuard` 对内容帧重读Actor和会话授权。达到guard队列上限时关闭4009/`Slow consumer`，不会保证已接受队列全部发到客户端。这是新增出站准入路径，不能为性能绕开授权。
- `adapter/display-stream.ts`、agent-core display stream与message projection、streaming Playwright配置与main字节一致；其批处理按计时/大小工作，未改该文件不能证明新增await对批次和snapshot次数无影响。前端Gateway另有拒绝/关联清理变更，当前成功终态不能证明其所有性能行为与base相同。

### 当前已知、未知与下一项可判别验证

CI首个业务失败为spec:232：**0.3705626522222235 <0.8**，1 failed/1 passed；两个100ms断言和成功metrics写盘未到达。当前CI日志00:33:20.310Z记录一次早期关闭，code4009、reasonBytes13、wasClean=true，connectionId `14049114-0b47-43d8-8f1c-60594be5040e`；与源码guard队列的13字节 `Slow consumer` reason吻合。日志未直接标注连接为legacy/parts，不能仅凭该关闭确定是哪一比较数组缺失了多少数据。

已有历史4fd证据另曾记录legacy4009及接受/send差额，但它绑定旧运行，不能替代本CI的连接与字节证据。旧0.12413694796619557/0.17776017473159622失败保留，**不与当前37.06%比较来推导改善/回归**。

能支持的有限解释：新增串行SQL授权提供了积压/调度变化路径；实际CI出现4009，且两侧采样层不同，故legacy分母被截短是合理候选原因；计时批处理/snapshot重发改变parts分子也是未排除项。**本轮没有证据把其中某一项确认为唯一根因，权限变更因果仍未知**，不能直接改产品性能逻辑、80%或100ms断言。

最小缺失证据是本CI同一冻结前缀的parts/legacy按事件类型的帧数、正文JSON字节和重复snapshot贡献，以及4009连接的协议归属/截断位置；最终比例不足以分离分子膨胀和分母截断。

建议下一项验证（交Chief决定，本轮不执行）：优先对该CI已保存的failure-wire私下做一次离线数值聚合，以subscription/游标关联原连接并分离首次刷新前前缀；只输出计数与字节，不输出正文或凭据。若原文件无法唯一恢复冻结边界或连接对应关系，明确停止并列出缺失标记，再由Chief决定一次有界原场景验证是否必要。本轮不下载/验包、不新增采集、不运行streaming；不擅自扩大验证链。

## 复用与交接

父提交的runtime专用config→managed API→claim→worker recovery/length/reject真实E2E 3/3 PASS（20.3s）、watchdog/native本轮PASS，仍绑定该CI及父提交。本轮只改一个独立operations测试和文档，相关实现/配置无变化，故按覆盖范围复用，不声称在新head重跑。原e5权限验收、独立审查等旧证据同样不改标版本。

当前交付是本地最小修复与一次只读定位；新候选待Chief安排针对性独立复核、同步PR和最终必需CI。streaming门禁仍阻塞，原CI失败不被本地1/1覆盖。MAX-684保持in_progress，不合并/部署、不关闭#1009；旧451→e5合并批准不覆盖本提交。
