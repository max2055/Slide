# Slide 10 月审计整改自主实施 Implementation Plan
> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 完成 10 月 1 日审计及 10 月 3 日复核覆盖的 A01–A18，调度 16 个实施子任务，完成 PR、冲突/CI 修复、受门禁约束的自动合并和最终证据收口。
**Architecture:** 保留模块化单体、DirectAdapter、ActorContext、Workflow/Outbox、fencing 与 canonical facts；按独立责任拆成可回滚 PR。
**Tech Stack:** TypeScript / Fastify、Lit / Vite、MySQL、现有数据库驱动、Vitest、Playwright、Docker Compose、Multica CLI、GitHub CLI。

## 范围版本 v2
v1 为 docs/superpowers/plans/2026-10-03-audit-remediation-plan.md 的技术复核；v2 将全部 W01–W14（含 a/b）转为自主实施契约。v1 “待确认”“先做第一批”的阶段审批语句不再是本工作流的执行门槛。其技术发现、迁移边界与验收仍适用；v2 的调度/PR规则优先。原报告不被改写。

全部工程整改纳入，不只第一批；容量优化先测后改，发布/真实生产数据修复/付费模型质量认证不纳入。最终交付软件、测试、迁移和 dry-run/回滚材料以及明确的支持矩阵；不因缺 Oracle/达梦/真实付费模型环境伪造其认证通过。MySQL、PG、隔离故障验收属本轮必须完成，可自行建立本地测试容器；遇外部许可障碍先完成其他独立项再报告。

## 产品与兼容决定
建议采用的产品与兼容默认值（待本方案确认）

|决定|建议默认值|对范围的影响|
|---|---|---|
|D1 部署承诺|近期支持一个承担后台任务的 API 实例；意外双进程必须安全失败、状态明确。完整多副本自动接管不列入本轮。|W07 仍修启动期续租和就绪误报；备用实例不被承诺会自动接管。若要求 HA，需要加选主重试、共享状态及真实滚动升级验收。|
|D2 数据库承诺|保留 MySQL/PG/Oracle/达梦现有入口；分别显示 declared/configured/verified/degraded，不把 declared 当认证通过。首批真实验收为 MySQL 控制库和 PG 采集。|不删除其他驱动、不擅自降低既有支持承诺；Oracle/达梦缺真实环境时记为“未验证”。若发布宣称四种均已验证，四种真实环境都必须通过。NoSQL 当前矩阵为 unsupported，不新增完整支持。|
|D3 分析新鲜度与费用|运行中复用同一有效任务；完成结果只有在主体、证据版本、模型/提示词版本相同且未过期时才可复用，并标明时间。允许显式重新诊断。|结果未知时禁止自动再次付费；用户主动重试时提示可能重复调用。缓存时效沿用当前配置/窗口，但不再只按同一小时判断有效性。|
|D4 恢复含义|本轮保留“人工恢复确认”，记录人、时间、原因，文案不称“自动验证通过”。|不新增自动恢复引擎。客观指标持续观察窗是后续独立需求。|
|D5 Memory 定位|保持个人/会话作用域和现有显式共享，默认关闭；本轮不扩为团队知识库。|做只读查询和容量测量；不默认迁移到数据库或引入向量库，不宣称跨主机可用。|


“待本方案确认”这一 v1 标题不构成本实施任务内的再次批准步骤。具体默认值按上表执行；W12a 采用可控慢报表10秒时通知/采集2秒内开始作为确定性实验候选目标，不宣称生产 SLA。若基线已解决某项，验证并保留证据，不重复改代码。

## 任务与阶段
|工作包|stage|责任|直接前置|
|---|---|---|---|
|W01|1|LLM 凭证目的地址绑定与测试授权|无|
|W02|4|Cron 执行主体、资源范围与撤权校验|W01|
|W03|2|PG 统一解密与 Schema/索引连接释放|无|
|W04|5|Cron 触发 ID 与启动指标质量误标修复|W01、W03|
|W05|6|Cron runId、业务完成协议与页面跟踪|W02、W04|
|W06a|8|报表 occurrence 恢复与通知 outbox 原子提交|W05、W07|
|W06b|9|分析任务持久派发、恢复与未知结果治理|W06a、W07|
|W07|7|启动期续租、就绪探针与 Compose 配置透传|W05|
|W08|10|AI 冻结证据、引用校验与实际执行来源|W06b|
|W09|11|Metrics V2 保留维护接线与引用保护|W06a、W07|
|W10|12|事件流转事务与人工恢复确认审计|W08、W09|
|W11|13|实例删除、任务失效与连接释放生命周期|W02、W05、W06b、W09、W10|
|W12a|14|工作队列观测、阻塞测量与有界调度|W11|
|W12b|3|Memory 只读快照与容量基线|无|
|W13|15|诊断界面证据解释与运行状态体验|W05、W08、W10、W11|
|W14|16|全链路故障验收、迁移回滚与整改收口|W12a、W12b、W13|

