本轮仅交付有限 streaming 数值取证补丁、离线验证及监督探针待确认方案。原 streaming 业务仍 FAIL（80% 实际 0.12413694796619557），后续启动/paint 100ms 未到达；监督根因和整体验收仍 BLOCKED。MAX-684 保持 in_progress、PR #1010 保持 draft。补丁须交原 Reviewer 审查，再由 Chief 明确释放一次原场景；本轮没有启动浏览器、数据库、业务场景或监督探针。

## 版本与核验

main base `451ab8c9969f18d94f17392a74301294de82b5e1`；增量起点 `2755c9a1eee68943156b9247feb4c6493c0acc7b`；最终完整 head 由本任务交付评论和附件 versions.json 绑定。仅修改 `frontend/e2e/streaming-live.spec.ts`，新增本文；AGENTS 原差异保留、不提交。没有修改授权、产品 writer、Provider、负载、预算或监督代码。

使用运行环境 CLI 认证下载 Reviewer 附件 `01a1ebb7-3d41-78de-a0ac-fe9410b48308` 与独立报告 `01a1ebb7-3710-7102-9a69-de5590f5b587`。证据包 334,893 字节、SHA256 `e31c6d5dcf272e37df47a62ac56b11b0a9afeba7f9c768fcb04cc89d4eb79a7f`、17文件/16项 manifest、CRC、逐项长度/哈希全部通过，独立报告与包内 REPORT.md 字节相同。

## 数值观察范围与语义

只在现有 server socket 观察、legacy message/close 监听、原 tool99 暂停、首次刷新前数组复制及 finally 加同步聚合。没有新增 await、flush、等待或 chat.watch/watchSession 订阅。新增 close 监听只观察既有 socket 生命周期。writer.send 的测试实例 wrapper 保持原 this、参数、返回值及异常，调用原方法前后只读 queued/pending WeakMap；socket.send 继续原 callback 转发，socket.close 保持原参数/返回值。wrapper 随本任务 Adapter 销毁，无生产注册。

最多16连接、3个冻结快照、65,536字节单文件，不增加逐帧列表。连接编号按本 fixture 顺序：首个为 legacy，随后为原 parts 浏览器及刷新；这是测试装配顺序，不是产品协议身份识别。两端已有 run/session 不导出，无需 HMAC；没有导出随机密钥或可跨批关联标识。

| 白名单字段组 | 语义与边界 |
|---|---|
| version/sourceHead/scenario/clockDomain | schema=1；40位十六进制提交或null；固定 MAX-129 / node-performance。 |
| connectionIndex/mode | 任务内序号；legacy/parts 固定枚举。 |
| admissionCalls/Accepted/Rejected | 原 writer.send 调用/布尔返回计数；入队接受不等于实际发送或浏览器消费。抛异常仍原样传播。 |
| actualSend/clientReceive | frames/bodyBytes/jsonBytes/eventCounts；前者为server socket.send层，后者仅legacy client message层。parts clientReceive=null表示未观测，不能解读为零接收。 |
| eventTypes/eventCounts | 固定 auth_ok、run.started、stream.delta、stream.snapshot、text_delta、chat、error、protocol.error、other；未知类型仅累加other，不导出其字符串。 |
| callbackOK/Failed | 现有send callback结果计数，不输出异常文本，也不证明浏览器已消费。 |
| lastQueue/peakQueue/closeQueue | queued/pending events、bytes、bufferedAmount、原maxEvents/maxBytes；在入场、writer调用前后、实际send/callback、close及边界只读。peak为采样峰值，不声称连续观测极值。callback采样可能早于writer释放pending；边界另取当前值。 |
| closeCode/reasonCode/closed/closeRequests/closeAt | 数值及固定not-closed/guard-queue-limit/raw-pending-limit/guard-failed/empty/other枚举；严格匹配现有关闭reason字面量，绝不导出原reason。分支标识来自精确产品字面量，并非新增内部产品日志；closeQueue为close调用时快照。 |
| snapshots | 固定tool99-paused、tool99-before-refresh、finally-before-cleanup；mono为Node performance时标，与浏览器时标不能直接相减。复制后不随callback/刷新变化。 |
| comparison | 仅首次刷新前原uninterrupted两个数组的prefixFrameCount/bodyBytes/jsonBytes和原reduction；其余边界null。明确parts为server发送层、legacy为client接收层；不以含刷新全量wire替换分母。正文计数沿用原JSON字符串字节语义，不是正文原文长度。 |
| collectionFailed/dropped/overflow/businessExit | 数值；businessExit是该场景在保存时的成功/失败状态0/1，不冒充整个Playwright runner最终退出码。清理错误也记失败。超16连接/3快照记dropped；超文件预算输出精简白名单且overflow=1。观察不完整先保存再抛固定错误，不能静默变绿。 |

