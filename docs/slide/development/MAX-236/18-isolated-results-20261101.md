# MAX-236 完整隔离验收（2026-11-01）

650资源完整受控流程通过，提交复核；已接受的R3旧阶段保持。安全PR发布方式尚待解决任务入口的祖先约束，不能推送已有风险历史。PR359属于MAX-241，本轮未修改。

## 源码与复现

测试任务源码：`64a603275a728014ac3d09906cacebce74e859c1`。配置来源 `b5c140c1d646bfb5581ff88da7498b4793e7322d`，事件来源 `0a9eec2e13b03c7665c025080fce799f769247fe`，公共祖先 `88fc15e2bce814218ff2f1836a33d57ff236eef6`。装配及完整入口见 `17-isolated-workflow.md`，不覆盖MAX-238/239/240产品文件。

完整测试1/1通过，Vitest elapsed393.97秒（测试体391.01秒），正式绑定650资源setup50.64秒。平台MySQL8.4；受控目标500 RHEL、100 MySQL9.6、50 SNMPv2c。每资源1个uptime指标、1个无标签序列，周期60秒、短时保留全部数据、作业预算30秒。依次并发1/2/4，每档两轮95→20，走既有探测、试采、绑定、队列、writer、历史读和事件事务。transport返回固定受控数据，无远程采集，使用真实时间。

## 容量曲线

| 并发 | 两轮elapsed秒 | 端到端jobs/s | 两轮排空jobs/s | worker p95毫秒 | 组合历史读p95毫秒 | Node RSS峰MiB | 积压峰/末 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 99.28 | 13.09 | 15.81 / 15.63 | 78.33 | 10.19 | 339.0 | 650 / 0 |
| 2 | 108.12 | 12.02 | 14.07 / 13.43 | 93.73 | 14.37 | 318.9 | 650 / 0 |
| 4 | 116.46 | 11.16 | 13.28 / 11.67 | 113.23 | 18.75 | 325.6 | 650 / 0 |

端到端包含入队、排空和逐资源读取；组合历史读包括collect.task与readConfigurationAt，不能当作单SQL延迟。RSS为进程采样峰值；Docker CPU/内存为各档末尾即时快照。原始JSON另含CPU用量、MySQL计数、p50/max和每轮耗时。提高并发没有提升本次吞吐；同机其他负载、数据库争用、串行入队和读取开销均可能影响，未作因果归因或线性外推。

## 一致性与正式数据副本

六轮3900条normalized样本、3900个正式采集任务，样本ID无重复；同caller key重放未产生新任务。650个head、1950个问题事件/episode全部恢复，恢复更新同一事件；1950条恢复日志另有断言。每档2600条observations包含raw与normalized两层，不能将7800行当成7800次采样。无通知渠道，notification.deliver任务为0；未验证外部投递。

将本次正式数据182张表复制到独占schema `max236_reala_copy`，只在副本通过正式采集刷新代表数据库capability。重复preview一致且不写；审计INSERT注入失败返回rejected/committed=false，绑定、revision、审计及保全摘要不变。正式apply升到revision2；同key重放无新审计；stale revision被TRANSACTION_REVISION_CONFLICT拒绝；正式trial/apply回退到revision3，原pins/package/group/overrides完整恢复，revision1历史读保持一致。

13张表全内容摘要前后一致，覆盖observations/publications、trigger head/episode、alert_events/alerts、instance ACL、数据库/服务器资源和设备凭据、旧网络/服务器/数据库历史。摘要在workflow.json，不导出密文内容。旧R3真实MySQL24项补充多模板保护、失败事务、CLI invocation、历史及ACL变更拒绝。原生编译envelope由既有TemplateBindingService演练，旧执行器明确拒绝，不能降级清空编译计划。

## 修复与接口交接

- fixture及R3核验实际NetworkID；start/mysqladmin及cleanup前按准确ID、image、nonce、mount和端口核验。Docker及子进程有界，unknown非零保留句柄。安全spy12项通过。
- 配置历史helper曾把正式applied envelope重编码pending，使第二次采集被strict decoder拒绝；producer边界两项RED→GREEN。`history-envelope.patch`只用于私有装配，严格校验并保留正式payload/proof/effective revision，未放宽codec。交由MAX-238配置历史owner接纳、MAX-239复核接口；尚未合入共享产品基线。

## 最终gate与清理

- 私有装配typecheck、完整650业务测试1/1通过。
- 受影响templates/bindings/triggers/policy/scheduler及producer边界：51文件，36通过、15按既有条件跳过；595测试通过、115跳过。跳过的opt-in实机/MySQL套件不算通过证据，本项真实数据库由完整业务测试和R3覆盖。
- 任务分支typecheck、focused纯测试129/129、R3真实MySQL24/24通过。
- main纯增量候选typecheck、纯测试129/129、真实MySQL24/24通过。首次候选漏带旧shell测试依赖已补齐；缺frontend依赖链接属于验证环境，补齐冻结安装链接后通过。
- nonce `6a732f8753db2cfaf1d97af4`，container `aa3b0e3c8619b428c701c4c3395f5524f102ee91f8dd036b77d9a287bbe27ace`，port49896。清理前后准确归属核验通过，句柄state=cleaned，准确container/network/volume均不存在。前台测试已收集，无服务交接。

## 证据与放行界限

附件workflow.json为原始结果；max236-sources.json记录后端/Agent源码、脚本、SQL及锁文件实际SHA；checks.txt合并最终gate日志；cleanup-receipt.json记录精确清理；SHA256SUMS供字节核验。源码manifest SHA256：`648060f593b5c4aab7577ae9941d0dcad33c82522904a181085eb3c6a0c682e3`。

仅建立单指标、短保留、受控transport基线，未建立生产SLO、长期retention、多指标高维容量、远程设备实机或外部通知验收。超出假设需重测。归属未知、任务/历史不一致、重复事件或保全失败均停止。生产迁移、共享3306写、真实解绑、部署和远程压测仍需单独操作授权。

本轮产品模型调用0，未操作MAX-224预算账本，累计10M预算不清零；未编造token/费用。未新建回调/巡检，保持现有唯一终态订阅。