所有较早 stage 都是当前 stage 的合并与验收屏障。按用户最新要求，16 个子任务各占一个独立 stage，严格串行；原业务直接前置保持不变。每项完成均由原生阶段完成事件唤醒父任务。

## 调度器责任与恢复算法
1. 首次运行回读本任务、children、各 issue 的 active runs、PR 状态和当前 main；从持久状态恢复，不依赖上次模型记忆。将主任务置 in_progress（无二次启动），写 metadata audit_orchestration 包含 scopeVersion=v2、state=running、currentStage、startedAt、childIds、PR/head/merge、blockedReason、lastProgressAt、wakeupIds、资源增量。重复启动先检查当前 active run，禁止重复派发。
2. 激活预配置的 10 分钟巡检 wakeup：从 issue wakeup list 取“审计整改主任务巡检”规则，以 issue wakeup update 的完整参数重新启用；参数 kind=every、every=10m、mode=continuous、max-fires=1000、expires-in=168h、agent-id=15astra UUID，instruction 采用本任务的巡检协议。不存在则创建。到期前24小时仅在有未完成且可推进工作时续期；完成/取消时禁用所有本族巡检和一次性等待。用户明确暂停时不得自动续期或恢复；人工恢复后再启用。
3. 严格按 serialOrder 选择最小未通过 stage 的唯一子任务。启动前须回读全家族 active runs；存在任何其他 active/queued 子任务则不派发。前序各项均须 PR 已合并 main、验收有证据且由主任务确认 done，原业务直接前置也须满足。未激活项保持 backlog；首次激活使用 multica issue status <id> todo（平台自动入队），立即回读 runs，若已有 active/queued run 不得再 rerun。若提升后未形成 run、或已激活任务失败需恢复，在确认无活跃运行后使用 multica issue rerun <id>，不得反复 assign 或同时提升多个任务。家族最多1个活跃子任务、含父最多2个运行；不修改 agent 全局并发、不取消其他任务。累计委派上限16，最大深度1，不新增子代理。当前子项有待合并 PR、失败或阻塞时，修复/等待当前项，不跳过启动后项。
4. 子任务退出不等于完成。若已有 PR、尚未 merged，则跟踪 CI/审查并在 main 更新后处理冲突；有可修复问题且该子任务无 active run 时，在该任务记录具体复现/失败日志/目标 head 后 rerun 原任务。同一 SHA 的同一测试不反复跑完整 gate；短暂网络故障退避重试，持续权限故障明确阻塞相关项。
5. 主任务持有合并职责。所有门禁满足才合并一个 PR，回读 merge SHA 后将子任务置 done；无 PR、验收缺失、cancelled 或仅人工改 done 都不能通过阶段。若子任务错误置 done，恢复可解释状态并续跑。下一阶段必须在上一阶段所需 PR 实际进入 main 后才启动，避免未落地主干的堆叠分支。
6. 每个阶段结束由 Multica 原生 stage 完成事件唤醒父任务。巡检补足 run 失败/等待 CI/未形成 done 时的缺口；必要时可添加 --until-pr checks 或 merged 单次唤醒，但以巡检为兜底。回读 wakeup 状态识别平台触发链暂停，优先保留定时巡检，禁止事件自触发循环。连续平台拒绝/服务停机属于外部阻塞，不承诺绕过。
7. 没有状态变化时不重复评论。每次有 PR、失败、合并、阶段前进或真实阻塞时更新精简进度与 metadata。定时检查无变化时使用 issue wakeup checkin 按 CLI 帮助静默结束；不得标 done 退出调度。主任务不占住运行槽长时间 sleep，持久化后让 wakeup 续跑。
8. W14 汇总各子任务实际 SHA 和证据，统一运行最终候选完整 gate、真实隔离 MySQL/PG、浏览器、启动租约、恢复/备份演练。外部环境未覆盖只影响相应认证，不自动扩为新产品目标。
9. 16 个子任务均达到合并与验收条件后，主任务另建最终收口文档 PR，提交实施计划、任务/PR/merge 对照、18项验收矩阵、限制和回滚入口（不重复实现子任务）。同样经过检查并合并；回读 main 和 PR 后将父任务 done，state=completed，关闭巡检。主任务和每个子任务均有真实 PR 交付。

