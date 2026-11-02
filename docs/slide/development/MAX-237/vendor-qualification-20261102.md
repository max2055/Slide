# Oracle / 达梦真实查询资格接续

授权：父 MAX235 成员评论 `01a19b58-8a36-7a30-9662-f39c97c4406e`，不复制账号口令。一次唤醒 `01a19b5a-7aee-79c4-bd30-8213e0009fb7` 已自动停用，沿用原终态回调。实测源码 `16500f36081a34f8cad2acea98c9b56eb25a6688`，仅在指定分支和 `4c17715c8` 起点上追加。

## 实际覆盖

| 引擎 / 范围 | 注册包 | 两轮正式样本 | 最新 / 历史 |
| --- | --- | --- | --- |
| Oracle 19.19.0.0.0，ORCLCDB / CDB$ROOT | oracle-representative@1.2.0 | 会话52、processes320、累计提交24；uint64 / count / good | 会话和上限为count；提交计数由既有查询层转换为count/s，实测0，来自真实相同计数差 |
| 达梦握手8.1.3.62；V$VERSION build `03134284094-20230927-203585-20067` | dameng-representative@1.0.0 | 会话2、上限10000、累计提交76→79；uint64 / count / good | 提交速率约1.2531328320802004 count/s，保留partial / precision_loss |

每引擎贯通真实查询→注册映射→不可变模板发布→probe/trial/apply→两轮前台正式任务→原writer→认证最新/历史，共12个正式样本。首个派生速率保持null / unknown / counter_baseline；无权限平台账号均返回403、目标读取增量0，错误凭据引用在I/O前拒绝。模板快照前后不变。

通过内部CollectorAccess端口使用真实驱动和内存凭据，平台只存`no-target-secret`占位；没有mock行、手工插入样本/publication/事件，也不冒充生产凭据持久化/UI纳管演练。不重复PR390已接受的编辑、MySQL/VM/SNMP/PG及事件触发/保持/恢复。

## 必要适配

原19.3包正确拒绝19.19；新增显式19.19身份和1.2.0包，不扩大到19.20/21，不改变原1.0.0/1.1.0。原全部26个包逐项内容/摘要不变，只新增1包。

原Oracle/DM value-only读取成功，但缺计数生命周期导致规范化拒绝。新增`vendor-counter.ts`经既有counterQuery接入传输层：一条固定SELECT同取精确十进制计数、原生启动文本、实例及Oracle容器身份。epoch是原生字段摘要，不从采集时间推算启动时间，不把服务器本地DATE当采集机时区。discontinuity.observed_at记录连接首次看到该epoch的时间、reason=initial；同一连接复用，启动身份变化或进程/连接重建保守重建基线。计数下降、gap、精度及未知仍由原引擎处理。

相关config/database/scheduler/consumer基线与main `aedcc4605a80cd303e8e54e2909d53a7ba1caf59`一致。main另有已接受trigger dependency接线；本次无触发器模板提前返回，不触及该差异，未盲合整条历史。复用PR390 merge `86a2be0ea055c533783f9c7243342b93c8d88e4a`及既有未变业务证据。

统计背景：[Oracle官方指南](https://docs.oracle.com/en/database/oracle/oracle-database/19/tgdba/measuring-database-performance.html)；root视图范围：[V$SYSSTAT](https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/V-SYSSTAT.html)；DM START_TIME：[官方附录](https://eco.dameng.com/document/dm/zh-cn/pm/dm8-admin-manual-appendix2.html)。资料不能代替附件实库证据。

## 权限及残余边界

- 每次采集独立会话先SET TRANSACTION READ ONLY，再执行固定SELECT并关闭；每引擎15个只读事务会话。没有目标DDL/DML、授权变更、配置修改、安装或重建容器。
- 实际账号含DBA；**只读操作通过，最小权限授权未验证**。未尝试可能成功的写入来证明写拒绝。最低查询权限：Oracle CREATE SESSION、SELECT V_$SESSION/V_$PARAMETER/V_$SYSSTAT/V_$INSTANCE；DM CREATE SESSION、SELECT V$SESSIONS/V$PARAMETER/V$SYSSTAT/V$INSTANCE。Owner Max/Chief提供独立受限账号后补最小授权/数据库拒绝负例，平台403不能冒充数据库拒绝。
- Oracle orclpdb1真实返回ORA-01045，未计通过；需owner明确PDB并提供其登录/查询授权。root连接的V$SYSSTAT为实例范围，不声称PDB局部统计。原19.3仍无目标，19.19不冒充19.3；准确19.3资格需owner另供授权目标，禁止为匹配版本重建现有容器。
- 数据文件容量、额外诊断、真实重启/手动reset、目标超时和权限撤销未新增实测。受控单元用例不写成真实故障操作，不宣称所有Oracle/DM版本或PDB均已完成。

## 验证及清理

最终完整API：615文件中546通过/69条件跳过；5210项通过/1045条件及环境跳过/0失败，耗时394.02秒，启用隔离T08/METRICS/MAX238_HISTORY端口。跳过清单另附，不计为通过。API及三份e2e类型、契约、资格矩阵37/37、安全扫描、恢复策略46项通过；lint 0错误/354警告。无前端或依赖锁变更，复用已接受浏览器证据。完整gate后隔离MySQL仅剩四个系统schema，标签核对后已停止该容器。

新增两文件8项，连同诊断映射共13项通过：旧pin、精确uint64、版本拒绝无I/O、启动身份变化/进程重建、缺失/歧义生命周期、拒绝/超时不重试。完整API、类型/契约和安全gate准确结果及跳过清单见附件，不以定向单测代替全量。

最终证据`live-54d0b0d9f9697578`记录上述准确源码、原生结果、单位/质量、映射、任务、查询和权限负例；早期诊断检查点不是最终通过证据。隔离MySQL8.4端口62319，非共享3306；finally已关闭所有目标/平台连接并删除唯一schema，最终容器清理及安全对象审计另附。两个原目标容器保持原样。未部署、解绑、通知、产品模型或子代理；交Chief独立验收，整单未done。