聚合入口只从event提取字节量和固定类型计数，没有复制任意字段；禁止 JWT、密码、headers、URL查询、Actor、SQL/工具参数、run/session原值、正文、wire、DOM、trace和原错误文本进入新数值文件。未知键被投影掉，未知枚举值落other，非有限/负的队列数值落null。新文件不依赖字面量redact兜底。原私有wire/CDP仍按既有内存秘密替换，任意编码秘密过滤和未来成功上传仍未验证；不随交付分发这些原始产物。

finally在清理前冻结边界，在原全部清理阶段及原诊断保存尝试后用 writeFileSync 写 `MAX-684-streaming-numeric.json`。写盘失败加入原cleanup错误集合；原业务异常继续作为AggregateError.cause和首项，不能被观察错误吞掉。前置连接/工作区初始化在原try之外的失败仍可能没有此文件，不扩称所有初始化失败均有证据。

数值计算增加JSON遍历、WeakMap读取、三个冻结复制及最终同步写盘，可能改变调度/队列竞争。边界采集没有等待双方flush，遗留发送/接收差异本身是证据。原性能阈值不变，但不得用前后总耗时差归因认证、trace或本次观察成本；本轮没有业务实测或观察开销基准。真实SQL guard、自动trace关闭及平台/依赖复用差异继续保留。

## 离线验证与红绿

附件包含可重跑 probes.mjs / red-green.py / invariants.cjs 和结果。使用已有 Node v24.22.3、TypeScript 6.0.3，读取本地实际spec helper、原finally和产品BoundedSocketWriter，转译后在VM与假socket运行；不装依赖、不连接外部资源。缺少默认Node PATH先定位已有工具，无安装/服务副作用。仅转译诊断，不称完整语义typecheck或最终gate。

九项通过：真实writer的guard队列事件超限、pending事件超限及callback；字节超限；前缀计数/reduction与冻结；未知字段/秘密哨兵；连接/快照界限及保存后失败；聚合错误隔离；保存失败与原异常保留；writer抛出/callback错误；直接执行原spec finally验证失败保存及write失败cause。三种内存变异（浅拷贝可变前缀、未知reason原样输出、失败时跳过保存）均退出1，未变实现退出0。这些是离线红绿，不是第二次业务场景。

26行expect逐字相同（原24行业务断言及此前2行登录断言），104个await表达式未增加，watchSession调用仍1；config、产品writer、serve-e2e与监督harness字节相同。80%/启动100ms/paint100ms、原等待/180秒预算、1000片段/100工具及授权均保留。最终source-policy为0 violation，diff检查通过；不执行最终gate。首次pnpm入口因缺少PATH/依赖状态预检查尝试启动pnpm install而ENOENT，没有安装依赖；显式使用仓库pnpm11.19.0并设置verifyDepsBeforeRun=false后完成检查，未声称frozen install。完整命令与退出码见附件。

## 监督探针确认表：本轮只作方案

现有证据仍绑定 run44185239121/attempt1、merge checkout `488026a9fc13e553c78ba75ca76179337958e491`、artifact14374521142（67,181字节，SHA256 `2042154e12103d130c3534955e68faa30ac685a895e2dc3d3e551445f798613e`）。Reviewer已复验126文件/124manifest、52条边界、9组首次信号、watchdog2、dropped0。两个首marker距首次kill结束11.072958s/11.200894s；37µs及123.889ms不是首次内核投递或赋值耗时。本轮复用这些已核验记录，不下载新CI状态、不实际探测目标。

