# MAX-123 / W14 最终集成验收

## 执行契约 v1

基线 `origin/main@07536caf2c46a902d35e39613b6c6c2de631ed05`，包含前十五项串行整改；分支 `codex/MAX-123-final-qualification`。前置 MAX-122 的 PR #126 已合并，父任务记录八项 CI 与验收通过。本包汇总行为契约、补齐审计基线升级验收，并在最终候选运行一次完整本地门禁、隔离 MySQL/PG、浏览器、启动/恢复/备份资格检查。验收以命令退出码、真实持久化结果和进程故障证据为准。

不扩 HA、Oracle/达梦认证、模型质量认证、生产历史修复或发布打包；不修改用户 .env、服务、数据及其他工作树。外部不可获得环境单独记未验证。发现只重复空库启动而不做旧基线升级的 qualification 缺口，新增旧数据升级与兼容读取验证，复用已有故障窗口套件，不重写各工作包。

测试层级：新增升级/读取与真实 Cron 路由专项 → 受影响类型/契约检查 → 最终候选统一完整本地 gate → 当前 PR 八项 CI 交父任务核验。停止条件为本包 PR、证据交付并进入 in_review；合并由父任务负责，不 self-approve。

硬预算未设定；实际 input/cached input/output/费用遥测不可用。子代理 0、最大深度 0、代理并发峰值 1。资源统计不把测试进程当代理，不将缓存重复计入总吞吐。

## 验证证据

2026-10-04（UTC 10-03）在 macOS arm64 / Apple M5、Node 24.18.0、pnpm 11.19.0、Docker 29.7.2 执行。隔离 MySQL 8.4.10 / PostgreSQL 16.14 容器均用动态 localhost 端口、临时库、假凭证；浏览器为 Chromium；模型/SMTP 仅本地测试接收端。新测试服务的 PID 直接指向 Node，不依赖 pnpm 孙进程清理。回读未发现本轮测试容器或服务残留，原用户容器未操作。

完整 gate 入口：`bash scripts/qualification/run-audit-integration.sh`。实际证据保存于同目录 `2026-10-04-max123-integration-evidence.json`（命令、退出码、环境、代码/日志 SHA-256、首次失败及修复记录），未把原始失败抹成通过。首轮 22 个检查中 21 个通过，最后一项暴露下节夹具问题；修复后仅重跑最后一项及 API typecheck/改动文件 lint，最终所需检查全部通过。没有重复完整 gate。

代码 checkpoint：完整 gate 起点 `f4efaa0b3bb8b550112e6f67f5a3f8bfcc0be63b`；gate 期间 `dd79ee011cd06eb08a9bd933f88e7b33956ad95d` 仅将既有真实启动质量套件加入最后一个专项，前面检查涉及代码未变；最终修复代码 `03b6be94`，只有 Cron 测试夹具变化。最终文档/receipt 提交不改变已测代码与配置。已通过的来源、业务、构建与浏览器证据按规则复用。

|检查|实际结果|
|---|---|
|`pnpm -r test`|API 3015 / frontend 574 / agent-core 654 / sandbox 22 通过，共 4265；API 251 + sandbox 4 环境跳过，跳过不计通过|
|四模块 `pnpm -r typecheck`、`contracts:check`|通过；没有公共 API/DTO 改动，不需要更新生成物；夹具修复后 API typecheck 再通过|
|lint、build/CSP、qualification matrix、audit、scan|全部 exit 0；lint 262 warnings/0 errors（改动文件 0/0），matrix 37/37；依赖无已知漏洞；保留既有 chunk 提示|
|`test:browser`|56/56，通过桌面/375px、键盘/ARIA、缺权限/缺数据/超时/unknown/旧结果、Cron 并发/离线/刷新/卸载；仅 fixture HTTP 的部分单列为 UI 行为，不冒充服务链路|
|runtime deterministic|exit 0，受控恢复预算/丢弃候选/鉴权拒绝/取消；不调用真实模型|
|bootstrap-upgrade|115 migrations 空库 + 两次初始化；新增 1/1 真基线升级/保留结果/两次恢复/快照 rollback/再升级|
|failover + startup|均 exit 0；真实慢初始化 >35s、两个 API 一个后台、备用 ready/trigger 503、不自动接管、dispatch 权限损失降级/恢复、MySQL pause 超时 fail closed、正式 Compose 五开关实际透传|
|reports|15/15，真实子进程四个退出窗口、三个写失败 trigger 原子回滚、过期 owner/fencing、SMTP 已接收后丢响应 unknown|
|analysis|41/41，七个真实 SIGKILL 窗口、可能收费不自动重试、completion/usage/引用、实时撤权、旧入口无法绕过 durable identity|
|retention / events / removal|33/33、28/28、8/8，均真实隔离 MySQL，无跳过；保留/人工确认/删除生命周期各自事务及重试边界|
|backup-restore|exit 0；mysqldump 恢复后 schema/ledger/user/instance/event/operation/workflow invariants 通过|
|stability|exit 0；并发幂等队列、实际 fencing/共享资源互斥/lease-loss/重试/死信/取消，以及有界并发3时慢报表10s、通知1013ms/采集1012ms内启动；非生产 SLA|
|PG|7/7，真实 PostgreSQL 16.14 / MySQL 控制库的 CBC/v2/无默认库/错误密文/失败清理；SCRAM 假账号|
|修复后的 Cron/runtime/browser 专项|33/33（Cron API28、新装/106升级2、启动质量3）；真实 MySQL/WS runtime + 14/14 审批执行；live Cron 浏览器1/1，202/runId → durable completion → 刷新同一运行，未再次 POST|

