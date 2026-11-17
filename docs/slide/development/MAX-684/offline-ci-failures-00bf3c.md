# MAX-684 现成 CI 失败证据离线分析

本轮只认证保存、离线核验并分析现成产物，没有启动实验、服务、模型调用或重放业务请求，没有修改产品/测试/CI源码。两项原始失败均尚无充分证据选择业务修复，整体仍 BLOCKED。已关闭 MF 保持关闭，任务 in_progress、PR #1010 保持 draft。

## 版本与证据来源

远端当前候选仍为 `00bf3c3defcb698acde20f21d9c17aaae4f33a4a`，main base `451ab8c9969f18d94f17392a74301294de82b5e1`，原分支 `agent/15-backenddev-01/max-684`。本轮报告在原分支作本地文档提交、随附件交付，不推送、不启动另一轮 CI；本地报告 head 与远端 CI 候选分开记录于交付评论。AGENTS 原差异保留，不提交。

当前 run44163115865 / attempt1 的 plan/backend/browser 实际 checkout 均为 `27bbbd9e1fdf9ff74325863d4d65a0cfde19e6cd`，parents 依次为上述 base、候选；tree `51fae9f65fb13496b34af20270b63c622ce9d432` 与候选一致。复用 Reviewer 已认证的 Git 对象和 plan 选择记录，并核对本轮下载 backend/browser 原日志的 checkout。Reviewer 包认证 CLI 下载后 SHA256 为 `dce18f6ffaa29b16378acdd657b35c8a988e7b054e059f0ba29ab6be98f2f322`，1,287,580字节、CRC通过。

本轮独立从 GitHub artifact API 认证下载并封存：

| 产物 | 大小/哈希 | 完整性 |
| --- | --- | --- |
| 新监督14364616378 | 57,046字节；`935154702a3e92220f1ca5a45d8827e796f5e1ae5e4ac5d722854b3119bb634f` | 大小/摘要与API一致；CRC、120项manifest的长度/哈希全通过 |
| 原监督14359154832（复用原认证包） | 57,400字节；`fdfe8a612ecf33dfeb7e94cf09268d475208ebb8f212dce63b9df575f24445d1` | 再核CRC与120项manifest；保留已验证实际上传事实 |
| 同run browser实际上传14363374413 | 956字节；`e7b61ffccc86f7d1d14274701758a3d0d3df0647739effb4aa954da7851df914` | 大小/摘要与API一致、CRC通过；两成员属于TLS结果，非runtime trace |

原始 job 日志仅本机0600封存，附件仅含固定错误、身份/版本/步骤摘录和原日志字节/哈希索引。未把凭据、JWT、Cookie、登录正文或任意业务响应打入交付包。

## 监督：逐场景对照与首错

原 run44154655935 / attempt1 / backend134292183067 的候选为 `9204f0ffc3cedc804c94bd1fb462fa38033e24b3`，实际 checkout `d35591cb0d6976f974207d6a5a266b4aa86cc05b`，同一 main base。新 backend134322095216 对应当前候选/checkout。四个监督相关源码从原候选至当前候选逐字节相同，不把本轮报告视为执行代码回归，也不扩大为整个PR与main基线的因果结论。

两个包的 result 均 status1、signal=null、error=null、timedOut=false、collectionErrors=[]；native入口均142/143通过、1失败。harness1来自watchdog断言，不是目标脚本非零退出。逐场景离线结果如下，完整 trace/result/identity 对照见附件 supervisor-comparison.json：

| 场景 | 原包 | 新包 |
| --- | --- | --- |
| api-exit | PASS，wait1，3秒 | PASS，wait1，3秒 |
| vite-exit | PASS，wait1，2秒 | PASS，wait1，3秒 |
| signal-term | PASS，wait0，3秒 | PASS，wait0，2秒 |
| signal-int | PASS，wait0，2秒 | PASS，wait0，3秒 |
| signal-during-collect | PASS，wait0，3秒 | PASS，wait0，3秒 |
| signal-int-during-collect | PASS，wait0，2秒 | PASS，wait0，2秒 |
| unrelated-orphan | PASS，wait0，3秒 | PASS，wait0，3秒 |
| diagnostics-missing | PASS，wait0，2秒 | PASS，wait0，2秒 |
| diagnostics-unwritable | PASS，wait0，2秒 | PASS，wait0，2秒 |
| diagnostics-directory | PASS，wait0，3秒 | **FAIL，watchdog12秒，wait0，15秒** |
| diagnostics-invalidated | **FAIL，watchdog12秒，wait0，15秒** | PASS，wait0，2秒 |
| fork-gap / node-gap / relative-fork-gap / playwright-sigkill | 各PASS，wrapper wait0 | 各PASS，wrapper wait0 |

两种失效配置各在另一包通过；现有证据不能证明某个目录操作是必要原因，也不能把两个不同场景归为已确定的共同子根因。