## 巡检协议
每次唤醒先回读 issue 状态、metadata、children、active runs 与关联 PR。若本任务 cancelled/done 或 metadata.state=paused/completed，则停止派发并禁用规则。其余按上述严格串行算法推进。修复属于当前任务的冲突/CI失败；明确所有权后自动合并满足八项 CI 和审查要求的精确 head，随后启动下一阶段。遇无变化保持安静，不反复建单、空提交、修改仓库保护、改模型配置或绕过门禁。真正缺少外部权限时记 blocked 原因并继续可独立工作；只在状态变化或需要最小外部输入时通知。

## 执行与交付协议
工作区 max（b8b48997-9774-43ab-bd3e-f53fbd8f8fe6），项目 Slide（9fc8429d-ba6c-4765-8114-c4480efdd5c1），仓库 https://github.com/max2055/Slide，基线 main@7916d44。负责人为 15astra（45c6e088-9615-48ae-a675-f91d1447c25e），使用现有运行配置。读取所在 worktree 的 AGENTS.md，保留其他人的修改；所有子任务禁止继续派生代理。当前目录外可能有其他任务同时工作，不能回滚别人的提交。

主任务按 stage 调度。前置完成指 PR 已合并到 main 且验收有证据，不是子 run 已退出、PR 已创建或状态被手动改 done。启动时 fetch origin/main，在隔离 worktree 的 codex/<任务编号>-<主题> 分支实施；保留旧会话/分支以供续跑，禁止反复新建同一 PR。只修改本任务范围的文件和直接必要的回归测试。迁移编号在最新 main 上分配，跨任务冲突由主任务串行安排。

先复现失败用例，再最小修复，再 focused tests/受影响模块 typecheck；缺依赖、CI 失败、可解决冲突在范围内自主处理，不逐步请求用户确认。受影响 API 更新生成契约。根据最小必要提交集 git add/commit/push；自动为本任务创建指向 main 的 PR，标题带任务编号，正文记录问题、变化、测试、迁移/回滚和未验证项。PR URL 与精确 head SHA 回写本任务并按平台支持方式关联。若本包结论无需代码变更，仍提交真实验收/测量文档的 PR，不创建空提交。

开发完成后进入 in_review，主任务负责串行审查与合并；子任务负责对其 PR 的 CI 失败/冲突继续修复。主任务或子任务只有在 PR 已 MERGED 且本任务验收完成后才标 done。不得 PR 刚创建就标 done。PR review 的有效范围内问题必须处理，不擅自 self-approve 或绕过外部 required review。所有工作已包括推送、创建 PR、跟踪与满足门禁后的合并，不需要对这些常规步骤重新批准。

自动合并策略：当前仓库 allow_auto_merge=false，无 branch protection/rulesets；不修改全局设置。主任务主动检查当前 PR head 的 backend、frontend、agent-core、sandbox-controller、browser、browser-qualification、recovery-qualification、release-artifact 八个 CI job 全部成功；缺失/等待/失败/cancelled/skipped 均不是成功。检查未解决审查意见、mergeable、main 是否已纳入当前分支；用 gh pr merge --squash --match-head-commit <核验过的SHA> 执行，不使用 --admin。合并前 ref 变化或未知状态先重新核实。之后回读 mergedAt/mergeCommit 和 main 包含关系；不得以命令退出零代替合并成功。主任务一次只合并一个 PR；其他 PR 随后与新 main 同步，变更后重跑受影响检查，不沿用旧 head 的测试。

仅用隔离临时数据库/容器/假凭证做故障实验；不改实际 .env、不重启用户服务、不迁移或清理生产数据、不自行购买资源或调用付费模型。保留旧数据/legacy 读取，历史修复与破坏性清理交付 dry-run 清单。不可获得的外部环境明确记录，不能把未验证当通过；先完成独立部分，仅真正缺少权限、凭证或外部强制审批时上报主任务。