同一 PR 的八项 CI 包含 release-artifact（由已有 CI 执行），本地不构建发布包、不部署、不发布。CI 仍需按交付 head 单独核验，不能由上表替代。

## 失败复现与最小修复

首轮最终联合专项在真实 MySQL 复现 11 failed / 22 passed：`CronAuthorityService` 查询 `database_instances.lifecycle_state`，Cron integration fixture 仍只建 id/name，迁移只装配到107。W11已合并后的授权查询是正确的，完整初始化及真实 Cron 页面已通过；失败属于相关既有夹具漂移，当前必需跨包验收不可跳过。

`a08b36d5` 让夹具执行现有111迁移后，旧位置 INSERT 因新增列数量变化而失败；`03b6be94` 将同一夹具 seed 改为明确 `(id,name)` 列。最终33/33、runtime/审批14/14、浏览器1/1通过。未改授权代码、删断言或禁用失败用例。此修复直接恢复 A02/A05/A08/A12 的真实验收，未扩无关架构。

未验证项：Oracle/达梦真实环境、付费模型诊断质量、生产 HA/规模/SLA、完整正式镜像部署、生产历史修复与真实 retention apply、VoiceOver/NVDA 软件认证。D1单后台、D4人工确认、D5个人/会话Memory默认关闭等支持边界仍成立。

## A01–A18 行为验收索引

本表索引具体行为与本轮执行入口；“修复”指工程实现，“产品定义”指明确承诺边界，“条件风险”指仍需要外部环境或生产规模证明。所有路径相对仓库根目录。最终结果在上节列出，跳过项不算通过。

