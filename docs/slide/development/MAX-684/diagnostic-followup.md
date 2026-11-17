# MAX-684 关联诊断交付

base：`451ab8c9969f18d94f17392a74301294de82b5e1`。
本轮旧 head：`fa092a52021e3f04980cb1dd6ca703e14974b811`。
新 head 为本文所在提交，完整 SHA 同步记录在任务交付评论；未合并、未部署。开工远端回读确认 PR #1010 为原分支、main base、draft。既有 AGENTS.md 工作树改动未纳入本轮提交。

本轮只修改测试配置、测试入口和诊断，不修改生产授权、fatal handler、恢复链、锁或总超时。JSON 证据见同目录 `diagnostic-followup-evidence.json`。原始日志保存在受控本机 outputs/max684-diagnostic-followup，不作为脱敏附件。没有付费模型调用。

## 结果与首个有效错误

| 组别 | 同配置完整结果 | 首个有效错误 / 分类 |
|---|---|---|
| execution | 139 PASS / 0 FAIL / 1 SKIP，退出0，124.39s | 显式传入子进程专用测试 JWT 后，长度回执通过。先前缺 JWT 属测试配置缺口。bounded 本轮未复现，不能宣称修复；没有重现3308断连。 |
| composition | 0 PASS / 1 FAIL，退出1 | 第4个匿名请求401断言实际503。属于 HTTP 响应生命周期/认证拒绝兼容问题；引入归属尚未用完整base进程验证。不是未进入standby，亦无lease丢失证据。 |
| startup | qualification 退出1 | leader liveness 汇总超时；更早的有效错误是健康HTTP 200/空响应体导致JSON解码失败，waitFor捕获该失败后继续至原30s上限。API已监听、已处理健康请求。属于健康响应/探针解码问题；引入归属尚待完整base进程比较。锁等待不能解释此次解码失败。 |
| Edge | 原4项2 PASS / 2 FAIL，退出1；最终登录定向0 PASS / 1 FAIL，退出1 | NSS已安装，托管前端、本地受控Provider就绪。TLS第一错误是macOS Edge不信任隔离NSS CA（ERR_CERT_AUTHORITY_INVALID），属Linux专用夹具与宿主平台差异。登录期望200实际500；同时关联实际API fatal退出1，原fatal仍未修复、根因归属未知。 |

execution 唯一 SKIP 保留原原因：`T04_BROWSER_TEST !== '1'`，原可选真实浏览器崩溃用例未启用；没有删除断言或将单例结果拼成全文件PASS。原Reviewer及其他旧候选证据不替代新候选必需门禁。

## composition：同一匿名请求的时间顺序

最终请求标识为 `p10-anon-4`（前3个也分别关联），均由测试显式传入，不记录任意header。

1. 前置/后置独立查询均确认保留租约有效、owner仍是测试保留方；readiness均503，符合standby预期。
2. 全局onRequest分支1/2/10均未发送拒绝，响应状态仍200。
3. 认证拒绝已设置401，但尚未完成发送（sent=false），业务handler仍进入；随后onSend先观察401，再观察503及白名单稳定码 `INTERNAL_ERROR`。
4. WorkerRecovery仅standby→测试清理时stopping；子进程正常退出0。没有恢复degrade/lease失效的关联证据。

源码对应：`createVerifyToken` 的无凭证分支调用reply.send后返回void；effective-triggers路由随后会对缺失actor做重验并将非预期错误映射503，HTTP安全层将其转换为INTERNAL_ERROR。静态路径与观测一致，但尚未通过产品修复的对照试验证明充分因果。其他前三条匿名请求最终401，不能据此声称其handler未进入。

## startup：连接、锁与健康请求

任务容器启用performance_schema；独立连接只读有界查询元数据锁。每个API子进程使用任务内独占数据库principal，跨Docker NAT仍能归属；证据只输出api-1、connection-1/2及允许的对象类别，不输出principal、真实连接ID、主机或SQL。

最终观察：connection-1属于api-1，等待agent-security-policy表元数据锁；connection-2是测试锁持有者，同对象granted。有效lease=1。api-1未退出、已listening、已收到health-transport；健康handler已进入且onSend产生200。父探针读到HTTP200、body字节数0，停于json-decode。

因此首个失败发生在健康响应/探针解码路径，而非监听前、连接失败或健康依赖SQL查询。策略表锁确实阻塞该API的其他初始化，但不能将其与liveness超时混为单一根因。原锁、原30s等待、原断言均保留。

## Edge：配置入口与诊断边界

按 `.github/workflows/ci.yml` 的Edge环境使用PLAYWRIGHT_MANAGED_ENV、QUALIFICATION_CANCELLATION_E2E、QUALIFICATION_CRON_E2E、显式测试管理员及独占MySQL。实际读取入口为 `scripts/qualification/serve-e2e.sh`：取消测试开关启动本地cancellable-openai-server，并通过configure-cancellable-provider写入隔离qualification schema；调查用例另建独占schema并注入合成Provider。未读取共享生产Provider或私有凭据。

本机通过brew安装NSS及依赖，certutil执行成功；Linux `$HOME/.pki/nssdb` 夹具并不能让macOS Edge信任CA。未改系统钥匙串、未关闭证书校验。TLS应在原Linux CI环境验证，或单独提出受控平台适配；本轮没有扩大外部信任副作用。