| 失败证据 | 原 diagnostics-invalidated | 新 diagnostics-directory |
| --- | --- | --- |
| 目标身份 | pid5372/start9369，parent2802 | pid5154/start24716，parent2776 |
| 请求信号日志 | INT elapsed0 / success | INT elapsed1 / success |
| 完整trace | 67,611字节，未截断/无采集错误 | 63,061字节，未截断/无采集错误 |
| watchdog快照epoch | 1794942389.068261 | 1794945241.705822 |
| 快照目标状态 | S/do_wait | R/wchan0 |
| 首次flag观测 | 1794942389.235987，top399 | 1794945241.710725，record_service_tree146 |
| 观测相对快照 | 后167.726ms | 后4.903ms |
| cleanup首尾 | 1794942389.936156–2392.350362 | 1794945241.725532–5244.060738 |
| 目标最终wait | 0 | 0 |

新旧快照的6个目标/服务/子进程start均与早先identities相同；新包快照中tracker在poll、四个服务/子进程在sleep。两个目标在watchdog前均持续经过check_stop而未进入cleanup。新包最后一个此前check_stop为1794945240.858458；原包为1794942389.032284。这支持“原INT停止请求未及时变成可观察停止标记”的直接失败分类；排除目标早已退出而harness只等EOF、120秒外层超时、先卡在cleanup以及证据采集错误。新包目标R也不支持把两次失败统一解释成do_wait阻塞。

**仍不能还原实际信号因果。** 两包的signal-sent标签都早于实际kill且只有秒级elapsed；目录场景在启动前创建目录，invalidated场景在标签后才unlink/mkdir。两个包均缺实际kill前后时间/返回码的独立记录、内核INT/TERM投递及赋值执行边界。watchdog代码顺序为写标记→snapshot→kill TERM，但没有TERM实际执行时间。因此这里只能确认首次flag观测晚于watchdog快照，不能据此给观测贴上“首次INT”或“已投递的TERM”的因果标签，也不能反推出最初INT何时到达。

A诊断142/143、退出1及EROFS初始化问题保留；B143/143及其pnpm环境差异、strace父层/ptrace-stop/13.19–21.77ms标记跨度/新增trap printf的限制继续成立。本轮离线对照不把成功诊断当作原/新故障修复证据。

## 浏览器：失败实际位于pending completion恢复

同run browser-qualification134322095188，步骤“Runtime candidate isolation and history”，1失败/2通过，退出1。精确错误是 `agent-runtime.spec.ts:51` 的 `getByText('重连恢复的唯一最终答案。', { exact: true })` 在15000ms内不可见。它不是第38行普通答案首次刷新断言。

按该次同步执行路径和失败位置，可区分已到达与未到达：

| 阶段 | 现成证据支持 |
| --- | --- |
| 原prompt运行终态、assistant唯一落库、精确普通答案且无候选污染 | 第25–35行在失败前已通过；本轮没有保存当时SQL行或响应正文，不虚构run/session UUID |
| 第37–40行第一次reload及普通答案可见、SQL查询与先前rows相等 | 已通过，因此不能把本次故障概括为所有历史刷新都失败 |
| 第44–49行独立claim恢复run，complete模拟getConnection错误，并断言running / completionPending=true | 已通过；这是测试主动构造的可恢复中间态，不能把预期异常当作产品失败；正文内容来自测试固定样本 |
| 第50–51行恢复reload后显示新答案 | reload已执行；精确显示断言失败 |
| 第52行再次读取run终态、第53–56行再次reload/唯一显示/按run message_id查询最终消息 | **未到达**；现有证据不证明这些值成功，也不证明其失败 |

日志约19:56:20–37 UTC有userId1的WS连接在导航时以1001/clean关闭，未携带这个恢复run/session的关联。整个job其他步骤的预期401不能套到此处。该步骤没有可关联的HTTP history响应、chat.watch订阅、pending查询/恢复事务结果、run.snapshot/complete投递、刷新后消息列表或DOM上下文。未见明确拒绝日志不等于证明没有拒绝；前面的成功也不证明恢复阶段权限未变化。

**trace/error-context的实际保全缺口已确认。** 失败日志列出 `test-results/agent-runtime-runtime-qual-0271e-ue-safe-final-across-reload-chromium/{trace.zip,error-context.md}`，默认Playwright配置 retain-on-failure，且本步骤从frontend运行。现有workflow第299–306行却仅归档 `frontend/test-results-investigation-tls/`；实际上传956字节zip只有`.last-run.json`与TLS的trusted-tls.json，同run artifact清单没有该runtime归档。已保存日志中的路径和同run实际上传包，但**无法从本轮可认证取得的产物中取得该次runtime trace/error-context原文件**，不能声称已验trace或已取得浏览器network/DOM。不能用TLS的last-run状态替代runtime结果。

源码给出需区分的链路，而非已证实的根因：客户端refreshChat发送watch并读取REST `/api/chat/history`；服务端chat.watch经授权后查询pendingCompletions并recoverCompletion，提交消息/终态后发送run.snapshot/complete；客户端终态再拉历史并应用显示。现成日志不足以判断是watch未到/被替换、授权或事务失败、终态未投递，还是历史/页面应用未更新。本轮不据静态路径选取授权、持久化或UI修复，不重开已关闭MF。

## 最小建议与待释放的取证/验证范围

