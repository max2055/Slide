# MAX-684 runtime脱敏归档与监督第一层取证候选

本轮完成 Chief 释放的有限实施及两次独占验证，只作本地候选，不推送/触发CI。归档缺口已形成可审阅修复；一次runtime业务仍失败并已取得新的因果证据，一次native入口通过但未复现历史监督故障。整体仍BLOCKED，MAX-684保持in_progress、PR #1010保持draft，已关闭MF不重开。

## 版本、范围与合同

main base `451ab8c9969f18d94f17392a74301294de82b5e1`；本轮起点 `e6712d3973e65b3c33fcd2c61d1676c4343483a3`（含上一轮未推送报告）；远端候选仍 `00bf3c3defcb698acde20f21d9c17aaae4f33a4a`，开工和交付分别核对，不覆盖远端。最终本地head、增量/相对远端补丁、快照/哈希随Issue附件交付。AGENTS原差异不提交。

只改取证/fixture/归档：runtime专用Playwright配置、正向允许列表collector/runner、fixture观察器、workflow的该步骤/独立上传，以及stub supervisor harness和离线边界校验器。真实服务、tracker、assignment-only trap、DEBUG、原mjs launcher/断言、授权及恢复事务均未改，无产品UI变化。TLS上传段保持原样。原60秒case、15秒恢复显示断言、12秒watchdog和120秒外层预算保留；自动核对所有原expect语句仍逐字存在。

## 结构化归档实现和验证

runtime步骤通过 `node scripts/qualification/runtime-browser-evidence.mjs` 执行，仍只运行原agent-runtime三个用例、单worker、managed装配及受控Provider。新增配置将原Playwright产物置于独占 `test-results-agent-runtime-private/`，retain-on-failure沿用；原始trace/DOM/error-context不上传；最终runner在子进程执行期间设置umask077并恢复原mask，私有产物只供owner读取。runner在下一业务步骤前读取该fixture自身的events.ndjson，严格检查字段、枚举、HMAC格式、数值、条数/大小、每场景唯一result；只向 `test-results-agent-runtime-sanitized/evidence.json` 写正向允许的记录。

HTTP只选该fixture的history类别和status/count/固定样本匹配布尔/长度；WS只选watch、run/stream状态等允许类型及session/run/message HMAC，不记录auth帧、token、Cookie、密码、任意正文/DOM。HMAC密钥仅存worker内存，刷新前后同fixture关联一致；不同worker的键不可交叉比较。Node侧同时记录wallBefore/mono/wallAfter，mono以当前worker为域，不跨worker或与Linux容器生减。当前记录wall采样跨度0–1ms，另有Date.now约1ms量化误差；不冒称浏览器内部事件发生时刻。dropped仅指允许事件的采集/写入，不证明所有网络帧无损。

未知字段、非法枚举、缺结果、超限或观察器失败均写非空collection=failed固定错误，不回显输入/异常正文；明确输出RUNTIME_EVIDENCE_COLLECTION_FAILED。业务失败保留原退出码，业务成功而采集失败返回2；输出不可写也保留已知业务非零，信号退出按128+信号保留。拒绝已有events输入，避免旧证据冒充新运行。workflow独立upload仅指向sanitized/evidence.json，runtime实际执行后无论失败均上传；runtime未执行时跳过此专用上传，缺文件为error，不用空包成功掩盖。

针对性Node测试 **8/8 PASS**：成功0、业务失败7、采集失败2、双失败仍7、敏感/额外字段及枚举注入排除、缺数据/不可写输出、信号143保留、旧证据拒绝且不启动新业务。YAML解析与上传路径/执行条件校验通过。敏感测试值只在隔离临时输入中，归档输出未出现。成功、业务失败、采集失败三路径均有明确非空状态，不将采集成功等同于业务成功。

## 一次runtime真实验证及新的因果链

