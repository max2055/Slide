本轮交付为 streaming 身份 fixture 修复及一次原场景失败封存、监督现有证据离线分析。实现方不宣称整体验收通过。MAX-684 保持 in_progress、整体 BLOCKED、PR #1010 保持 draft；已关闭 MF 不重开。本轮不推送、查询/重跑 CI、执行最终 gate 或新增监督实验。

main base `451ab8c9969f18d94f17392a74301294de82b5e1`，起点/远端已推送候选 `578ccfce6aa2974ce5d3026fc124b8a99cfd22ff`。本轮实现及唯一 streaming 运行绑定 `82436e3e200d86ed87d703904d0515ced666b13a`，后续仅新增本报告，最终 head 见 Issue 交付及附件版本文件。AGENTS 原差异保留且不提交。原服务、tracker、assignment-only trap、DEBUG、12/120 秒预算及全部 streaming 业务断言均未改。

认证下载上游附件 `01a1eb96-8625-7d12-9df0-9c09084887ff`：89,428 字节，SHA256 `008f3f866e2abfa16b5b9c1d010fdc4179c2c06fae94b1fc72b4c120f6591455`；58 文件/57 项 manifest、CRC、各成员长度/哈希全部验证。阅读完整报告，精确绑定 run44185239121/attempt1、merge checkout `488026a9fc13e553c78ba75ca76179337958e491`，backend job134400077395/browser-qualification job134400077720。监督原 artifact14374521142 经认证下载，67,181 字节、SHA256 `2042154e12103d130c3534955e68faa30ac685a895e2dc3d3e551445f798613e`、126 文件/124 项 manifest、CRC/长度/哈希均通过。这是读取现成证据，不是重新查询 CI 状态或重新实验。

streaming 原失败位于 `streaming-live.spec.ts` 的 createSession：手写 Actor permissions=[]，产品 ChatAuthorization 要求真实 chat:view。完整入口 `playwright.streaming-live.config.ts` 只管理 Vite，测试 worker 自建独占 schema、REST、DirectAdapter 和受控 Provider，并非 serve-e2e.sh 装配。还核对了同类 chat-input.live fixture，其相似手写身份未顺手迁移。

最小迁移限五个测试/helper 文件：新增 streaming-auth-fixture，用生产 AuthDatabaseService 验证 bcrypt 密码、ActorContextService 读取 SQL 身份、signAccessToken 签发 JWT、loadSecurityConfig 读取该 fixture 实际 secret；新增薄登录页面复用产品 renderLoginGate 和 API client，测试只提供 reactive host/登录完成状态。登录 HTTP 入口为测试装配，复用上述真实服务，不声称完整 server.ts 登录限流、refresh、审计等链路已验收。普通测试用户通过真实 user_roles/role_permissions 配置 chat:view，而非塞入 Actor.permissions。创建 session 时从 UI 登录 JWT 真实 authenticateAccessToken 得到原 Actor，原对象携带 WeakMap credential 直接交产品 createSession；HTTP 使用 createVerifyToken、WS 使用真实 SQL ActorContextService，未重建凭据或直写 run 绑定，没有改变生产授权。

真实 JWT 引入后，原 Playwright trace.zip 会记录认证帧，因此此 fixture 的自动 trace 关闭；原手工 CDP 性能 trace、wire/数值诊断代码保留，写出的 wire/CDP 文本按内存中的实际密码/token 做精确替换。此观察差异明确保留，不能把前后运行当完全相同的性能环境。业务预算仍为 config 180 秒、各原断言预算和阈值逐字保留。失败发生在 CDP 最终写出前，本次没有成功 CDP trace，不能补造。实际生成五个私有输出文件，JWT 形态扫描零匹配且无 trace.zip；附件不包含原始截图、DOM/error-context、wire/任意正文或服务原日志。