|项 / 工作包|分类与可观察契约|最终验证入口|
|---|---|---|
|A01 / W01|修复：无管理权限或目的地址不匹配时，保存 Key 不读取、不外发；重定向不携带 Key|`src/llm/credential-destination-policy.test.ts`、`model-discovery.integration.test.ts`，`llm-scenes.spec.ts`，完整 unit/browser gate|
|A02 / W02|修复：Cron 仅使用服务器认证 owner/触发 Actor；当前资源授权撤回即拒绝，legacy owner-required 停用|`cron-mysql.integration.test.ts`、本包 `audit-upgrade.mysql.test.ts`，cron-runtime-browser / bootstrap-upgrade|
|A03 / W06a/W06b|修复：报表 staged 内容/outbox 原子恢复；分析发送前可恢复、可能已收费则 unknown，显式重试关联旧 ID|reports / analysis 专项，含真实退出、SIGKILL、故障 trigger、假 SMTP/provider 接收端；bootstrap-upgrade 验证旧结果|
|A04 / W03|修复：PG CBC/v2 用统一凭证读取，损坏密文明确失败；临时客户端各种失败均释放|`run-pg-collection.sh` 的真实 PostgreSQL/MySQL 7 场景，加 Schema/索引调用方单测|
|A05 / W05|修复：POST 202 的 runId 与同一 MySQL intent 绑定；页面仅跟踪该次运行，刷新不重发|Cron API 30 场景、`cron-live.spec.ts` 真实 REST/MySQL/browser、`cron-runs.spec.ts` 并发/离线/卸载|
|A06 / W07|修复 + 产品定义 D1：启动慢依赖仍续租；只有一个后台实例；备用 API 只读角色 readiness 503，不承诺自动接管|startup 真实进程/DB pause/权限损失；failover 证明 fencing，而非 HA 承诺|
|A07 / W08|修复 + 条件风险：冻结授权证据、引用/主体校验、真实执行来源与部分 usage；模型成功不证明诊断正确|analysis MySQL 真派发/保存/假模型请求，`analysis-evidence-binding.test.ts`；付费模型质量未认证|
|A08 / W04/W05|修复：手动工具关联真实 job/run ID；业务 completion 工具保存证据，普通最终文本不能成功|`cron-run-contract.test.ts`、`cron-mysql.integration.test.ts`、真实 Cron 浏览器|
|A09 / W09|修复 + 条件风险：生产装配保留维护、dry-run gate、当前引用保护、提交后重试不复活 payload|retention 真实 MySQL 专项；生产规模与真实保留期 apply 未验证|
|A10 / W12a|修复 + 条件风险：有界分车道和资源互斥、可观测队列；10 秒慢报表不阻塞通知/采集|stability 调用 `assert-bounded-queue.ts` 真实队列测量与 `bounded-worker.test.ts` / `worker-runtime.test.ts`；不声明生产 SLA|
|A11 / W10|修复：流转 current state、transition 与 outbox 同一事务，错误回滚、版本 CAS 防冲突|events 真实 MySQL 流转与失败注入|
|A12 / W11|修复：删除为 tombstone，接入点 fail closed，迟到写入拒绝，释放失败可重试且保留历史|removal 真实 MySQL，bootstrap-upgrade 验证旧实例 available 与历史保留|
|A13 / W04|修复：启动指标准确/估算/NULL 保留，不批量重标历史质量|`src/lifecycle/metric-quality-startup.test.ts` 真实 MySQL 首次/重复启动与 dry-run 导出，cron-runtime-browser 阶段；不泛化为远程库认证|
|A14 / W12b|修复 + 产品定义 D5：Memory read-only 快照、个人/会话/显式共享、默认关闭|`memory-retrieval-eval.ts` 既有容量基线、agent-core Memory/检索完整单测；不承诺团队知识库/跨主机|
|A15 / W07|修复：正式 Compose 使用 ready 探针，五个 Memory/metrics 开关实际传入容器|startup 脚本正式 Compose render + 实际 probe container；正式完整镜像部署未验收|
|A16 / W13|修复：对象/证据时间/缺口/下一步可见，原始 ID/JSON 仅详情|`resource-diagnosis.spec.ts` 桌面/375px、键盘/ARIA/failure/旧结果；真实读屏软件未认证|
|A17 / W10/W13|产品定义 D4 + 修复：恢复明确为人工确认，保存人/时间/原因；unknown 重试提示费用|events MySQL + diagnosis 浏览器；不声称自动恢复检测|
|A18 / W14|修复验收缺口：真实基线升级、旧读取、快照回滚、真实 Cron 页面链路和一次最终本地 gate|`run-audit-integration.sh` 与本包文档；当前 PR 八项 CI 由父任务按 head 核验|

## 迁移、历史处理与回滚

本包不新增 DDL、公共 API/状态协议，不重写 000–111 的 checksum；只补资格检查与动态测试端口。基线 7916d44 的 108 个 SQL 文件通过累计 SHA-256 固定，当前分支与该 git tree 的文件完全一致；hash 仅验证夹具来源，验收通过仍来自真实 MySQL 行为。

本轮迁移集合为 105 owner/scope、106 runs、107 run_id collation、108 report occurrence、109 analysis dispatch、110 retention、111 instance tombstone。演练顺序：旧 SQL 集建立库 → 保存旧实例/Cron日志/分析/报告/occurrence/metric → mysqldump 快照 → 现有 runner 升级 → runner 再启动 → 当前存储读取 → 两次恢复 → 快照恢复到另一新库 → 旧 runner 重启 → 再升级。旧 running 报表没有自动绑定 durable job；分析不确定结果保留为 unknown；旧 runner success 没有追认为业务 completion；旧 ownerless Agent 停用，没有代入管理员。

上述演练证明**迁移前快照**恢复，不证明可以在生产有新写入后无损降级。生产回退必须先停新触发/后台工作，保存在途 run/dispatch/occurrence、投递与保留审计，排空可确认任务，将发送状态不明者保持 unknown；DDL 保留，旧代码不理解新 job 类型时不得恢复调度。只有经核对的备份与增量恢复方案才能恢复数据库，不能 DROP 新表或直接逆向改状态。支持单后台实例，备用实例不自动接管。