独占mysql:8.4，ID `673b47552b5ffb9a4bc4edcea93014c6e0cd24971458b0ea98f8d0a5c6bdf076`，label MAX-684-observation；启动后核对mysqld PID51586、随机环回端口59905。新schema db_ops_ai_qualification，只在该容器内使用。API31173/WS28973/Vite5203/受控Provider28900启动前无监听；生产迁移/bootstrap/server/worker按原managed脚本运行。macOS ARM64、Node24.22.1、pnpm11.19.0；沿用任务依赖链接，不冒称重新frozen install或CI Ubuntu环境。零真实模型发送。

一次入口，**1失败/2通过、Playwright/归档runner退出1，collection=complete，26条允许记录，dropped0**。recovery仍是原第51行语义的目标显示断言失败（插入记录后位于第60行）；length/reject通过。原第52–56行在recovery失败后仍未到达，未为通过调用恢复方法/补写库或重发POST。私有trace/error-context已在独占目录实际生成，仅本机0600封存；交付只含结构化摘要，不将其原件上传。

同一recovery fixture的HMAC关联记录显示：首次history为200、2条消息且普通样本匹配；pending_staged后再次发送watch，收到同一恢复run的run.snapshot=cancelled；随后history持续200、2条消息但恢复样本不匹配。失败finally仍完成限定run/actor/session的只读SQL快照：cancelled、completionPending=true、按该run message_id的消息数0、匹配false/长度0。这支持本次目标答案未提交，不是已经提交而仅不可见。

随后仅对新独占schema作一次只读补充核对，限定本fixture恢复prompt及cancelled/pending条件，匹配唯一run：

- errorCode=CHAT_AUTHORITY_REVOKED，staged固定样本匹配true，消息数0；
- chat_session_version、chat_credential_ref、chat_credential_expires_ms全部NULL；
- 不输出原run/session/actor/token或正文；唯一性与本次fixture范围记录于readonly audit，不声称可跨worker解开HMAC。

**本次新fixture已确定的原因是恢复run缺失认证绑定。** 原用例四参数claim未传第五个Actor；claim源码因此写入三个NULL。map在绑定不完整时不生成chatAuthority；recoverCompletion的authorizeOrdinaryCompletion先检查缺少binding并抛ActorAuthenticationError，再由已有分支取消该run并保留pending意图。观测到的cancelled WS、SQL错误码/NULL及无最终消息与此链路吻合。这里的通用CHAT_AUTHORITY_REVOKED码不证明真实用户刚被撤权；不需要推断实时权限丢失或修改正确的失败关闭策略。

这不补造历史run44163115865中已丢失的runtime trace或SQL，也不单凭新样本声称历史故障已修复。归档只是暴露本次事实。

**交Chief的最小后续建议（未实施）：** 只调整测试构造的claim，使第五参来自该fixture真实认证、经实时校验且携带原凭证的Actor；原15秒显示/唯一最终消息及无重发断言不变。不得直接补三个DB列、用任意字符串调用recordVerifiedCredential伪造“已验证”、传宽权actor或放宽authorizeOrdinaryCompletion。应先通过真实受保护身份入口验证当前token/owner/sessionVersion，再在内存中携带其credential交claim，验证新绑定与真实来源一致；不日志化token，也不导出绑定原值。若需要新的fixture通道或服务改动，先由Chief释放并审阅具体差异。本轮未实施此业务fixture修复，也未重放新run碰绿。

## 监督第一层实现、实录及一次默认并发

harness在任务mktemp下以0600创建独占常规文件并预开FD8，目标launcher关闭此FD，原父子树不增加strace层。记录器只在harness读取/proc，使用builtin获取caller/target的PID、start、PPID；以预取namespace inode及`-ef`核对实际caller/target同namespace，写入显式namespace和signal。目录操作及实际kill前后保留独立返回码和EPOCHREALTIME begin/end；每caller有序号，离线验证身份/namespace一致、配对及丢失计数。watchdog记录来自其真实BASHPID，不能冒充父进程caller。目标退出后的gone有明确事件范围。

