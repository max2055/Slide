# V23 正式来源执行包（source-execution-package-1）

本包沿 MAX-203 / 草稿 PR212。实施起点 bccdd0e3；适用范围是有界来源和准确待审计划的工程准备。当前阶段只验证本地隔离 SQL/合成传输，不连接 VM、mysql3308 或 mysql3306，不调用产品模型，不消费批准。父在非实现上下文审过准确 head、配置、定义和恢复材料后，按既有环境授权分配唯一写锁，才执行下文真实阶段。P07/P08/P09、实际双人 once 和 P12 长期资格保持原要求。

## 入口、持久边界与停止

所有命令从本候选根目录执行，使用 package.json 的 pnpm 版本。运行入口：

```bash
pnpm --filter slide-api exec tsx ../../scripts/qualification/v23-source-package.ts --definitions
pnpm --filter slide-api exec tsx ../../scripts/qualification/v23-source-package.ts --config "$V23_SOURCE_CONFIG_FILE"
```

第二条只消费部署者提供的0600普通配置文件及 `V23_SOURCE_TARGET_LOCK_FILE`，两者拒绝符号链接及超限输入。配置 schema 在 `apps/db-ops-api/src/operations/source-package/config.ts`，拒绝额外字段。锁必须由父实际分配后生成，包含 issue=MAX-203、operationId、配置**原始文件字节** SHA256、准确 git HEAD、target=`192.168.49.130:22/mysql:3308`、UTC expiresAt（覆盖本次deadline）。这是未来运行的锁交接材料；本阶段不生成一份锁自签放行。

单次配置：schemaVersion=1、UUID operationId、`slide_v23_source_<8～32位hex>` database、距开始最多600秒 deadline、phase（下表）、serverId=3、实际导入 instanceId、instanceHost（受审的127.0.0.1或192.168.49.130，端口固定3308）、actorId、serviceActorId、实际 sessionVersion、revisions（server/instance正式策略revision）、maxMetricJobs（1～12）、api（127.0.0.1的19000～19999端口）和完整P07 target。investigate/plan额外要求准确 investigationId/requestId。不能用示例主体或随机 ID 代替导入映射。每个新阶段使用新 operationId；已记录 ID（包括成功 ID）永不发送第二次。

`alertRules`必须绑定1～2个不重复的实际规则ID及metricName/operator/threshold/durationSeconds、完整dimensions（mount/device/fs_type）。只支持文件系统used/size字节指标，拒绝动态阈值和threshold_template。现有规则表没有dimensions列；受控入口把锁内维度作为内部参数传给**原ServerAlertEvaluator**，只评估准确规则，再沿原consumer做过滤/判定/告警写入。不是新表或第二套评估器；默认生产调用保持原行为。入口复核库中启用规则集合及实际参数，告警必须绑定相同rule/dimensions和新鲜窗口，未知不造采样时间。

`SourceControl` 先核 schema、DB UTC/会话时区，再持 schema 专属 SQL GET_LOCK 及原 `slide-singleton-workers` 外部租约。5秒续约/30秒租期；只精确 claim 本次 tick 或准确 request 产生的既有 workflow job，不扫描领取其他任务，不收回 expired-running、不retry、不dead-letter replay。intent以原 workflow_jobs 的 `qualification.source`、maxAttempts=1保存（无全局handler）。异常/取消/失租将准确任务及intent留为dead_letter/待审计；进程丢失则保留running/过期租约，也不自动续发。新入口见未完成/未知旧工作即拒绝。唯一例外是 investigate 可接自己明确指定、从未执行的准确排队request。

现有 workflow 表的可用时间是秒精度；精确 claim 最多等待该行1秒到期，不改时间，不选择另一任务。lease_owner保持原36字符UUID。`JobRegistry.execute`的 signal/workerId/fencingToken、调度器保留的SQL核权/claim及commit fence不被替代。步骤之间和采集前后复核完整资源授权与策略版本。

