## MAX-175 R11：停用周期任务与 Agent 时间持久化修复

沿原 PR189 https://github.com/max2055/Slide/pull/189 交付，保持 draft，交 Chief 定向复审。产品只改新增写锁内的 `metrics-v2/scheduler/store.ts` 与 `security/sensitive-data.ts`，共 6 行；`investigations/executor.ts` 无需修改，上游 Date 转 ISO 后可安全通过原有有界复制。原七个 UI／诊断产品文件与 R10 字节一致。没有合并 main、共享部署、修改 Provider／路由或他人绑定，MAX-182 固定 c102 边界不变。

真实模型主验收运行提交 `1cfd254d367335f1c99dabccfead5b9715174fca`；无模型调度重启／权限补验运行提交 `86d73c471f8e6f1db7bcc502f55ca53dd2016c44`。两者产品源码完全一致，后续差异仅专属测试／报告。最终 head 及各文件 SHA256 见随附件 source-manifest.json；本报告提交不重放模型。

### 实现与回归

- 入队事务在原 publication lock 下读取数据库中的当前应用状态：仅当前 revision 为 disabled 且已由真实 fenced worker 标记 applied 才停止入队；不依赖扫描旧快照，不跳过首次停用应用，不伪报 applied。其余 revision、lease、fencing、取消、失败恢复和并发保护未改。
- 脱敏遇合法 Date 转为 UTC ISO，非法 Date 按 JSON 时间契约变 null。敏感键优先脱敏、文本脱敏、原始输入不变。executor 的深度 20、每数组 200 行、128000 字节限制原样保留。
- RED 提交 `71c34001`：27 项中 3 项按预期失败，复现停用后仍入队与嵌套时间变空对象。GREEN 提交 `b8d673c3`：同一 27 项全部通过。
- 真实 MySQL／真实 executor／受控 Provider 回归 3/3：持久化嵌套 observedAt／validUntil、无效时间 null、敏感键与文本、200 行截断、深度截断、超字节拒绝。该层无外部模型请求，不充当真实 Agent 成功证据。

### 正式隔离链路补验

仍用任务自有 MySQL 9.6.0、正式迁移、JWT／API、生产 scheduler／worker、真实 Lit 页面。平台与只读目标在一个独占容器的两个 schema；MySQL 目标为任务自有 LAN 端口33176，API3175／WS29775／Vite5195。没有接口或 Provider mock，也没有手工直调服务冒充调度。

| 验收 | 结果与来源 |
|---|---|
| 首次停用与连续周期 | 正式 API 创建 instance:1 和 mysql-basic@2.0.0／5秒绑定，真实连续两周期 completed／committed、raw／normalized uptime 保存。revision2 首次由真实 worker 应用，无 I/O。主验收 applied 后等11秒任务4→4、采集3→3；独立补验任务3→3、采集2→2。 |
| 重启与重新启用 | 补验原 API PID89307 经 SIGTERM 宽限后第二次 SIGTERM 退出；新进程 PID89344 重新加载持久化状态，再等11秒任务3→3、采集2→2。revision3 发布后任务 e173d8ff-59bc-4da7-b53f-04fae256d3d6 completed，真实采集2→3。revision4 首次 worker 应用后再等11秒任务5→5、采集3→3。 |
| 并发／旧任务／失败恢复 | scheduler MySQL 23项及 lifecycle／compiler 回归通过；新增覆盖并发扫描、重新加载、旧 pending 快照、旧 revision、新 revision、未应用停用任务 cancelled／dead_letter 后按原 cadence 恢复。原 lease 过期／持锁／取消／超时／迟到结果围栏测试全部通过。 |
| 页面真实 Agent 时间 | investigation e61b5ebf-e1a5-4798-9621-e6fab82e2dc6；session 6945b2ed-9bc0-4818-9003-734aa2186f82；request aa53a0ce-73e8-4987-a16b-7a286ab25fd3；job 93e12d14-5655-451e-98ba-5ea047a1113c；run 247ccf1f-64f1-4bcc-90fd-0cde3b381581 completed。真实 deepseek-flash 调用 get_resource_observations(instance:1, connections, limit1)，工具证据 connections=9、source=metrics_history、quality=good，observedAt=`2026-10-16T01:00:11.000Z`、validUntil=`2026-10-16T01:05:11.000Z`，均实际持久化为字符串。 |
| 成果面板与刷新 | 页面提交202；工具证据与结果落库。打开“查看证据与成果”，断言与数据库保存的 summary 一致；页面刷新后重开再次相同，保留截图。不是只检查 completed 徽标。 |
| 失败／权限 | 最终无模型独立补验1 passed／1 skipped。不可达33177目标 reload500／INTERNAL_ERROR，390px页面显示证据不足；专属用户撤角色，同 JWT GET403、刷新清除旧资源与证据；无 JWT401。其余未变迟到响应／切换清理复用 R8/R10 已接受证据。 |
| 清理 | 三个正式 fixture 均回读临时 schema／用户为空，独占目标容器与 volume 删除。后验12个子PID全部不存在，3175／5195／29775／33175／33176无 listener，本轮 R11容器无残留；focused／复核容器及其确切 volume 已清理，旧 slide-max175-mysql仍 exited。见 cleanup-verification.json。 |

