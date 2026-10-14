# MAX-152 T10 有界领域复核与基线修复

基线 main：ba6abb09c44ca4e534b121de3d86335e13f9bcac。直接前置 T08/T09 和 stage8 T11 已由父任务验收；复用既有证据，不重评 T09/source 或 T11。当前只交付基线修复，完整 T10 功能未交付。

## 当前消费链与确认问题

服务器 evaluator 创建 server_id 告警；AlertRCAService 仍直接提交旧 RCA。网络 evaluator 创建 network_device_id 告警；AlertRCAService 查询及 subject 判别仍不包含网络 ID。T08 DatabaseAlertBridge 仅接受 instance，已持久化唯一 alert owner；调查授权每次从 SQL 重读主体并检查全部资源 scope。这些接入缺口属于后续 T10 功能，不将计划能力描述成现有能力。

网络采集器 recordFailure 将 SNMP_AUTH_FAILED/SNMP_UNSUPPORTED_SECURITY 及未达到连续失败阈值的检查写为 error；只有达到不可达阈值才写 unreachable。旧 evaluator 把 error/offline 也当作不可达，且每次以求值时间生成 good 状态观测。会把认证失败输出为宕机、把无检查时间的旧 online 状态解释为恢复。

正式 MySQL 进一步暴露旧 evaluator 将服务方法保存到局部变量后裸调用，丢失 this；真实 getActiveAlerts/findActiveNetworkDeviceAlert/resolveAlert 依赖 this.getPool，导致告警创建/去重/恢复路径异常。mock 方法无法暴露这一问题。

## 最小修复

- MysqlNetworkDeviceAlertStore 读取真实 last_check_at，并转成 Date。
- 仅 online/unreachable 且检查时间不在未来、未超过五分钟时生成状态证据；使用原检查时间和其五分钟有效期。error/offline/unknown、无时间、过期状态均不补正常/不可达证据。
- 以 AlertDatabaseService 作为 this 调用三个已存在的方法；保留原有查找、去重和恢复条件。
- 新正式 MySQL 回归自动使用独占临时容器及随机 schema，执行正式迁移两次后走真实 store/evaluator/alert service。SQL 检查未知/error/缺时间/过期/未来不新增宕机也不恢复旧告警；新 online 可恢复，新 unreachable 可创建，再次求值不重复创建。
- 将新 SQL 回归接入现有 recovery qualification 脚本，不启用生产触发。

## 验证与边界

原代码回归：4 项新增单测 RED，失败分别为错误/缺时间/过期状态生成不可达、缺时间 online 恢复；正式 SQL 在修复 this 之前 RED，记录 Cannot read properties of undefined (reading getPool) 及应恢复但仍 unread。

修复后 focused 28/28（包含1项真实隔离 MySQL，0skip）；相关四文件模块检查36/36；API typecheck、contracts:check、lint通过，lint266个已有warning/0error。完整网络模块与准确head CI结果见 Issue附件。

当前无模型发送，未初始化或改写唯一 T09-System-V1 ledger/journal/claim/stop，沿用父任务已核验177603 token/129请求的历史说明，不将其冒充本轮重新实测。代理token/实付遥测不可用。

本候选未修改前端、公开契约或权限逻辑；未完成三类告警→同一调查→证据→追问→原资源的 SQL/JWT/HTTP/WS/Chromium与真实模型验收，也未宣称完整T10通过。依Issue“Review阻塞修复的调度边界”，基线修复独立PR先供父Review/普通merge/main领域准入；后续功能另提PR。未部署、未变更生产数据/配置、未启动额外代理。