输出在 `/Users/max/Coding/40-Slide/outputs/2026-10-18-v23-source/<operationId>/`，目录0700、result.jsonl/api.log为0600；关键intent先落SQL，结果/audit写入并fsync。create返回的准确plan ID/version/contentHash在submit**之前**写入审计；submit丢响应也不重发。错误只输出稳定code，原始凭据/模型请求不写入产物。

| phase | 生产调用 | 边界及输出 |
| --- | --- | --- |
| collect | MetricScheduler.tick/register → MysqlScheduleStore(production) → JobRegistry.execute → 原适配器 → MetricFormalization | schema只能有两个受审资产/绑定。最多12个准确metric job；不改间隔、jitter、canonical状态。初次采集不是publication；后续真实采集才经原血缘接受/生产ticket发布。分别输出server/instance正式publication IDs/ready；ready=false不能进入对应后续步骤。不把mysql-basic就绪等同慢查询来源已验收。 |
| evaluate | 原 ServerAlertEvaluator → evaluateOperationalRule → 唯一正式consumer；DatabaseAlertBridge 的原事件接入 | 最多两个固定server规则，无通知渠道。必须有新鲜正式publication，准确一条active告警。显式调用一次原auto事件lane（仅此对象注入enable，不启全局自动循环），原service身份/资源界限/预算/事件幂等保留；用户入口同样重核ACL。交准确alert/event/investigation/request IDs。 |
| investigate | 原 InvestigationExecutor、createActorBoundToolRegistry、场景Provider路由 | 仅准确request对应的未发送job；独立入口先从专属schema初始化持久Agent策略，再显式loadPlatformTools，不启动完整Agent/worker/cron。初始化失败即停止，工具执行前重载持久策略并重核原effect/resource限制，原只读Profile、动态ACL、事务和canonical运行归属不变。P01唯一batch预算适配器在**真实HTTP发送前**原子预留，收到usage后结算；丢响应/缺usage终止且不能重放。原通用完成摘要不引用证据；本装配仅在completed之后，经原InvestigationResultStore可信写入端追加一版结果，引用该准确request/run下成功canonical工具回执，保留未验证根因和未确认恢复，不把模型文本当事实、不SQL插入证据。输出最新resultVersion、同request/run的准确证据引用。 |
| plan | 自启动真实API standby子进程、原JWT/live ACL、POST actions/plans及submit | 原ActionEnvironment、P06 PlanSources和事务内ACL/版本/证据到期校验保留。只create/submit；保存完整不可变计划、policy/verifier哈希和来源。确认执行表空、批准仍pending且used_count=0；没有review/execute入口调用。 |

生产采集只使用唯一 metrics store/packages/scheduler/formalization；`trialCurrent`不在本包调用链，不使用旧 collector 写入。`assertSourceInventory`拒绝其他资产/全局规则/通知渠道。正式源读取还核原formal store的sourceState、generation、revision、normalized与120秒新鲜窗口；unknown不补0。调查结果必须是最新版本；计划证据必须在该结果实际引用、同request/run、未过期且确实支持server3。本包不INSERT观测、告警、结果或证据，不以调查的额外资源补证据支持范围。

## 固定定义、注册与 P08 消费接口

审定对象是仓库中的 `definitions/policy.json` 和 `definitions/verifier.json` **包括结尾换行的原始bytes**。上述 `--definitions` 命令给出SHA256与完整计划verifier；不能格式化后沿用旧摘要。

policy稳定ID/version为 `v23-demo-restart-policy` / `1`；实际plan/签名manifest policyVersion=`v23-demo-restart-policy:1:<policy原文SHA256>`，使具体定义字节进入计划hash。verifier稳定ID/version为 `v23-demo-service-health` / `1`；definitionHash=verifier原文SHA256。固定before120s/readiness60s/observation300s/interval10s/maxExtraRestarts0/requireAllHealthy=true。定义规定 systemd active/running/MainPID、准确新InvocationID、HTTP18087/200和无额外NRestarts；缺失/陈旧/中断是unknown。