Agent 读取的是 reload 所保存的 legacy metrics_history，v2 调度采集的是 uptime；它们属于同一资源的不同观测，未声称 v2 cutover。结构化 facts 仍为空，工具事实位于 evidence，根因／恢复 unverified、problemStatus unconfirmed；保留已接受的来源边界。

### 完整检查与环境失败的处理

前后端 typecheck、frontend build、contracts:check、security:agent（188/188）、security:scan、diff 检查通过。全仓 lint 0 error，262条既有 warning；新增 executor 回归单文件 lint 0 error。

完整后端一次运行覆盖401文件／4095项：4043 passed、5 failed、47 skipped，另一个 beforeAll 超时的系统事件文件包含19项。不能把这次原始运行写成全绿。隔离 Docker 当时内存压力使初始 MySQL OOM；降低任务数据库缓存后完成全量，但为节省内存关闭 performance_schema 导致依赖它的锁等待／数据库采集断言失败；MySQL9.6 的 EXPLAIN 索引字段与既有8.4断言亦不同。未修改这些未授权产品／测试。

按 CI 对应 MySQL8.4.10、performance_schema开启，在低缓存任务环境定向复核：系统事件文件19/19；其余3个失败文件连同 scheduler、executor、Date 回归共9文件100/100。四个失败文件全部通过，复用其余未变文件的已通过结果；不是第二次整套4095项统一运行。合并按测试唯一项计算为4067通过／28原有条件跳过，无未解决失败；完整清单及原失败保留在 validation-summary.json。跳过项不冒称真实服务通过。远端新 head CI 独立记录，不继承旧 head 的成功；由本 Issue 的实际 checks 监听接续，完整门禁未齐不合并。

首次 R11 主验收本身1 failed／1 skipped：其 Agent、时间／刷新和11秒停用证据有效；失败点是验收脚本的15秒 API退出等待。另有权限子脚本仍限定 R10 schema／名称，已仅修专属脚本为 R11。重启补验及权限补验各1 passed／1 skipped，均模型调用0；没有为这两个脚本问题重跑真实 Agent。重启采用精确任务自有 PID 的第二次 SIGTERM，未修改产品关闭逻辑。

### 同批预算与边界

统一 MAX-155/MAX-157 账本累计输入147952、输出57713，总计 **205665/10000000 token**，本轮增加3723；cached input90880是输入子集，不重复累计。无 pending、未停止、无未知发送重放。本轮真实 Agent 两次底层请求均有发送前预留与实际 usage 回执。账本 requests=28包含以前一次聚合补记，不能称28次实际底层调用；早期底层次数缺口沿 R10 保留。编码代理token／费用遥测不可用。

只读复制现有安全运行时选择的 deepseek-flash 到临时库，秘密只在内存处理。附件仅白名单 JSON／报告／截图及脱敏验证摘要，不含 .env、JWT、密码、密钥、私有服务日志或原始 trace。

人工听读永久取消，不列待补或门禁；厂商SNMP／流量按既定决定延后测试环境。共享在线环境仍未验收，本轮隔离成功不替代共享上线；不扩 MAX-182。既有视觉／性能矩阵未重复执行。Chief 通过本次确切 run 终态规则接续复审，不重复派发。