**先修证据归档，再决定业务修复。** 唯一已有确定依据的修复建议是让runtime失败产物与上传路径匹配：对默认输出目录增加独立、失败时仍执行的归档，避免与TLS/其他Playwright步骤共用产物。保持原断言/超时，不把丢失证据改成跳过；正式变更须由Chief释放，本轮仅提方案。trace可能含登录请求/JWT/Cookie，归档前须结构化剔除认证材料与任意正文，只保留本fixture的允许元数据；脱敏失败保留为采集失败，不能泄露原始trace到Issue。

### 监督低扰动方案（尚未执行）

- 保留原父子进程树、默认并发、assignment-only trap、DEBUG和12/120秒预算；不再加strace父层或trap printf。在harness预打开独占常规文件FD，以builtin在目录操作和kill前后记录时钟/返回码；同时记录caller与target的PID、start、PPID和PID namespace，避免仅给target存start。此记录仍有开销，不能称为零扰动。
- 若环境允许，候选方案是在目标任务专属cgroup/精确pid+start范围外置内核tracepoint观测sys_enter/exit_kill、signal_generate、signal_deliver；分别标明发送者/目标身份和INT/TERM，不修改kill语义，不采其他任务信号、命令参数、网络或任意内存。需要核验内核支持、tracefs及CAP_BPF/CAP_PERFMON或受控root权限；当前未验证可用性，未申请/使用这些权限。
- 要进一步区分shell赋值和DEBUG，可在**精确Bash二进制校验及符号可用性确认后**考虑只过滤变量名stop_requested、值是否为1的用户态探针；不输出其他变量/字符串，不假定存在可探测符号。不可用时该层仍标缺口，不退回trap printf猜测。探针本身也会改变调度，有限ring buffer、丢失计数和启停边界必须入包；丢记录不能作为“信号未发生”。
- 内核monotonic时间与原EPOCHREALTIME用前后成对采样建立带误差界的映射；不直接混算，记录校时/漂移及采样区间。收集器在本轮前台生命周期内完成和回收，不把本任务服务混入daemon或其他worktree。
- 由Chief批准后仅在新独占fixture、一次明确的观察窗口执行；若无失败样本，按界限结束。只有真实失败时kill/投递/赋值边界齐全，才分别针对发送/解释器/观测层提出修复；原预算、全部断言、旁路不误杀及进程清理仍须验证。

### 浏览器低扰动方案（尚未执行）

- 只观察新独占fixture的actor/run/session/message和连接/订阅，使用本批随机HMAC标识关联；不导出token、Cookie、密码、脚本/答案正文。原prompt/POST不重放；未来新fixture的启动与任何修复由Chief另行释放。
- 原断言失败前后增加受控只读快照：该run的state/completionPending、唯一message_id是否存在、固定样本文本是否匹配的布尔值/长度；保留原第51行断言，不先执行recoverCompletion或手动写库“帮助”测试。这样可区分恢复未提交与已提交但不可见。
- 仅对history接口记录路径类别、status、同fixture消息数/目标message存在及固定样本匹配布尔；对WS只记录watch/授权结果、pending数量、事务结果码、run.snapshot/complete元数据及客户端接收/应用，排除auth帧和任意payload。关联当前session选择、导航与DOM目标是否存在，区分请求未到、事务未成、事件未达与应用未更新。未确认有权时不读取正文。
- 使用已有权限，不绕过JWT/实时授权；服务端UTC/monotonic与浏览器performance时间通过请求关联和前后偏移采样给出误差界。监听回调/边界日志的开销、缓冲丢失和脱敏结果分别记录；保持原60秒case预算、15秒业务断言及managed装配。前端改动如被确认必要由Chief协调前端负责人，不由本轮越界修改。

## 同run唯一终态CI快照

读取窗口2026-11-17 **20:17:44–20:17:47 UTC**，run44163115865 / attempt1，completed/failure；30项共26 success、4 failure，未等待、轮询、手工重跑或新增订阅。八类选择api/browser/integration/recovery/sandbox/rollout/artifact/code全部true，复用同run plan输出；所有job/步骤终态在附件ci-summary.json完整列出。

| 失败job | 首个有效错误/传播 |
| --- | --- |
| backend134322095216 | 原始失败：native监督diagnostics-directory watchdog，harness1/目标wait0 |
| browser-qualification134322095188 | 原始失败：pending completion恢复reload显示断言，第51行 |
| release-artifact134327412361 | `check-gate.mjs --checks-only`拒绝backend/browser failure，退出1；**打包前失败**，无独立构建故障证据 |
| ci-gate134327618742 | 汇总拒绝backend/browser/release-artifact failure，退出1；不重复计为第三/第四根因 |

当前候选完整必需CI已确认失败，不再记为未终态；但原监督子根因和浏览器业务子根因仍待定。本轮只完成证据与取证方案交付，不自审放行。已关闭MF-C1、MF-T1/T2、MF-I1/I2/I3及仍有效真实业务/TLS证据复用，原A非零与诊断扰动限制保留；历史401/fatal不扩大，不恢复人工听读，不合并、部署或关闭#1009。