当前policy原文SHA256=`e07d022543752b03a79a37114db5e6ef616385dccfaa92f04167dd248e220e73`；verifier原文SHA256=`aadc090a2a559bae53502d42b160cd9b46bab9f7a4fc5771ec1c88fe8e3215e7`。任何定义字节修改都须重新审定摘要和注册。

注册仍沿 action-readiness-1 的受信Ed25519文件协议：`OPERATIONS_PILOT_MANIFEST_FILE`、独立受信公钥及专属SSH私钥引用。manifest签名消息是 `operationsContentHash(manifest)` hex 的UTF-8 bytes；target签名是准确target hash，不能混用。target保持已审历史协议：server3、192.168.49.130:22、slide-action、slide-action-demo.service、固定helper。历史绑定：

| 字段 | 已审值（仍须实际inspect，不表示已激活） |
| --- | --- |
| helperHash | 9eeef88558c46c7e2b380f79e7b21348a7be4ba619f47770f62127c0846eddd4 |
| unitHash | 905a161d6d6268458309213652e6e3afe85158a76aca1988e9293dcafdeb4495 |
| hostFingerprint | SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA |
| target_config_hash | 9dcc021fc26eca2adac13f07fc7c2ec6e3109bd7d7b42fbaa6b15265daa7ecab |

P08后续只消费准确计划的verifier对象和对应原始定义文件bytes，先重算definitionHash；样本绑定execution/plan/version、定义hash、原始时间和缺口。不能只接受同名verifier，不能把本包定义文件当作P08实现/效果验收。本包不新增P08 worker或验证完成记录，不等P08整包才准备来源。

## 时钟与期限

CLI每次远端步骤前使用原受信资源凭据/SSH host pin发送唯一固定只读命令 `date -u +%s%3N`，输出最多64字节、执行超时1秒；核VM UTC与本进程前后采样的最大偏差≤2000ms，RTT≤1000ms。DB以 `UTC_TIMESTAMP(3)`同样比较且session必须+00:00；plan前另用本专属API health响应的HTTP Date核API时钟。HTTP Date只有秒精度；2秒上限覆盖该量化误差，仍小于10秒最小验证采样间隔及120秒证据窗口。网络延迟也计入不确定性，超限即拒绝，不能用估计offset修正。

deadline最多10分钟；每次异步边界复核；host/API/DB的UTC不能互相“校准”造时间。真实计划最长10分钟，受P06证据期限及受信注册的有效区间进一步约束；注册validFrom/Until应覆盖整个计划而保持短期。现存VM时钟偏移尚未在本阶段解决：未来未解释/解决时门禁会拒绝，不能生成计划；不写VM/共享服务全局时钟、不回填观测。

## 本地 schema、最小配置与恢复

平台表只能放本任务的本机动态端口专属MySQL9.6容器，容器名 `slide-v23-source-*`，label=`com.slide.v23.source=<run短ID>`，只映射127.0.0.1动态端口。禁止平台DB端口3306/3307/3308。由环境显式给DB_HOST=127.0.0.1、DB_PORT、DB_USER、DB_PASSWORD和新的JWT_SECRET_KEY/ENCRYPTION_KEY；凭据引用父受控说明/钥匙串，不写脚本或附件。

```bash
pnpm --filter slide-api exec tsx ../../scripts/qualification/v23-source-schema.ts init "$V23_SOURCE_SCHEMA"
bash scripts/qualification/v23-source-snapshot.sh backup "$V23_SOURCE_CONTAINER" "$V23_SOURCE_SCHEMA" "$V23_SOURCE_BEFORE_CONFIG_DUMP"
bash scripts/qualification/v23-source-snapshot.sh restore "$V23_SOURCE_CONTAINER" "$V23_SOURCE_SCHEMA" "$V23_SOURCE_BEFORE_CONFIG_DUMP"
pnpm --filter slide-api exec tsx ../../scripts/qualification/v23-source-schema.ts verify "${V23_SOURCE_SCHEMA}_restore"
```