前置在任务独占 MySQL 8.4/loopback 随机端口 60823、全量真实迁移上执行：`STREAMING_FIXTURE_MYSQL_PORT=<port> node --import tsx --test tests/streaming-auth-fixture.acceptance.ts`，5/5 PASS、退出0。合法登录 JWT 创建 owned session，Actor 具有真实 credential 关联及 SQL chat:view。缺失/无 chat:view 身份均零 session 创建，HTTP send 分别401/403、业务 handler 调用0；WS 缺失身份关闭4002，无权限 JWT 先确实 auth_ok，再发送 chat.send 收到拒绝；模型/工具函数实际计数均0。没有向真实模型发送请求。

开发中的前置问题另行保留：最初 WS auth 后立即 send，拒绝来自 authenticating 状态，不能冒称无 chat:view 拒绝；修正调度后又误等待无认证分支的 error 帧（真实契约仅 close4002），前置30秒超时。最终按实际协议分开等待 close/已认证拒绝才形成有效5/5。超时进程由测试 runner 退出，精确 PID 终止尝试时已不存在；其本任务 schema 已显式清理。它们是前置验证器问题，不是 streaming 业务重跑、未知 POST 重发或产品异常。

前置通过后仅执行一次原 managed 入口：`pnpm --filter slide-frontend exec playwright test --config playwright.streaming-live.config.ts`，主场景失败、清理回归通过，退出1，总约16.88秒；源码副本4930文件（排除原AGENTS差异）逐个哈希对应实现 head。依赖复用既有安装/pnpm11.19.0 verifyDepsBeforeRun=false，未声称新 frozen install。MySQL、REST、WS、Gateway/reducer、真实 UI 及受控模型/tools 按原路径运行，真实模型调用0。

本次已到达：真实 UI 登录、JWT/SQL session创建、100次工具执行、100000字节内容、tool99暂停时首次刷新、恢复后终态completed/durable、SQL唯一最终assistant消息、100条工具副作用、11轮受控Provider、再次刷新且唯一性/计数保持，以及 parts正文不少于100000字节断言。随后原 `expect(reduction).toBeGreaterThanOrEqual(.8)` 失败，实际 `0.12413694796619557`；该错误在当前源码232行。accepted→waiting_model ≤100ms、paintP95 ≤100ms及成功 metrics/trace写出均未到达，不报告通过。失败即封存，没有第二次业务尝试或阈值调整。

新失败的观测边界：同次私有日志显示原 legacy socket 关闭4009、reasonBytes=13，与现有 BoundedSocketWriter 的 Slow consumer 分支相符；保留的 legacy 仅80帧（其中75个text_delta），parts共709帧。它支持“legacy比较基线可能不完整”的解释，不能据12.41%就认定产品正文压缩回归。原 uninterrupted 比较前缀没有单独封存，失败 wire 含后续刷新，不能把全量wire重新计算结果冒充原断言数值。建议下一步先在同一受控场景记录固定比较边界、legacy连接关闭/发送队列数值及完整性，保留原80%门槛；不先修改产品 writer、授权或限制。具体补观测/验证仍交Chief释放，本轮不实施或再跑。

监督静态/离线核验：当前52条边界、9组首次信号、watchdog2、dropped0，与原124项manifest和完整未截断trace关联。两个目标PID/start/PPID/namespace与首次及watchdog kill一致，四次kill均rc0；harness status1、signal=null、timedOut=false、collectionErrors=[]，两个目标最终wait0。不得以wait0覆盖harness失败或把外层120秒超时误作本次首错。

signal-term：首次TERM kill_before为1794952783.863232–.863852，kill_after为1794952783.863948–.864454；watchdog TERM前记录1794952794.934546–.937284，后记录1794952794.937375–.937969。首个owner signal_observed=1794952794.937412，距首次kill_after结束约11.072958秒；它位于watchdog前后记录包络内。按同一wall时标，marker比watchdog after.begin晚37µs，而该begin按harness源码发生在kill返回后；这进一步说明不能把marker归于首次TERM，也不能把37µs当内核投递耗时或误差界限。最后已记录check_stop边界为1794952794.443383，cleanup首条为1794952795.410097，目标wait0于1794952797.842045–.842407。

