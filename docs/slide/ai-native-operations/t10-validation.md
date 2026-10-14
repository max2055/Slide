# T10 资源告警与业务入口验收

日期：2026-10-14。任务：MAX-152。基线：main `16c9b57250b8eabb26dd43c1e7bc1c8115a1306c`，包含父任务已验收的 PR166。本文记录 T10 功能候选的领域验证；完整 V1 总 gate、独立 Review 与正常合并出口由父任务/T12 负责。

## 实施范围与兼容

- 复用持久 `investigation_alert_owners`、锁、admission、权限与旧 Analysis lane；数据库、服务器、网络告警均从唯一持久资源列取得 ResourceRef，tags 不授予权限。手动与自动入口并发仍指向同一调查。
- 新 command snapshot 使用 version 2。无版本的既有数据库 command 恢复时保留原 message/context/goal/idempotency hash；已有运行或未知 Analysis 不切换执行 owner。关闭 flag 后已提交 owner 继续复用。
- 自动服务主体仅限当前资源，并实时重载权限。配置沿现有 `INVESTIGATION_OPS_SERVICE_USER_ID`，新增 `INVESTIGATION_OPS_SERVER_IDS` / `INVESTIGATION_OPS_NETWORK_DEVICE_IDS` 白名单；未配置不自动降级启动第二条执行。
- 服务器/网络持久观测值、阈值、真实时间范围、质量、dimensions。Metrics V2 使用真实 bucket 范围，partial 保留；没有单点时间不补当前时间。legacy 单点只记录采集点，规则持续秒数另记 `rule_window_seconds`，不伪造连续采样。显式未来/无效时间与无值保持 unknown；缺指标不等于正常或宕机。
- 活跃 server/network 告警去重时，指标值、文案与观测 tags 在同一 SQL UPDATE 中刷新，保留其它规则元数据；不能将新值归到旧采集窗口。允许最新观测晚于告警首次创建时间，以持久 updated_at 核验未来时间，不能用 updated_at 伪造采集时间。已提交 owner 仍保持原冻结快照，不因后续 touch 启动第二条调查。
- 三类资源共用 `resource-investigation-links` 查询现有调查，不隐式调用模型。调查详情返回原资源，列表读取 resource URL 筛选。保留旧诊断入口。`instance-overview-tab` 当前未被实际详情消费，故同时接入 `instance-detail.ts`。
- 资源详情移动端修复限定于三个详情 host，保留可见导航栏所需宽度；左右位置均验收。没有全仓样式重构或生产配置变更。

## 验证命令与结果

产物包中的日志对应实际执行结果。最终 focused 修正之前的失败日志保留用于说明回归，不能作为通过证据。

| 层级 | 命令/范围 | 结果 |
|---|---|---|
| 正式隔离 SQL 领域 gate | `bash scripts/qualification/run-investigation-bridges.sh`；legacy/alert/pool/resource/network MySQL suites | 最终 35/35，0 skip；包括实际 touch SQL、最新窗口 admission 与原 owner 冻结复用 |
| 最终观测 focused | API vitest：`metrics-v2/consumers/operational`、`server-alert-evaluator`、`network-device-alert-evaluator`、`investigations/resource-event-bridge` | 34/34，0 skip；包含正式 MySQL/JWT/HTTP、版本恢复、未来时间及两类 touch 回归 |
| 受影响模块 | investigations、Analysis、server/network evaluator 等既有模块 | 140 pass / 34 skip；skip 为既有依赖环境的 session-bridge suite，不宣称全量通过；必需 SQL 链路由上述无 skip gate 和 browser 覆盖 |
| Agent 安全 gate | `pnpm security:agent` | 187/187 |
| 前端 focused | investigations controller、network detail、server hosted instances、instance diagnosis/metric source | 36/36 |
| 受控 browser | `bash scripts/qualification/run-investigation-bridges.sh --resources-browser --output=<独立目录>` | 4/4：三类往返与同 JWT 撤权，正式 MySQL/JWT/HTTP/WS/Chromium，Provider/目标观测受控 |
| 最终真实 browser | 上述命令加 `T10_REAL_PROVIDER=1`、独立 linked journal、`--trace=on` | 4/4；三类各两个 completed Runs、raw evidence、资源返回及撤权；12 次真实 Provider 请求 / 18470 token |
| 静态/构建 | API/frontend typecheck、`pnpm contracts:check`、frontend build/CSP、lint | 通过；lint 已有 266 warnings / 0 errors，build 既有 chunk/import warnings；Lit dev-mode/update 提示保留 |