init只创建新匹配schema，正式MigrationRunner连续运行两次并记录全部ledger/checksum（含128/129）；existing schema不覆盖。snapshot仅访问带标记的专属容器、不接受目标host/port，输出必须在outputs真实目录、拒绝覆盖和符号链接，持有效worker租约时拒绝备份。mysqldump使用single-transaction/set-gtid-purged=OFF；restore只创建未存在的第二schema，核逐条ledger，再由verify运行正式checksum/invariant检查。恢复验证未通过不运行候选；工具不DROP任何schema，不启动API或worker。第二次配置后快照应使用另一个全新专属容器/schema做恢复，避免覆盖前一个恢复点。源/恢复两边还需比较下表配置映射及无业务队列，不能仅凭ledger判配置已恢复。

未来由原owner从已授权3306配置来源做一次过滤导入，只有配置读取；本阶段未做该访问。导入清单如下，具体ID由当次导出清单和父锁审定；不得从聊天示例创建“真人”：

| 数据 | 保留与过滤规则 |
| --- | --- |
| servers | 仅原server3，保留id3/host/22/host pin/实际OS适用性；原凭据解密后以本schema新key重加密。不能复制其他服务器。 |
| database_instances | 仅准确mysql3308记录，核host/3308/mysql/实际凭据和database；记录原id→本schema id。不得改成3306或其他DB；runner按锁内instanceHost/id复核。 |
| users/roles/user_roles/role_permissions/instance_permissions | 只原有授权人类actor和原有最小service身份/必要角色/准确两资源ACL与sessionVersion；保持真人/服务区别，不造人、不提权、不复制refresh tokens或活动会话。服务身份须满足原Investigation service许可白名单，admin会被原校验拒绝。 |
| metrics配置 | 原不可变registry已有linux-host文件系统、mysql诊断慢查询所需准确package pin/digest；由原policy publish/activate服务在导入资产上发布，保存resourceKey→revision与审计。不能复制旧schedule、source acceptance、rollout canonical或观测来冒充新来源。 |
| alert_rules | 先关闭MigrationRunner创建的默认规则；仅启用与alertRules精确匹配的最多两条server3文件系统字节规则。维度由受审配置绑定独立目录所在mount/device/fs_type，原单位/阈值/窗口明确、notification_channels=[]；不用全局规则或所有服务器通配。 |
| agent_security_policies | 必须导入slide-db-ops实际持久策略，保留tool/skill allowlist、allowed_effects、version、原updated_by审计和资源scope。记录原始JSON摘要及原资源ID→专属schema ID映射；只做等价ID映射，不把[]改null或增加权限。迁移默认version1不能替代已有策略；策略缺失或初始化错误不运行。Agent策略与行动policy/verifier是不同配置，均须审查。 |
| llm_providers/场景绑定 | 只有调查确需模型时导入3306已有deepseek-flash配置及其原场景路由；凭据重新加密。不能启用原停用Provider或换模型。无调用时不导入秘密以证明可用。 |
| 排除 | 原workflow jobs/outbox、批准及bindings、行动执行、session/checkpoint、调查/证据/结构化结果、观测/发布/事件、通知、cron、队列/预算表都不复制。产品预算始终从P01唯一canonical文件读，不以新schema预算初始化清零。 |

publish/activate沿原 `POST /api/metrics/policy/resources/:type/:id/preview|publish` 和 config activate接口（原JWT、expected_revision、package pin和完整overrides），先只读核catalog/inventory后提交准确请求。收集值只来自后续生产job。runner不提供任意SQL导入功能。每次发布/导入后更新配置文件、hash和父锁，核恢复点；运行期间不改这些配置。