历史修复入口沿用各包 dry-run：Cron `GET /api/cron/jobs` owner-required 清单、`apps/db-ops-api/scripts/report-recovery-dry-run.ts`、`analysisRecoveryInventory(pool)`、retention dry-run last_report。其输出需要具体清单确认与备份，本文不授权批量 owner 绑定、unknown 重试、发送或删除历史 payload。真实历史数据未操作。

回滚本包测试接线可 revert 本包提交，不删除已有业务字段或数据。若要回退整改实现，逐项遵循各包验收文档中的兼容与停调度要求；不能通过撤销权限/目的地址/completion 校验恢复旧入口。

## 前十五包追溯

以下 head/merge 来自父任务已核验记录；全部 merge 均实查包含于本包基线 main。新门禁在相同最终代码上补验，旧文档的用例数不能代替本包结果。

|包 / 任务|PR|被审查 head SHA|main merge SHA|父任务验收|
|---|---|---|---|---|
|W01 / MAX-108|[#112](https://github.com/max2055/Slide/pull/112)|`a5a01b89634a3f22c030f9e6c3f040ca4d4620a3`|`403e1f1fa829413db92b11bb6cb60c9189b3f866`|passed|
|W03 / MAX-110|[#113](https://github.com/max2055/Slide/pull/113)|`c68d165dabce2155fa78a352991ced0ded2258d1`|`aa270fb013ced5ad511482a7ffea3f22501dffea`|passed|
|W12b / MAX-121|[#114](https://github.com/max2055/Slide/pull/114)|`f0a554eb19f2373105f46ce67034b7b61512dbad`|`70a02789ad5e900883f97e90636d83ffb4730f77`|passed|
|W02 / MAX-109|[#115](https://github.com/max2055/Slide/pull/115)|`d6c00932bd06f9af53fe02e654dad6f0804abe3a`|`263c22aa05f1abce2c3518469c487e4d6a35e4a0`|passed|
|W04 / MAX-111|[#116](https://github.com/max2055/Slide/pull/116)|`019e5a26b5d55bbf0b6677a5f80736c76ea6c54f`|`265befcf92ef626bf929c668a83fc61f606e4c54`|passed|
|W05 / MAX-112|[#117](https://github.com/max2055/Slide/pull/117)|`4cf4c7f50d005c23976ddb4175a785c54c65b38d`|`6faff9dbd6fb7213a86c2fa959abed9809ee52fb`|passed|
|W07 / MAX-115|[#118](https://github.com/max2055/Slide/pull/118)|`09bc0037dd856a803322684cc21e5f10893c8570`|`1b276ac72264d1e260f4d74ef50a747c50d2a747`|passed|
|W06a / MAX-113|[#119](https://github.com/max2055/Slide/pull/119)|`ea9d666fb9dff95bc2230a936121b76da8e8a4b1`|`db4b7d0515a31a5c733fed5ade81a286510fc823`|passed|
|W06b / MAX-114|[#120](https://github.com/max2055/Slide/pull/120)|`22f90b17c1829922b563500c6f0807ec4bd7dd4a`|`8fe05fc0676e80eb4c01ff6589eecba0f9b13f36`|passed|
|W08 / MAX-116|[#121](https://github.com/max2055/Slide/pull/121)|`ab8b29f4fdb76a779c770f8233f955bbddfb122b`|`e4b2624c51ab4166cae9823f47885303174bde30`|passed|
|W09 / MAX-117|[#122](https://github.com/max2055/Slide/pull/122)|`41c60ae78339fb84e1e65b545e93913a4a05da54`|`561d0cdd95ddf042f047a51c0780c92d808b3b47`|passed|
|W10 / MAX-118|[#123](https://github.com/max2055/Slide/pull/123)|`34e2aa1943c11a73d8408e634d5de28b83ca6b00`|`080b2c6b6f4996e4cff4dfe2055bdeabd96827b8`|passed|
|W11 / MAX-119|[#124](https://github.com/max2055/Slide/pull/124)|`f83747f90b0edd24ec183f166001f1be5b22ea8f`|`4caeaecf32cd1f0d08c2b7ac7b68deaa0a4b3504`|passed|
|W12a / MAX-120|[#125](https://github.com/max2055/Slide/pull/125)|`0360101d8ab3d046b3f5453d3b6540e9d11debaf`|`1b6d5dc2d9121b636f3180573199e4c570a78e3d`|passed|
|W13 / MAX-122|[#126](https://github.com/max2055/Slide/pull/126)|`345cf4829210fa15ba05a4084a7e6dfcc954b301`|`07536caf2c46a902d35e39613b6c6c2de631ed05`|passed|