受控与真实 browser 均断言三类告警入口重复请求复用同一 ID、两个 completed Runs、持久 resource binding、正式 evidence raw 接口、追问与返回资源。重新打开现有调查不增加执行。宽度 1440/1024/390 检查无横向溢出，并验证入口 rect 不被导航遮住；390 额外验证右侧位置。

撤权使用原 JWT，删除实际 role permission 后，WS 撤权并清除 UI 内容，告警调查、详情、raw evidence 深链返回 404，列表无记录；包含 instance + network 必需 scopes 的调查也被拒绝。重新加载网络资源页不能读取受保护资源信息。

## 真实模型与证据口径

使用当前授权配置的真实 Provider，配置只经 SELECT 读取，目标为隔离 SQL 合成资源；真实模型调用经 Agent Runtime 和正式 HTTP/WS/Chromium 链路，不冒充真实生产 SSH/SNMP/数据库指标采集。

首次 instance 完成首次调查、追问及返回资源，但末尾证据收集器错误请求不存在的 `/evidence` 集合 URL。已改为 `/evidence/:eid?raw=true`；原正式 HTTP 结果从 trace 恢复，保存 `instance-real-reused.json` 与原 trace。随后 server/network 与撤权 3/3 通过，原日志、Provider 响应、账本保留。部分 browser 输出被后续测试覆盖，因此最终重新收集三类完整真实产物到独立目录，新增调用仍计入同一账本，未重放未知请求。

最终真实验收日志、每类 `*-roundtrip.json`、九张截图、成功 trace、模型原文和账本快照在产物包中。网络模型必须将 null/unknown 描述为证据不足，不能判断正常或宕机；重复冻结快照不产生新事实。前一次 server 模型主体事实 CPU91 正确，但辅助文字曾写“92%不等于宕机”，原文保留，不把模型描述全正确或定性接受说成人评满分。模型根因仍待证据验证。

最终 touch 补修只影响既有告警刷新：真实 browser 每类创建一条告警，首次 created_at=updated_at，原冻结消息/工具输入未变，因此复用真实 Provider 证据。当前候选重新运行受控正式 browser 4/4，并用真实 SQL 验证触达的刷新/原子更新路径，不机械重发模型。

预算始终沿唯一 `T09-System-V1` / 10,000,000 input+output，cached input 为输入子集，不重复加。调用前核验 stopped/no pending/reserved0 与 pointer hash，`initializeSystemJournal` 链式恢复，逐次原子预留、实际 usage 结算、禁 SDK 自动重试；最终 stop 与 claim 历史保留。精确累计、请求数、余额见包内最终账本快照，前序 177603/129 不重置。编码 Agent token、费用及早期家族遥测不可用，不能记零或与测试 Provider usage 混算。

最终只读核验：累计 **214644 token / 153 请求**，余额 **9785356**，stopped、无 pending、reservedTokens=0。本轮三个 linked scenes 合计 **37041 token / 24 请求**；其中最终完整重新收集为 input13921 + output4549 =18470，cached7040 为 input 子集。历史与原始 responses 全部保留。

## 交付边界

没有生产部署、生产迁移、生产触发启用、付费基础设施、新 Issue 或子代理。功能候选独立 PR 当前 head 的 CI 结果在交付评论及产物中记录；最终 `in_review` 只表示完整 T10 领域交付供父独立 Review，不能代替正常 merge/main 包含性核验或提前放行 T12。
