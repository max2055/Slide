# 完整流程候选复核修正

继续 a5f5dcf5c，不另建任务或PR。本次针对 Chief 四项缺陷：

1. 评估窗口保留正式 null 的位置；覆盖切片只能连接原始相邻且均非空的输入，不能跨 null 拼接。窗口内有 null 时传入未知，不允许恢复。真实 MySQL 正常 writer 回归在问题期间写入 60/中间null/60/60，保持 open/unknown/recovery_count=0。另经原正式writer输入受控不合法单位及质量/值组合，严格校验拒绝并保持原episode不恢复；未改存储校验。先前将字段整个省略导致采集失败的测试输入已改成合法 nullable 字段；失败不当作正式空值证据。
2. 删除事件复用现有事务/事件行锁，按来源及 episode 关联拒绝模板事件，members/logs 不受损。单告警删除及保留期/全量清理排除 template-trigger；没有运行真实目标清理。非模板事件删除仍用原操作，但改为原子事务。事件页面原本没有删除按钮；服务端拒绝是安全边界。
3. 将生产 GET 列表/统计/MTTR/搜索/详情/日志挂成同一个 registerEventReadRoutes，浏览器 host 直接复用。所有模板来源从已持久 episode 的真实资源判权；NULL 实例不公开。列表/计数同时限定 legacy 实例和授权 episode ID；模板实例事件也不能退回 legacy 分支绕过资源边界。详情和必要原处理入口共用 requireEventAccess。读取前后重读主体，权限/实例范围/资源边界变化拒绝结果。
4. event-center 收为四标签；旧 view=rules 兼容落在聚合事件，提示从资源固定版本模板配置；旧 create-rule 导航至现有资源入口。不再挂 rules 模式或调用 openRuleEditor；历史规则数据与运行器未迁移/删除。浏览器确实从 event-center 包含的事件页面进入。

验证层级：受影响模块466通过/47 gated跳过（含三类资源授权函数的允许、权限拒绝、显式边界拒绝）；真实独占非3306 MySQL 2项通过；前端原42项通过并将 event-center 从2增为3项；API/frontend typecheck、contracts:check、build/CSP通过。三类授权负例是 SQL stub 单元证据，不称三类真实目标或完整三类 collector 验收。真实浏览器实际挂载生产相同事件读取处理器，保留95/85/60、历史配置变更、跨进程重启、受控HTTP回执与三桌面尺寸证据。

原三类实机、正式外部通知仍未验收；产品模型0，无子代理/生产worker/deploy/共享3306/实际解绑/MAX224/MAX240读方法变更。本候选继续待准确SHA独立复核，整单in_progress、done留成员。最终source/head/base、全部新可达对象和资源处置见本次评论附件。