CLI运行时要求 `METRICS_COLLECTION_ENABLED=false`、`INVESTIGATION_OPS_AUTO_ENABLED=false`、`OPERATIONS_ACTION_DISPATCH_ENABLED=false`、`OPERATIONS_STOP_NEW_DISPATCH=true`；计划阶段额外启用PLANS，其余功能按已审装配配置。无需克隆常驻worker。每阶段自己持外部租约，plan阶段先独占bind核端口空闲，再启动同cwd/HEAD的真实API子进程；记录PID→端口→cwd→命令→head→日志，必须同时看到自有日志API-only standby、存活HTTP成功及本入口外部租约有效；worker ready在standby按设计为false，不作为这个API子进程的就绪条件，业务验收以真实create/submit为准，拒绝重定向。只停止自己spawn的准确PID，先SIGTERM并收尾；不得按端口或可执行名强杀。stage结束清理SSH池/实例连接并释放自己的租约。

## 受控现场顺序与恢复清单

1. 父审准确head/CI、定义bytes/hash、过滤导入清单、schema两个恢复点、主机时钟依据后，把VM/mysql3308唯一写锁交原owner。锁仍released_unassigned时不能运行；不再向Max重索环境或逐包许可。
2. 按已审 `2026-10-17-p07-newhelper-q01` 的18文件前态manifest及checksums做**当前差异**核验，保存本次新增文件/权限/owner/ACL、账户authorized_keys/sudoers、helper/unit bytes、服务ActiveState/SubState/MainPID/InvocationID/NRestarts与18087监听前态。只针对本阶段新增疑点读核，不反复旧盘点。
3. 在外部租约保护的候选schema里先collect，核正式接受与publication，再evaluate；无正式源不注入。真实事件只使用既有授权隔离卷/目录（容量有上界、准确文件名）或mysql3308专属有界session；不填共享磁盘、不重启数据库/SSH/网络/VM。现有来源不满足规则就保留unknown和原始输出，不能SQL补值。
4. 运行调查前先读canonical `operationsProductBudget()`：全批1000万，缓存为输入子集，未知pending/停止或摘要失配均拒绝。HTTP raw body字节+4096保守预留输入、准确max_tokens预留输出；provider必须deepseek-flash、原配置、maxRetries0、固定HTTPS端点、非流式且redirect=error。50%报告/80%收敛/100%停止沿原P01账本，不初始化、不另分账。本阶段模型调用为0；未来由真实usage结算，不根据0调用推定批次重置。
5. 原P07负责人已交付的受限账户/helper/unit准确bytes只能按该审定材料恢复；本包不复制/接管其未合入实现。先验证本次inspect与host/helper/unit/config hash，**不restart**。受信manifest签入本文两定义hash及短有效期。准确来源由plan阶段发原JWT create/submit，保存完整结果及批准仍pending/0used证据。
6. 任何失租、hash/ACL/时钟异常、结果/usage未知即停止新阶段和注入。先核在途/未知与本任务jobs，保留不可变记录；没有明确结果不以新operationId重做该动作/调查。先恢复注入文件或有界session并核无剩余目标写，再停止准确API/连接；按18文件及新增差异逐项还原，只处理自己创建的unit/账户/端口/目录，最后核原账户拒绝、原unit not-found/inactive/MainPID0及18087无监听（若前态如此）。不得为了回退DROP平台证据表或重放动作。保留审计/数据库/备份供父查验，再由父释放写锁。

该清单是未来恢复执行依据；本阶段没有声称18文件已重新恢复或现场时钟已修好。本包不执行目标部署、故障注入或行动。父审来源/准确plan后，才交两位真实分离主体对准确不可变版本once；P07原owner接续Q02～Q18。P08仍等P07审定合入，完整P10仍等P07/P08/P09，不merge/done。
