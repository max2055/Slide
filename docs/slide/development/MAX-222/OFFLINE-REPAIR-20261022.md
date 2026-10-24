# MAX-222 第5/6项离线整改

接续 Chief `CHIEF-REVIEW.md`，原 PR229 / head `a591c924`、运行 main `45fe437b`、历史 partial 及第1–4项证据均保留。本阶段产品模型调用授权为0；未启动新调查、未改 Provider/场景路由、正式绑定、共享服务或历史结果。

## 第5项：首批工具后上下文准入

从平台数据库的原 session `dd063819-d5fc-4b63-a9da-0453a78ecdbc` 只读提取 user 与七条 canonical facts（一个六调用 assistant、六个结果），经现有敏感数据过滤后保存回归夹具 `src/investigations/fixtures/ops-six-tool-20261021.json`。保留 messageParts、工具调用ID、当前工具轮 reasoning/_extra 及完整结果；没有制造成功结果。原事实与历史调查仍在原位置。

使用实际 OpenAIProvider 的投影及 wire 字节上界计数、全部七项现有 scoped 工具 schema、系统提示和运行时时钟，重现修复前 **11,586 > 10,880**。此为离线重建；早先报告 **10,976** 也是另一份诊断重建，二者均不是原始 wire 遥测。当前测试明确使用实际 Provider 的计数路径，不能用测试包装器缺少计数器时的11,628混充该结果。

根因：小工具回执也重复携带 `executeToolWithPolicy` 附加的完整 actor/request/ACL 审计信封。六结果原子批次受保护，当前没有可压缩的更早 assistant/tool 历史；重复审计信息占用了本就有限的上下文。

最小修复：仅在 Ops 成功小回执的临时模型视图移除 `policyDecision`。原 canonical/checkpoint/SQL 审计不改，观测字段、业务状态、质量/缺口、时间和数据完全保留；大结果原有持久引用/hash/bytes/缩小查询要求保持，失败对象与 System 投影保持。此信息属于执行器审计，不是模型的授权来源；实时授权和参数约束继续在执行路径校验。

同夹具修复后 **10,430 ≤ 10,880**，节省1,156，余量450；窗口16,000、输出4,096、额外余量1,024和最终 `assertFits` 均未放宽。回归通过真正 ModelStep 最终准入到本地记录接收器，核对六调用配对、七项schema、重复投影幂等、原事实/sourceHash未变，并确认额外20,000字节受保护输入仍在发送前拒绝。记录接收器不是 Provider，也不生成真实业务分析。

边界：只证明这份已确认失败的首批上下文可以继续准入；不保证任意后续工具批次都能容纳，不宣称真实根因分析通过。下一次正常产品入口复验须 Chief 新预留，不能重用已结算 r1。

## 第6项：生命周期链及迁移提示

确认的代码问题是定义级迁移审阅 `migrationItems` 永远产生 `CUSTOM_SQL_ACTIVATION_REQUIRED`，资源状态读取时没有结合已应用绑定。修复在配置状态读取层，仅对 reviewed custom_sql、精确 id/version/digest、application=applied 且 applied_revision=published_revision 改为 `CUSTOM_SQL_BINDING_APPLIED`；保留 reviewed 状态并明确要求另验正式逐指标值、质量及告警/宏。其他 pin、未应用、revision不符、blocked 定义均不转换。正式 pending/unknown/过期等状态不因此改变；没有写配置或自动迁移。

生命周期核查及准确前置：

- MySQL：`config/access.ts` 未提供可信 counter 生命周期；`database-transport.ts` 对 MySQL 使用普通 `bindDatabaseDriver`，不提供 `counterQuery`。`database/collector.ts` 只能透传来源 evidence.counter，无法从普通累计数推断可信 start/reset/flush。PostgreSQL 有独立 `postgresCounterTransport`，不能把其生命周期挪用于 MySQL。需可信 MySQL counter epoch/reset 来源及其采样一致性，再实现经审核的相应 transport；不得由当前时间或近似 uptime伪造 epoch。
- 服务器：正式 access 仅接入 `HostBlockDiscoveryCache`；其 `HostBlockDiscovery.read` 读取 boot_id/btime/diskseq 并显式令 interfaces={}。`packages/adapters.ts:hostCounter` 要求各接口的可信 epoch和观测时间，缺失时拒绝解析，因此网络字节/事件不能凭 boot_id 代替接口生命周期。需来自真实接口生命周期（含删除重建/清零）的可信识别与一致性采样。现有块设备 discovery不等同网络 discovery；本次不新增未经来源验证的网络能力。
- 上述为接入链尚无可信来源，不能靠配置切换补齐。保留 unknown/temporary_failure；没有弱化精度、counter准入或来源验证。容量 estimated/partial、慢查询累计gauge快照非速率，qps/disk_usage和宏迁移缺口继续保留。

旧采集证据仍是 instance1 rev4/applied4/gen4、server3 rev3/applied3/gen2，以及 main上的三个正式桶；历史 stale 桶不变。没有把离线修复或现有 fresh资源状态当作所有桶/全部诊断指标通过。

## 验证和接续

- RED：保留事实的首批准入回归在原代码失败；迁移提示回归在原代码失败。
- GREEN：受影响的127项 focused测试通过；Agent Core 36文件/708项通过；后端标准typecheck、Agent Core typecheck、contracts:check及security:scan通过。类型检查曾发现新测试静态引用包内文件越过API rootDir，改用现有测试模式的动态文件URL后标准命令通过，没有改tsconfig或绕过门禁。
- 较宽调查模块检查首次遇到本地多个隔离MySQL测试并发时连接关闭/120秒初始化超时，6文件失败、22测试失败、353通过、348跳过；不计为通过。失败套件另做串行复验，具体结果随交付附件，不将focused通过替代集成门禁。
- 第1–4项无新改动，复用原浏览器/截图、前端80项、后端36项、下载五格式200及IPv6/IPv4证据；未宣称本轮重新运行真实UI或候选Worker业务验收。
- 本轮产品调用0、输入/输出/缓存0、未动MAX-208账本；已知历史累计7,400/reserved0仅引用Chief结算。编码token/费用实测遥测不可用，子代理0。

整体验收仍未完成：需新预留后的正常入口真实调查及成果/用量一致性验收，以及上述可信采集来源前置。代码更新原PR229，未合并或部署；精确head、CI、串行复验结果和产物校验和以本轮交付回执为准。
