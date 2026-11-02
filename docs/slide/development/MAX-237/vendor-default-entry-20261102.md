# Oracle / 达梦默认入口复核补验

承接 Chief 复核 `01a19b84-7048-76e3-843d-d62c55d5e451`。只补权限注册契约、默认连接链与真实页面，不重做PR390已接受的其余引擎、模板引擎及事件链。PR仍为574，指定分支与祖先50be9a315保留；不增加回调。

## 权限契约与兼容

新增显式可选的Oracle19.19 `oracle-representative@1.3.0`、DM8.1 `dameng-representative@1.2.0`。三个实现均包含CREATE SESSION；每个映射列出自己的查询视图，计数另需启动视图：

| 引擎 | 会话 | 上限 | 累计提交及原生生命周期 |
| --- | --- | --- | --- |
| Oracle | SELECT V_$SESSION | SELECT V_$PARAMETER | SELECT V_$SYSSTAT、SELECT V_$INSTANCE |
| 达梦 | SELECT V$SESSIONS | SELECT V$PARAMETER | SELECT V$SYSSTAT、SELECT V$INSTANCE |

`vendorLifecycleSql`是运行时固定计数SELECT与新实现discovery的同一来源；产品模板编辑器的capabilities HTTP响应、注册实现及发布documentation均列精确权限和固定SQL。回归从实际FROM/JOIN提取视图并核对映射权限，而非只检查说明文字。

原27个包完整内容/摘要逐项不变，旧绑定不自动升级。旧Oracle1.2.0、DM1.0.0/1.1.0等pin保留历史“driver startup evidence”声明；它们不能作为当前原生驱动所需权限的完整清单。当前默认驱动同样需要上述启动视图。需要新权限声明时显式选择新pin、重新试采并应用，不能仅修改旧包文档或给账号DBA来规避缺权。原Oracle19.3仍保持版本边界。

DM登录权限参考[官方自主访问控制](https://eco.dameng.com/document/dm/zh-cn/pm/discretionary-access-control.html)；授权清单不等于受限账号实测。没有执行GRANT/REVOKE/CREATE USER。

## 默认入口与真实页面

`max237-vendor-qualification.ts`从准确授权成员评论解析真实凭据，在独占平台schema用原encryptData持久化密文，调用原databaseService.addConnection，再由createAssetCollectorAccess读取资产、解密、核对连接身份并进入trialDatabaseTransport。没有自建CollectorAccess、占位密码或替代counterQuery。

默认传输层的Oracle池临时会话、DM临时连接均先执行SET TRANSACTION READ ONLY，再执行固定SELECT，finally关闭。计数状态仍挂在同一资源连接对象上；新回归覆盖重新创建transport、释放临时会话、权限拒绝时关闭会话及不重试。真实两轮持久化counter的epoch和首次观察时间必须相等，第二轮速率必须有有限值，防止永久baseline。

模板选择/不可变发布复用已接受服务；probe/trial/apply/collect经过原认证HTTP路由，前台原scheduler/worker与writer产生正式样本。两轮之间等待128秒真实时间，以覆盖页面原生60秒时间桶，不伪造时钟、观察时间或手工插入样本。Rollout仅在独占schema的新资源初始化；不启用生产worker。

页面使用资源详情实际消费的semantic-metrics组件，1440×900浅色桌面，Vite代理同一真实Fastify服务；没有API拦截、响应fixture或将JSON手动塞入组件。保存每引擎最新、历史趋势及无权限截图，及脱敏metrics/query请求/返回；截图中全局自动采集关闭、末桶未知、历史值过期和未覆盖指标均为真实状态，不能解释成全部健康。外层导航、编辑及通用交互矩阵复用已接受证据，未声称重做完整浏览器矩阵。

资源拒绝账号具有全局metric:view与instance:view，但没有目标资源授权；真实HTTP和页面均拒绝并清空受保护结果。该平台边界不能替代目标数据库拒绝。

最终实库源码 `c6eb74ad70ec97bd6628b84d915b5a6abb04b32e`，证据 `live-5be5303eb1ac6bae`：每引擎两个完成任务、六个正式样本，共12个。Oracle会话53、上限320、提交34→34（uint64/count/good），真实速率0 count/s/good；DM会话3、上限10000、提交112→115（uint64/count/good），速率约0.023378323618341076 count/s，保留partial/precision_loss。两个真实持久化counter的生命周期均跨轮稳定，原生60秒页面桶亦存在有限速率。首次派生值仍为unknown/counter_baseline，不把0或DBA角色冒充未知/受限授权通过。

## 保留限制

实际Oracle19.19.0.0.0，仅ORCLCDB/CDB$ROOT；达梦8.1.3.62。19.19不替代19.3资格。此前orclpdb1 ORA-01045保留，只有指定PDB目标确需覆盖时由owner补登录授权。本轮不重试、不提权、不重建目标。

提供账号仍含DBA：只读执行可验证，最小权限/数据库原生拒绝继续局部暂停，owner Max/Chief提供独立受限账号后补验。没有尝试可能成功的写入。真实重启、reset、权限撤销、额外诊断及容量不在本轮新增实测范围。

准确源码、最终实库证据目录、测试命令/计数、失败分类、清理、凭据与新增对象审计、PR单次CI快照见附件REPORT。源码不变时复用完整API证据；条件跳过不计通过。交Chief独立复核，不自行合并或done。
