# MAX-684 监督信号关联调查

本轮按 Chief / Reviewer 的最小调查要求完成两阶段诊断，原 watchdog 故障未确定复现，没有选择产品修复。MF-C1 已由 Reviewer 独立关闭；整体验收仍 BLOCKED，MAX-684 保持 in_progress，PR #1010 保持 draft。

## 版本、记录方案与停止条件

main base `451ab8c9969f18d94f17392a74301294de82b5e1`，产品候选及本轮实施起点 `df7faa8b31fd54a7e8b39b3f222c6e83a0457e7e`，原分支 `agent/15-backenddev-01/max-684`。本轮仓库差异仅本文；两个诊断副本、可重建补丁、执行器和完整取证在原任务附件。最终报告提交 head、正常推送回执及唯一现成 CI 快照由交付评论绑定。AGENTS 原有运行规则差异未提交。

执行前保存 measurement-plan.json，方案为：

1. 用 Bash EPOCHREALTIME 记录诊断文件 unlink、同名目录 mkdir、实际 kill 的前后边界和返回码；每条记录同时取 caller BASHPID、目标 PID、/proc/PID/stat 的 state/starttime。记录函数的进入与读取结束时间分开保留，标识函数自身的时间开销；目标退出后标 gone，不伪造其 start 身份。
2. 对同一个监督 harness 树用 `strace -f -qq -ttt -e trace=kill,rt_sigaction,rt_sigreturn -e signal=SIGINT,SIGTERM` 记录实际 kill 系统调用、内核投递的目标 PID / si_pid / 信号类型及内核 handler 返回。它不依赖 DEBUG。只跟踪 stub harness 树，不跟踪 API 业务请求；不采 execve、read/write 缓冲区或任意正文/凭据。rt_sigreturn 只表示内核信号 handler 返回，不能当作 shell 赋值已执行。
3. Bash、strace -ttt 和 Python time.time_ns 都使用同容器 CLOCK_REALTIME。用 Python 前后时间包围 Bash 时间作现场校验；不把 elapsed 秒级标签当精确 kill 时间。PID/start 在 kill 前后核对，再用内核 si_pid 关联真实发送者。
4. 阶段 A 保留原赋值 trap 和原 DEBUG。仅在 A 证实及时投递后，阶段 B 才在诊断副本的 `stop_requested=1` 之后追加独立 builtin printf 记录：时间、BASHPID、具体 INT/TERM、flag 和 eval 上下文 LINENO。DEBUG 保留，用于比较两个观测位置；新增 trap 工作可能改变解析/调度行为，不能声称 B 与原赋值 trap 等价。
5. 各阶段只执行一次 `node --test tests/qualification/*.test.mjs`，九文件、默认 Node 并发、CPU0–3（availableParallelism=4）、原12秒 watchdog、原120秒 mjs timer 和原测试断言全部保留。阶段 B 是一次预定的新增观测实验，不是重复 A 碰绿；完成后即停止，无第三次接受性试跑，无 CI 手工重跑或订阅。

诊断副本的 mjs 把原 child launcher 替换为同组 strace 包裹的 bash；harness 增加上述常规文件记录，并在 finish 保留 stub-only 原始 trace。新增一层父进程及 ptrace 会影响调度，虽然原 launcher/服务树/旁路进程断言保留并通过，也不将它称为原始 CI 的无扰动观察。

## 两阶段实际结果

环境：独占 Ubuntu24.04/aarch64 Docker 容器，Bash5.2.21、Node24.22.2、Python3.12.3、strace6.8；复用原 Linux 候选的依赖目录，未声明重新 frozen install。新增本地诊断镜像仅安装 strace。真实 MySQL bootstrap 测试按原 fixture 各自创建独占 mysql:8.4 / 随机环回端口，未访问平台库或共享测试库。

| 阶段 | 整个原并发入口 | 监督用例 | 结果边界 |
| --- | --- | --- | --- |
| A：原赋值 trap + 原 DEBUG + 系统调用/边界记录 | 142/143，退出1，总约80.9秒，wrapper约81.2秒 | PASS，约68.0秒；无watchdog | 首错为 evidence-persistence 的 pnpm 环境初始化：复用只读依赖目录时自动 verifyDepsBeforeRun 尝试写入，EROFS。不是监督断言或产品失败，整条入口不能报通过 |
| B：增加赋值后独立记录 | 143/143，退出0，总约74.1秒，wrapper约74.4秒 | PASS，约70.5秒；无watchdog | 为避免再次向只读复用依赖写入，仅在诊断 pnpm wrapper 设 verifyDepsBeforeRun=false，未改测试断言或产品配置；与 A 存在此环境差异，不用两次总耗时差推断 trap 开销 |

准备阶段宿主旧 Python 不支持 tarfile.extractall(filter=...)，在启动测试前修正为解包受控 Git archive；不计为业务失败或重跑。A 的 pnpm 初始化失败如实保留；B 的成功不覆盖 A 的非零结果，也不证明原 watchdog 根因修复。

## diagnostics-invalidated 的精确关联

两阶段均先完成 unlink/mkdir，再执行 INT；其前后 syscall 返回码及 start 身份完整，以下时间为同一 CLOCK_REALTIME 的 epoch 秒。