硬预算未设定；记录实际可用的 token/费用增量，不可用则注明。完整本地 gate 在最终候选统一一次，每个 PR 仍遵守已有 CI 门禁。记录证据：commit、base SHA、命令、环境、结果、回滚方式。任何 API/状态/迁移决定需同步给父任务，后继从已合并契约继续。

## 最终验收清单
- A01–A18 均有对应子任务、当前代码证据、实现/产品定义/条件风险分类和结果。
- 16 个子任务 PR 及主任务收口 PR 已合并；仓库无本族遗留冲突/失败 CI/意外重复 PR。
- MySQL业务故障窗口、PG采集、Cron运行跟踪、部署慢初始化/探针、恢复与回滚证据对应最终代码。缺失必需检查不得标整体通过。
- D1 单实例、D4 人工恢复、D5 个人/会话Memory等限定准确；外部认证/真实付费模型未执行则明确标注。
- 所有修改遵循项目规则，没有带入用户脏文件；历史生产数据只交付可审阅 dry-run，没有擅自执行清理、部署或发布。
- 所有任务与 PR 的元数据/链接可追踪，巡检停止，累计资源统计不重置，不虚构遥测。

## 已建立的 Multica 任务索引
主任务：MAX-107（01a0fff7-8104-77ca-ab31-862e687924b6）。项目 Slide；所有任务均由 15astra 负责。

