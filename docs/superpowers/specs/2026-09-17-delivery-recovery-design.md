MAX-54 投递恢复设计（2026-09-17 Max 已批准）

基线：2026-09-17 fetch 后 origin/main@3481e9f。主线已有 MAX-53 的 JobExecutionContext（signal、workerId、fencingToken）及 notification-handlers.ts；不应按旧工作树重新实现取消机制。

## 范围与取舍

只处理 notification.deliver 与 report.notify 的持久投递、恢复查询和取消联调。复用 workflow_jobs、现有通知/报告 attempt 表和 occurrence 调度；不增加第二套队列或 outbox，不改无关 UI。硬预算未设定，实际 token/费用遥测不可用；无子代理。

方案 A（推荐）：持久发送闸门 + 保守 unknown + 显式恢复。兼容所有现有通道，代价是部分已实际发送/未发送的记录需要人工对账。
方案 B：只增加唯一约束，不能解决外部成功而本地提交失败，拒绝采用。
方案 C：强制全部通道改为支持幂等的中继，增加部署依赖且无法直接赋予 SMTP exactly-once，超出本次范围。

## 数据与执行契约

业务键分别使用 alert/channel 与 report/channel 标识，与 job attempt 和 fencing token 无关。同一业务键冻结接收目标、消息内容摘要和幂等能力；配置变化不得让重试悄悄变为新的外部效果。

在已有投递基础上增加业务状态及发送闸门：ready → sending → sent；明确未发送的错误进入 retryable/failed；可能已发出的错误进入 unknown；无效业务对象进入 skipped。每次实际尝试有独立且不因 dead-letter replay 重置的标识，现有 attempt/replay 审计记录扩展保存结果与恢复决定。

发送闸门使用数据库事务/CAS，校验 workflow owner、fencing token、有效 lease 与业务状态。只有成功占用的执行者可以发送；接管者看到 sending 时不能直接重发。数据库事务不跨网络发送持锁。

准备目标、验证配置后检查取消；持久化 sending 后，在真正发起 HTTP/SMTP 请求前再次检查 signal。取消无法撤回在途请求。进程恢复遇到悬挂 sending，将其按 unknown 对待；旧执行者不得覆盖接管后的状态，写入需匹配尝试标识及有效执行所有权。

## 通道与恢复政策

SMTP、现有未确认去重能力的机器人 webhook：禁用持久投递路径的内部盲重试。超时、连接中断、成功后落库失败和发送中取消均保守 unknown，自动任务重试不得再发。发送前验证失败可安全重试。SMTP Message-ID 只用于对账，不宣称去重保证。

明确配置并经接收端契约确认支持幂等的通用 webhook：传递稳定业务键；重试复用冻结的请求及相同键。仅在接收端保证范围与保留期内重试；不能把添加一个请求头描述成 exactly-once。

复用现有查询/重放入口提供状态、attempt、错误类别和恢复决定。unknown 不允许普通 replay 绕过；管理员需记录对账结果与理由，可确认已送达、放弃，或明确接受重复风险后再次投递。恢复操作使用状态版本 CAS，写审计并防止重复请求重复执行。

## 验收清单

- 数据库集成：两个独立连接竞争同一业务键、同 occurrence 重试、重放后的 attempt 唯一性，验证只能获得一个发送权。
- 故障注入：发送前失败、sending 落库后崩溃、发送成功后记录失败、接收成功但响应超时、进程恢复；断言状态及实际接收次数。
- 生产 handler + 两 Worker + 隔离本地 SMTP/HTTP：lease lost 后无新请求；在途请求最多保留其已发生效果；非幂等 unknown 不重发；幂等接收端稳定键去重。
- 查询/恢复：权限、理由、版本冲突、unknown replay 禁止绕过及审计可追踪。
- 开发运行 focused checks，模块边界运行受影响测试，最终候选运行一次必要集成 gate。禁止向真实联系人发送，不以 mock 测试冒充真实数据库或接收端验收。

实施停止条件：必要凭证/环境无法恢复、授权边界或明确预算限制时暂停受影响步骤。批准记录：MAX-54 评论 01a0ad69-57ac-730d-952e-c54a1ba0b7aa；实施验收见 docs/slide/validation/max-54/acceptance.md。
