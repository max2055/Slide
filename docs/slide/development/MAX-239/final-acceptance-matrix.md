# MAX239 最终集成验收映射

本矩阵对应唯一 PR570；实际 source/head/base、逐对象审计、执行输出与附件哈希由最终交付包固定。产品运行代码以已接受 source `c33712d9fe263a1873b92d6e6524119cb15894fe` 为基准，本次只补选择器和编辑模式回归及证据映射。历史文档中的实机/通知待验证结论按成员最新决定及本矩阵解释，不重新启动已接受阶段。

## 用户入口与适用验收

| 验收/公开入口 | 当前实现与可执行证据 | 既有证据及边界 |
| --- | --- | --- |
| 资源配置选择授权模板、注册指标 | `native-template-configuration.ts`；`templates/binding-service.ts`；现有 probe/trial/apply 路由 | MySQL、VM 和 SNMP 正常绑定/试采/应用证据；不预种事件 |
| 模板结构化触发器编辑/发布 | `template-trigger-editor.ts` → `templates/:id/triggers`；`triggers/publication.ts` | 浏览器编辑/发布嵌套 AND/OR；规则/模板固定版本、hash、参数来源 |
| last/avg/min/max、比较、窗口覆盖 | `metrics/triggers/evaluate.test.ts`；`templates/trigger-flow.mysql.test.ts` | last/avg 真实正常 writer；min/max 新增完整覆盖与缺口负例为纯评估器层级，不称额外实机测试 |
| 编辑模式语义保持 | `template-trigger-editor.test.ts` | 只提供结构化编辑，不提供自由表达式/Zabbix模式；嵌套规则重开、AND→OR→AND 发布保留所有子项/窗口/独立恢复/参数/nodata；组合规则禁止静默退为首个比较 |
| 受限 AST 与预算 | `contracts/metrics/triggers.ts`；`triggers/resolve.test.ts`、`compile.test.ts`；publication 测试 | 语法白名单、深度/窗口/序列/预算限制；不执行 eval，不做 Zabbix 兼容 |
| 独立问题 >90 / 恢复 <70；95/85/60 与90/70边界 | `templates/trigger-flow.mysql.test.ts:409`；`triggers/evaluate.test.ts` | 受控正常正式 writer + Lit/Fastify/MySQL 完整链；不是目标负载数值 |
| pending→applied 与正式 sample/attempt/source-check 身份 | `scheduler/store.ts`、严格 applied codec；collect-now/config-state 测试 | 真实 MySQL/VM 与真实 UDP SNMP 都经过唯一 `writeTemplateResults`；第二次正式采集保留原 applied envelope 和历史证明 |
| 缺测/过期/单位/质量未知且不恢复 | `templates/trigger-flow.mysql.test.ts:576`；SNMP flow 测试 | 纯 avg 中间 null、长短混合窗口、单位/质量拒绝；UDP NoSuchInstance 正式 null、真实墙钟 stale |
| 显式 nodata 不等待新样本 | `alert-engine.ts` → `evaluateTemplateClock`；`trigger-flow.mysql.test.ts:576` | 正常 applied 健康样本后独立时钟评估产生 nodata episode；不是普通缺测自动恢复；无新 worker |
| 水位线/迟到/重复评估/消息 | `triggers/runtime.ts`；正常 writer 集成及 browser fixture | 旧样本不恢复、不重开、不追补历史通知；锁与唯一键持久幂等 |
| 真实跨进程重启 | `e2e/max239-flow.browser.ts`、fixture | source `1f4b8554`：原 API PID99491退出，新99504重连同库；同 episode、恢复1次。相关运行代码未变的 blob 对应关系见最终证据包；不是 new store 模拟 |
| 事务与中断回滚 | `alert-event-service.ts`、scheduler store；`trigger-flow.mysql.test.ts` | 正式观测/applied/episode/event/workflow_jobs 同连接事务，故障注入均回滚；没有第二 writer/账本 |
| 90→95 历史仍90 | `template-event-evidence.ts`；browser `business-evidence.json` | source `1f4b8554` config1→2，opening阈值90/当前95；原 sample/metric/unit/time/版本不改 |
| 活动/聚合/投递/异常四标签 | `views/event-center.ts`、`event-center.test.ts` | 真正 event-center 浏览器入口；旧 rules 导航兼容，不删除旧规则合法运行 |
| 详情事实/当时版本/当前配置跳转 | `template-event-evidence.ts`；`event-management.ts` | MySQL/VM/SNMP Lit 展示；原版本 drawer 与当前配置导航分开，真实 sample/attempt、单位、UTC、规则模板/config版本回读 |
| 确认只更新处理状态 | `template-events/:id/acknowledge`；正常 writer 集成 + browser | 同 episode保持 open、不执行操作、不创建投递；确认幂等审计；通用手工恢复拒绝模板事件 |
| 历史不可删除断链 | `alert-event-service.ts`、告警清理路径及回归 | 事务锁后拒绝模板来源或 episode 关联删除；非模板行为保留；不做真实对象删除 |
| 三类资源实时权限 | 生产共用 `server.ts` → `alert-event-access.ts` | Chief 六读取入口 Fastify+SQL-stub 独立负例；真实 JWT/MySQL/浏览器范围限制与 session撤权；NULL instance_id 不公开 |
| 请求/锁等待/最终事务撤权 | publication、binding、正式writer、事件服务授权检查及集成 | 请求403、锁等待session撤销401、查询期间撤权；审计/脱敏和主体资源/item/维度/版本隔离 |
| 数据库真实只读采集到事件/恢复 | `templates/real-collector-flow.mysql.test.ts` | source18d3dafb；episode `sha256:1dcc4f36c70cd1e7a943dafbec0694d805ee51a3ab5419403fdf62aadad4be28`；uptime自然越过固定隔离阈值；未写共享目标 |
| VM真实只读采集到事件/恢复 | 同 real-collector fixture，server:3 | source18d3dafb；episode `sha256:51be4c46214f23f60559894a132b88218f5f0faba7c6b7a197988d5d00bb4cf9`；SSH真实collector，自然越过固定阈值；未改目标负载/配置 |
| 网络协议完整链 | `templates/snmp-trigger-flow.mysql.test.ts`；`snmp-protocol-flow-20261101.md` | sourcec33712d9；v2c/v3 authPriv SHA/AES真实UDP、正常writer、同episode一次恢复；受控值，非硬件实测；按成员决定不等待硬件 |
| 协议失败与凭据保护 | SNMP flow、inventory-snmp、SNMP client/collector测试 | 超时、错误v3密钥实际超时、弱安全拒绝、缺OID null；只读取inventory protocol、加密凭据、导出脱敏；不假称能区分丢包和认证失败 |
| 通知 outbox/投递记录/回执 | 复用 `workflow_jobs`、NotificationDispatchScheduler、现有handler/记录 | 旧受控本地HTTP幂等证据可复用；正式外发验收为成员豁免，未启用通道或外发，不删除实现 |
| 桌面/焦点 | 原 browser 三尺寸及新SNMP v2 browser | 1440×900、1366×768、1920×1080，无主页面横溢，基本焦点；无人工听读门禁 |