diagnostics-directory：目录建立成功发生于1794952811.854565–.857169，随后目标启动；首次INT kill_after结束1794952812.815536、rc0。watchdog TERM before=1794952823.891340–.891952、after=1794952823.892043–.892541；首个owner marker=1794952824.016430，距首次kill_after结束11.200894秒，晚于watchdog after结束约123.889ms。最后check_stop采样1794952823.814978、cleanup首条1794952824.723209、wait0结束1794952827.154517。不能把此marker当首次INT的执行证明。

marker语义由原DEBUG条件限定：仅原owner BASHPID、stop_requested==1且尚未见过，才写signal_observed；它证明该次DEBUG读取时flag已为1，不直接标出trap赋值指令、生成者或内核投递。旧trace没有中途截断/采集错误，早期存在owner DEBUG采样而未见flag1；这只能限定采样边界，不能反推出首次信号一定未投递或选定Bash具体缺陷。watchdog前静态/proc快照中TERM/INT不在忽略/阻塞位、目标有相应捕获位且pending为空；signal-term目标R/运行态，diagnostics-directory为do_wait。这些只是单点，不能证明整个11秒区间的mask、pending或处理状态。

可排除的当前解释包括错PID/身份不一致、kill返回非零、原trace被截断、collector错误、外层timeout，以及“目标退出非零导致首错”；源代码中signal trap在服务启动前已注册、INT launcher已重置继承忽略，不能直接归咎常见后台SIGINT继承问题。目录不可写只解释diagnostics-directory的诊断目的路径，不解释signal-term的同类延迟。剩余精确缺口为首次信号生成/内核投递、Bash处理/赋值位置以及DEBUG观察扰动之间的关联；本轮没有足以选择产品修复的确定根因，未改监督源码。

最小下一步方案供Chief决定：保持原父子树、trap/DEBUG/服务/tracker及12/120秒断言，只在获准的独占复现中关联发送者/目标PID+start/namespace、首次与watchdog信号的generate/deliver、以及flag赋值边界。优先使用外部过滤的既有内核观测能力，避免strace父层或trap printf；先核实对应kernel/Bash build-id与可用观测点，不猜符号偏移。若需受控root或探针权限须另行释放，本轮不申请或使用。仅输出信号、身份、时间、flag布尔和丢失计数，不采命令/环境/正文；记录wall/monotonic映射区间、丢失/采集开销与调度影响，仍不能由诊断成功关闭原故障。若权限或可重现性不足，先交证据缺口，不循环碰绿。

唯一任务容器精确ID `edc1f174282fccbb5ab44d1f5c90db8c1e8d9791d055c258c8709a0d04d6336c`，核对label/端口/进程后优雅stop/remove成功；任务端口60823/5199/61439/61127均无listener。streaming清理诊断cleanupFailed=false，browser/legacy/adapter/REST/SQL/schema/workspace清理均完成。没有修改共享资源或未收集的后台任务。source-policy、diff及原断言/预算保持检查随证据包。

继续复用本次CI merge上的runtime3/3与artifact14375365585白名单35条核验、TLS及已关闭MF；旧本地业务实测仍绑定2d8024aa034661bd508a0c0b25afbc914bfa9f75，不改标新head。本轮遗留为原80%比较断言新失败、监督未知区间，以及获准推送后的完整选中上游/release-artifact/ci-gate。run44185239121/attempt1终态26 success/4 failure及两个上游原始/两个传播失败保留；旧CI、历史缺失/401/fatal/BODY、A非零/EROFS、B环境及观测限制不抹除。不新增任务/权限/订阅，不重发未知POST，不恢复人工听读，不合并部署或关闭#1009。