观测失败进入原observation_failed/result门禁，不能把主业务失败改绿。失败包允许列表保留boundary文件；本机验证通过显式独占export保留记录，导出失败也非零。Linux若clock/proc不可用为采集失败；旧Mac不支持时显式supported=false/dropped未知，不宣称已记录。没有新增权限、capability、seccomp覆盖、内核探针、BPF/PERFMON或受控root操作，也未改实际服务/tracker。

Python离线校验 **2/2 PASS**（有效、丢行/身份非法、unsupported边界）。执行原入口前另做一次无服务的记录器preflight，以signal0检查本进程PID/start/PPID/namespace、FD及解析，dropped0；它不算INT/TERM业务通过。

获准的一次 `node --test tests/qualification/*.test.mjs` 原九文件、默认并发、CPU0–3/availableParallelism4在独占Linux容器执行：**143/143 PASS，退出0，总约18.7秒；监督约15.0秒**。Ubuntu24.04/aarch64、Bash5.2.21、Node24.22.2、Python3.12.3；依赖复用readonly Linux store，pnpm verifyDepsBeforeRun=false明确沿用B阶段环境，防止旧A的EROFS，不把它说成新frozen install。原MySQL bootstrap fixture自建独占容器/随机环回端口。

实际boundary共有 **46条、9组kill前后、dropped0、watchdog0**；最大begin/end跨度约 **0.342ms**。caller/start/PPID/namespace、目标身份和每caller序列均校验通过。所有边界与原DEBUG同用该Linux容器CLOCK_REALTIME；另保存Pythonwall/mono前置采样，仅作时钟域说明，不用单点标定假装排除全程漂移。不将主机浏览器时钟与此容器混合推断因果。记录器仍有stat/文件写入开销，0.342ms是本次记录跨度，不是零扰动证明。

本次没有复现即结束，无第二次九文件运行、无额外信号实验。kill成功和稳定身份仍不能证明内核投递、handler或赋值位置；历史两次监督根因继续未闭环，成功样本不关闭它们。若第一层未来失败仍不足，须另交精确过滤/权限/取证方案由Chief决定，本轮不升级权限。

## 最终候选验证、清理与交付限制

运行时fixture观察器、harness和产品源码按实际被测副本保存哈希。真实验证后只完善collector对信号退出/一致性/显式错误和私有产物umask077的处理及workflow跳过条件；最终collector离线重收同一events，结果与原26条摘要逐字结构一致、业务仍退出1，未再跑浏览器。8项collector测试及YAML校验对应最终代码；增量/远端基线补丁分别提供，明确这些验证层次而非声称最终所有文件都在同一次e2e执行。

原runtime expect、60/15秒预算、原服务/tracker/mjs/DEBUG与12/120秒预算逐项核对；source-policy、diff及相应语法检查通过。无产品UI/公开契约/服务逻辑变更，不机械重跑TLS、原整套浏览器或无关模块；候选的独立脱敏/归档/失败传播审查仍交原Reviewer，不自审放行。

新MySQL核对精确ID/label/PID/port/cmd后优雅stop0并remove0；API/WS/Vite/受控Provider端口均无监听。native MySQL删除journal和精确ID回查gone，native容器已移除；共享DB配置未动，无后台服务。原始日志/trace只本机0600，附件仅允许元数据、代码补丁/哈希、清理及计时证据。

旧CI终态沿用run44163115865/attempt1：候选00bf3c、实际checkout27bbbd9e，26success/4failure；仅backend/browser两原始失败，release-artifact/ci-gate传播。本轮未重查旧CI、不推送或触发CI、不建任务/订阅。历史缺失trace仍缺失，A非零/EROFS、B环境差异、401/fatal及观测限制保留；不恢复人工听读、不合并、部署或关闭#1009。