原4项运行已复现FATAL_UNHANDLED_REJECTION；原Runtime.exceptionThrown入口没有观察到帧。新增Debugger观察时，Node的rejection监听使uncaught模式仍不触发，故测试预加载使用all暂停、立即resume，只输出Promise拒绝的白名单帧及固定元数据；不读取异常name/stack/message/cause或远程异常对象，不改变产品fatal处理。

最终登录定向：实际API子进程先observer-ready，随后观察到frameCount=6且frames=[]的Promise拒绝，紧接fatal和observer-exit code=1。诊断已经触达该API的引擎拒绝事件，但在“scriptId映射/仓库路径白名单”阶段没有得到任何可输出源码帧；无法据此确定依赖/产品源码位置。其他测试进程的有效帧不冒充API fatal帧；Promise拒绝观察本身也不等于fatal。

真实子进程回归确认诊断能对仓库内测试拒绝输出校验后的文件位置，退出仍为1，且不泄露敏感message/cause/URL。这个受控回归不代表原fatal定位已通过。引擎坐标未做TS source-map还原，不冒充原始TS源码行号。

## 最小对照与待决定的产品差异

新增可复现诊断入口 `node scripts/diagnostics/http-lifecycle-repro.mjs`，真实HTTP、当前Fastify依赖、无数据库/模型。一个async preSerialization hook时health200/15字节；两个时health200/0字节；匿名拒绝两组均能进入handler并返回503。这证明reply.send后未等待/返回reply存在生命周期兼容风险；不是完整base回放，不据此判定所有问题均由本次chat hook引入。

供Chief决定的最小产品候选（尚未实施）：在 `src/auth-middleware.ts` 四个拒绝分支等待reply完成（`await reply.code(...).send(...); return;`，保持Promise<void>与所有稳定码）；在 `src/health-routes.ts` liveness handler返回 `reply.send(...)`。先验证这两处是否消除匿名handler误入及空健康响应，再按实际结果决定其他必要边界；不保证它们修复fatal，不改恢复准入、授权政策或总超时。

剩余最小处置：原Linux环境跑TLS；决定上述产品生命周期修复后重跑受影响认证、健康、composition、startup及Edge。若fatal仍在，继续在测试入口将引擎坐标映射失败细分为固定类别，不读取/输出原异常数据，不凭其他测试帧猜测根因。不新增实现者或中间复核，稳定候选仍交原Reviewer。

## 命令与必要检查

环境：macOS arm64，Node24.22.1，pnpm11.19.0，任务独占MySQL8.4动态端口50763、空测试口令。startup自己建立并清理另一任务容器；各测试独占schema。所有任务容器及托管服务已停止。NSS工具安装保留。任务范围原始产物已从工作树移至受控outputs，AGENTS.md原修改保留。

从仓库根目录执行；下列配置均为假凭据/测试配置，不是生产配置：

```bash
AGENT_RUN_TEST_MYSQL_PORT=50763 AGENT_RUN_TEST_MYSQL_PASSWORD='' pnpm --filter slide-api exec vitest run src/investigations/execution-recovery.mysql.test.ts
OPERATIONS_TEST_MYSQL_PORT=50763 pnpm --filter slide-api exec vitest run src/operations/server-composition.mysql.test.ts
pnpm --filter slide-api exec tsx ../../tests/qualification/startup-readiness.test.ts
DB_HOST=127.0.0.1 DB_PORT=50763 DB_USER=root DB_PASSWORD='' QUALIFICATION_ADMIN_PASSWORD=Tpam1234 QUALIFICATION_CANCELLATION_E2E=1 QUALIFICATION_CRON_E2E=1 PLAYWRIGHT_MANAGED_ENV=1 T06_TEST_MYSQL_PORT=50763 T06_TEST_MYSQL_PASSWORD='' SLIDE_TEST_PROCESS_EVIDENCE=1 NODE_OPTIONS="--import=$PWD/scripts/diagnostics/process-evidence.mjs" pnpm --filter slide-frontend exec playwright test --config playwright.edge-ci.config.ts
# 最终诊断入口修订后的原失败场景：同一环境，加 --grep 'qualification login authenticates'
node --test scripts/diagnostics/*.test.mjs
node scripts/diagnostics/http-lifecycle-repro.mjs
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm ci:source-policy
```

最终诊断测试3 PASS；后端typecheck、contracts、source-policy、diff检查均退出0。全4项Edge使用前一诊断入口，最终修订入口只运行原失败登录场景，不能合成最终4项PASS。execution及composition/startup最终相关代码之后未再修改，复用对应结果。未运行全仓安全/完整CI门禁，因为候选仍有明确失败且尚不是稳定集成候选；不宣称可合并。正常push可触发CI，无轮询或订阅。

证据索引（本机原始日志，仅版本化JSON为脱敏交付）：execution.log；composition-final.log、p10-recovery-evidence.json、p10-server-process.log；startup-final.log；edge.log、edge-engine.log、edge-login-final.log；diagnostic-tests.log、http-lifecycle-repro.log、typecheck.log、contracts.log、source-policy-final.log。原始日志哈希另存raw-log-sha256.json，清理与业务失败分开：composition清理退出0；startup finally清理完成；Edge实际API fatal退出1，不能算清理失败掩盖业务错误。