| 待确认项 | 需要提供/确认的人与具体交付 | 通过前不得推导的结论 |
|---|---|---|
| 精确环境身份 | 有权Linux资源成员提供该复现环境kernel release、架构、内核映像/调试资料build-id与hash；Bash实际路径对应二进制hash、build-id、版本及对应debug/source包。Chief绑定原候选、容器映像和一次执行窗口。历史Ubuntu/Bash版本标签不替代实际build-id。 | 不能套另一内核/Bash的符号、偏移或探点；未知项保留待核。 |
| generate/deliver schema | 资源成员提供实际tracepoint格式与该kernel对应语义文档/源码；原owner静态核对signal_generate/deliver可取得的sender上下文、target PID/TID/TGID、sig/code/result、group/合并语义及返回状态。字段不可直接获得时必须标记关联值/未知。 | generate不等于成功排队，deliver不等于Bash trap；不能猜字段名/结果枚举，不能由当前进程context推定实际sender。 |
| Bash赋值边界 | 资源成员提供准确debug符号/源映射，原owner定位原assignment-only trap `stop_requested=1` 的写前/写后候选，Reviewer核对是否确实针对该owner变量及布尔值，是否涉及eval/子shell副本。Chief另行批准具体探点。 | Bash函数入口、LINENO或DEBUG marker不等于赋值完成。没有可靠写后点就保留缺口，不猜偏移、不读任意栈字符串。 |
| PID/start/namespace过滤 | 原owner拟定预先允许的发送者、owner与watchdog PID/TID/TGID/starttime/PPID、PID namespace inode和宿主/容器ID映射清单；资源成员确认映射采集能力与目标资源独占。attach前后核对，PID退出/重用立即标失效；有限子shell集合须Chief另批。 | 仅PID过滤不足；owner未见赋值不排除子shell副本，不允许全系统宽采后再过滤。 |
| 校时与排序 | 资源成员确认探针实际时钟及跨CPU语义；原owner方案保留wall-before/mono/wall-after配对区间和开始/结束校准、漂移/跳变标志、CPU与单调事件序号。Reviewer核对重叠区间而非伪造全序。 | 不能直接减内核mono与Bash wall；37µs不是精度界。未校准、跨CPU不确定顺序明确标记。 |
| 丢失与标准信号合并 | 资源成员确认缓冲/丢失计数是否覆盖各CPU、attach失败/空窗及signal_generate结果语义；原owner拟定有界缓冲，达到界限停止并保留dropped/overflow。 | 多次TERM可能合并；没有一对一deliver不等于丢失，不以事件缺席证明未投递。首次与watchdog同TERM需保留不可辨区间。 |
| 权限与范围 | Max或有权资源成员逐项确认独占资源、具体机制（root/BPF/perf/ptrace/uprobe中实际所需者）、只读字段、PID集合、一次窗口和清理权限；Chief确认授权/资源/观察点方案后另行释放。资源成员列现有安全策略，不能由owner先改sysctl/capability再追认。 | 现有VM密码、旧ptrace实验或本轮补丁授权均不含新扩展权限；本轮未请求/使用凭据，也未作可用性探测。 |
| 输出、停止与恢复 | 原owner拟定不超过64MiB总输出、每种固定schema；仅信号/身份数值、布尔、CPU/时钟、固定枚举、丢失和退出码。原12秒watchdog/120秒mjs timer、九文件原入口、trap/DEBUG/服务/tracker不变；资源成员确认仅detach本次link/event及恢复其原状态的方法，Chief确认一次窗口。权限/schema/build-id不全则不attach；失去身份、超界、丢失或attach失败即封存为不完整，不自动重放。 | 不采命令/环境/凭据/正文/任意栈，不删他人探针，不添加strace父层或trap printf，不加预算、不循环碰绿。64MiB为待批准上限，不是现有能力或已执行配置。 |

方案意图是区分生成、投递、Bash处理/赋值、DEBUG观测四层。uprobe/缓冲/调度仍有扰动，成功样本不能关闭历史故障；需要确实复现失败且证据完整才选择监督修复。当前没有可确认的kernel/Bash build-id、schema及权限清单，不能直接释放实际实验。

## 复用与交接

已关闭MF-R1/R2/S1/F1/C1/T1/T2/I1/I2/I3不重开。runtime3/3及35条有效上传仍绑定上述merge/run；旧本地认证/runtime仍绑定 `2d8024aa034661bd508a0c0b25afbc914bfa9f75`，TLS/五阶段及其他未失效材料按原边界复用，不改标新head。26success/4failure及上游原始/下游传播分类、历史缺失/401/fatal/BODY、A非零/EROFS与B环境扰动、原artifact14359154832已验证120项manifest事实保留。

本轮不推送、查询/重跑CI、执行最终gate、新建任务/订阅、重发未知POST、恢复人工听读、合并部署或关闭#1009。原Reviewer审补丁和Chief单独释放一次业务运行仍为下一步；不是已通过的验收或新授权。