## 已接受证据定位

| 阶段 | source / 安全head | 平台可访问附件 |
| --- | --- | --- |
| 混合窗口、边界、持久化、浏览器、历史/确认 | `1f4b85549a0d3ad31e2150cbd4f02a6f5583b086` / `0a7c2543568409cb8468c258a23b4b1cbace0941` | [报告](https://multica.ai/api/attachments/01a19278-c266-7bc2-9267-197157d00f34/download)、[证据包](https://multica.ai/api/attachments/01a19279-00a8-7195-8931-71de3be90ccd/download) |
| MySQL真实collector | `18d3dafb507a0ebb471f5bdd6efaffb91ed68bfd` / `0a9eec2e13b03c7665c025080fce799f769247fe` | [报告](https://multica.ai/api/attachments/01a1928b-1d95-704b-901c-7fd0827d145a/download)、[证据包](https://multica.ai/api/attachments/01a1928b-26fb-7410-9d7c-d088c39f5874/download) |
| VM真实collector、SNMP受控协议 | 同上 / `c33712d9fe263a1873b92d6e6524119cb15894fe`、`60c08bed178655957dd708101718d569b2588970` | 本任务已接受评论及各自附件；最终矩阵附件索引固定精确ID和哈希 |

## 集成与范围

PR570仍堆叠在MAX238安全基线b5c140c1。公开契约由生成器检查，配置历史正式writer继续传严格校验原envelope；MAX240 query/storage/formal-store读方法不修改。PR567先于570合并，不能仅切base掩盖冲突。main保护要求 `ci-gate`；当前 workflow 只自动响应main PR，堆叠PR checks为空不代表通过。最终包记录实际门禁结果，未完成门禁不得标通过。

本项没有授权生产部署/worker、共享3306写、实际解绑、目标运维或产品模型请求。通知豁免、网络受控协议验收是成员范围决定，不保留虚构外部阻塞。独立复核/验收/合并由Chief承接；开发方不merge、不标done。