|工作包|任务|stage|直接前置任务|
|---|---|---|---|
|W01|[MAX-108 — [10月审计 W01] LLM 凭证目的地址绑定与测试授权](mention://issue/01a0fff8-6c4d-793c-a4cc-bcc201b36733)|1|无|
|W02|[MAX-109 — [10月审计 W02] Cron 执行主体、资源范围与撤权校验](mention://issue/01a0fff8-7a86-71d6-822d-0a337adf453e)|4|MAX-108|
|W03|[MAX-110 — [10月审计 W03] PG 统一解密与 Schema/索引连接释放](mention://issue/01a0fff8-87a3-71f8-bb4f-f4346468dfe0)|2|无|
|W04|[MAX-111 — [10月审计 W04] Cron 触发 ID 与启动指标质量误标修复](mention://issue/01a0fff8-92a8-7586-a78e-05329bc928d9)|5|MAX-108、MAX-110|
|W05|[MAX-112 — [10月审计 W05] Cron runId、业务完成协议与页面跟踪](mention://issue/01a0fff8-9d6b-788f-a9b6-b431e7af980f)|6|MAX-109、MAX-111|
|W06a|[MAX-113 — [10月审计 W06a] 报表 occurrence 恢复与通知 outbox 原子提交](mention://issue/01a0fff9-085f-771b-9da7-41d527ec0a61)|8|MAX-112、MAX-115|
|W06b|[MAX-114 — [10月审计 W06b] 分析任务持久派发、恢复与未知结果治理](mention://issue/01a0fff9-1376-7a10-926f-9e9caf411813)|9|MAX-113、MAX-115|
|W07|[MAX-115 — [10月审计 W07] 启动期续租、就绪探针与 Compose 配置透传](mention://issue/01a0fff9-1e88-7254-ba21-8ed38072908b)|7|MAX-112|
|W08|[MAX-116 — [10月审计 W08] AI 冻结证据、引用校验与实际执行来源](mention://issue/01a0fff9-2a62-708e-8451-de9842575ae1)|10|MAX-114|
|W09|[MAX-117 — [10月审计 W09] Metrics V2 保留维护接线与引用保护](mention://issue/01a0fff9-fefd-7074-8d6d-27a8e17c4635)|11|MAX-113、MAX-115|
|W10|[MAX-118 — [10月审计 W10] 事件流转事务与人工恢复确认审计](mention://issue/01a0fffa-197b-7388-9fd2-6c28b2299c4c)|12|MAX-116、MAX-117|
|W11|[MAX-119 — [10月审计 W11] 实例删除、任务失效与连接释放生命周期](mention://issue/01a0fffa-295f-7726-ab2b-7efb2856b7e2)|13|MAX-109、MAX-112、MAX-114、MAX-117、MAX-118|
|W12a|[MAX-120 — [10月审计 W12a] 工作队列观测、阻塞测量与有界调度](mention://issue/01a0fffa-3a9e-7a51-8022-f76a65176e00)|14|MAX-119|
|W12b|[MAX-121 — [10月审计 W12b] Memory 只读快照与容量基线](mention://issue/01a0fffa-4abd-7d1a-a25e-070a6780ebd7)|3|无|
|W13|[MAX-122 — [10月审计 W13] 诊断界面证据解释与运行状态体验](mention://issue/01a0fffa-5a52-7f36-a026-75f8babcfaf1)|15|MAX-112、MAX-116、MAX-118、MAX-119|
|W14|[MAX-123 — [10月审计 W14] 全链路故障验收、迁移回滚与整改收口](mention://issue/01a0fffa-6f9b-7e8f-a18e-fec76c8faa97)|16|MAX-120、MAX-121、MAX-122|

[原技术复核（仓库归档）](2026-10-03-audit-remediation-plan.md)

原实施附件的串行修订以本文 v2 和 MAX-107 当前正文为准。
## 持久调度配置与 CLI 约定
巡检规则 ID：01a0fffc-59da-7905-92f6-2c10a730ad2d；issue ID：01a0fff7-8104-77ca-ab31-862e687924b6；agent ID：45c6e088-9615-48ae-a675-f91d1447c25e。此规则是同一工作流的可恢复调度器，不创建新 agent。

首次运行或从用户明确暂停中恢复时，用完整参数更新此既有规则以启用：

```bash
/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica --profile desktop-api.multica.ai --workspace-id b8b48997-9774-43ab-bd3e-f53fbd8f8fe6 issue wakeup update 01a0fff7-8104-77ca-ab31-862e687924b6 01a0fffc-59da-7905-92f6-2c10a730ad2d --kind every --every 10m --mode continuous --max-fires 1000 --expires-in 168h --agent-id 45c6e088-9615-48ae-a675-f91d1447c25e --instruction '审计整改主任务巡检：读取 MAX-107 最新正文、metadata、children、active runs 和 PR，按 v2 巡检协议自主推进；已完成、取消或明确暂停则禁用规则，无变化静默 checkin。' --output json
```

回读 wakeup list/get 确认 enabled=true、间隔600秒、agent正确。到期前按正文规则续期；完成/取消/明确暂停时 disable 此 ID。不要创建并行重复的定时规则。

CLI 的 issue.metadata 对象值在本版本中可能作为 JSON 字符串返回。读取 audit_orchestration / audit_execution 时，若值为字符串先 JSON.parse，再读取 state、stage、dependsOn；更新前保留现有键和累计资源。不得把原始字符串当对象，或因解析失败默认为任务完成。

stage 屏障是粗粒度依赖，audit_execution.dependsOn 是直接前置的 UUID 数组；两者必须同时满足。子任务的完成交付须同时满足 PR 合并、验收证据和 owner 记录，不依赖正文中的编号推算 UUID。

## 已授权串行启动条件（优先于旧附件的并发调度规则）
用户于 2026-10-03 明确要求设置启动条件并依次串行调度；本次配置和启动已获授权。顺序：

MAX-108 → MAX-110 → MAX-121 → MAX-109 → MAX-111 → MAX-112 → MAX-115 → MAX-113 → MAX-114 → MAX-116 → MAX-117 → MAX-118 → MAX-119 → MAX-120 → MAX-122 → MAX-123。

启动门槛：父任务未暂停/完成/取消；全家族无其他活跃子任务；当前项为最小未验收阶段；全部前序与业务直接前置的 PR 已合并 main 且验收通过。只有首项无需前置。所有子项初始 backlog，不得批量激活。父任务自身已有其他活跃 run 时不重复派发。

驱动方式：首次显式 rerun 主任务；每个独立 stage 完成原生唤醒父任务；既有每10分钟巡检兜底，保留168小时期限与1000次上限。提交 PR 后可按需为当前子任务登记 until-pr checks 单次唤醒，agent-id 指向15astra，instruction 要求先读取 MAX-107 串行调度协议并以父任务负责合并的规则续接；CI完成不等于验收完成。主任务不得把自己最后一轮评论当持续进程；保存状态并用持久 wakeup 续跑。没有变化不重复评论。

阻塞时保持当前项并记录原因；可做当前项独立验证，不派发后项。子 run 完成不代表业务完成。八项当前 head CI、审查、合并与验收门禁保持。全部16项及收口PR完成、取消或用户暂停时停止巡检。巡检读取 schedulingMode/maxActiveChildren/serialOrder，禁止恢复旧并发3项设置。