| 事件 | A（caller428 → target2293 / start29483767） | B（caller305 → target2333 / start29500021） |
| --- | --- | --- |
| unlink_after / rc0（记录进入时间） | 1794944715.834634 | 见附件 boundaries.log |
| mkdir_after / rc0（记录进入时间） | 1794944715.874126 | 见附件 boundaries.log |
| kill_before 记录范围 | 1794944715.889648–4715.904119 | 见附件 boundaries.log |
| 实际 kill(SIGINT) / rc0 | 1794944715.905043 | 1794944878.454116 |
| 目标内核收到 INT，si_pid 为上述 caller | 1794944715.944738 | 1794944878.493702 |
| 内核 handler rt_sigreturn | 1794944715.944779 | 1794944878.493751 |
| DEBUG 首次见 flag1 | 1794944715.946129，collect_tracked_pids:121 | 1794944878.494903，collect_tracked_pids:1 |
| 赋值后独立 printf | 未插入，不能从 A 推导独立赋值时刻 | 1794944878.495374，pid2333/INT/flag1/eval LINENO1 |
| 目标 wait | 0，无 watchdog TERM | 0，无 watchdog TERM |

A 的实际 kill 至内核投递39.695ms，投递至 DEBUG 1.391ms；B 分别39.586ms、1.201ms，投递至独立 printf 为1.672ms。PID/start 在路径失效及 kill 前后均一致；两个阶段该目标都没有 watchdog TERM，不能把别的清理 TERM 当成给目标的停止信号。

**B 中 DEBUG 先于独立 printf 0.471ms。** DEBUG 会在新增 printf 前运行，因此不能画成“printf → DEBUG”的时间顺序。独立记录确认此次 INT trap 内赋值后 flag1 的状态，但只是赋值的后界，不是精确赋值入口；LINENO1 是 eval/trap 上下文，不是产品文件第1行。原源码位置和诊断补丁另行绑定，不能用这个值冒充未插桩的执行位置。

另外每阶段9个原请求信号场景（INT、TERM、collect边界、诊断目的地、旁路场景）都关联到对应的唯一 kill、目标内核投递和同一 start 身份；B 各有一条相应信号的独立赋值后记录。关联摘要及校验断言见 correlation.json / summarize.py。两个阶段均没有延迟至12秒 watchdog 的现象。

## 因果分类与跟踪影响

本轮新证据排除了**本次诊断执行中**“诊断目录操作未结束就把旧发送日志误当成实际 kill”“kill 失败或打到不同 start 身份”“INT 一直未投递”“只能依赖 DEBUG 推测收到哪种信号”“正常清理实际依赖 watchdog TERM”这些解释。B 中赋值后记录与 DEBUG 相符，没有发现 flag 赋值失败或 DEBUG 漏观测的确定样本。它们不是对历史 run 的追溯性排除。

跟踪改变时序：标记自身含13.19–21.77ms的读取/调度跨度；目标多次处于 ptrace-stop（stat=t），记录同时提供状态。监督用例约68–71秒，不能把它与另一环境/负载下的未跟踪运行做无偏耗时对比。strace 的过滤只限制输出，仍有 ptrace 调度开销；未以增加预算抵消。B 在信号 trap 里增加 builtin/文件打开以及更多 DEBUG 边界，可能改变历史竞争窗口。故不能从两次正常退出推定原始赋值 trap 或 DEBUG 有/无缺陷，更不能依据 B 的143绿选择修复。

原故障仍绑定 run44154655935 / attempt1 / job134292183067、checkout `d35591cb0d6976f974207d6a5a266b4aa86cc05b`。它只有路径操作前的秒级 INT 标签、后续成功字符串、12秒 watchdog 后的首次停止标记，不能补出原 kill/内核投递/赋值位置。本轮无法重建那个历史缺失信息，监督故障与 Cron 的因果及引入归属仍未定。原 artifact14359154832 的实际上传、认证下载、CRC和120项manifest已验证事实继续有效，不能退回“上传未验证”，也不能当作故障已修复。

剩余证据缺口是：在**真实复现失败**的一次执行中，以低扰动机制同时取得路径失效、kill及返回码、目标身份、内核信号和赋值/观测边界，再决定属于发送、Bash或观测哪一层。本轮两阶段没有这样的失败样本，因此不改监督源码，不继续固定循环或猜选产品修复。

## 验证、清理与交接

诊断副本保留原断言及12/120秒预算的源码/补丁绑定另列附件，原工作树产品及测试字节未变；仓库仅增加本报告。最终运行 source-policy 和 diff 检查，准确命令/退出码见附件。MF-C1独立35项、作者91项、五阶段绑定、真实 MySQL/JWT/managed浏览器与TLS及已关闭MF-T1/T2、MF-I1/I2/I3按原有效边界复用，无机械重跑、无未知POST重发、零模型调用，不恢复人工听读。

两次容器均前台完成并移除，原 fixture 各自的MySQL容器ID和removed=true记录保留；仅处理本任务进程与资源，无服务遗留待接管。交付时只取一次当前候选现成必需CI快照，绑定run/attempt/实际checkout；选中上游、release-artifact、ci-gate无终态则记待定，不等待、轮询、手动重跑或新增订阅。监督具体子根因与修复、完整当前候选CI及Chief安排的原Reviewer复核仍需交接，不自审放行、不合并、部署或关闭#1009。
