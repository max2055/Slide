# T12 最终候选验收记录

范围为 MAX-153 / v1.2.31；基线为 main `c87a4fcaf2dc0f1cf9e0fbe7c0382c9027272d74`。本次只增加资格测试、CI 装配及操作手册，不修改产品执行、权限或模型路由。当前 `fullIssueDelivered=false`，不能作为 V1 发布或完整合并出口。

## 环境与证据口径

2026-10-14 在 macOS、Node 24.18.0、pnpm 11.19.0 上验证。主机 10 CPU / 24GiB；Docker Desktop VM 实际 4 CPU / 5GiB，独占临时 MySQL 8.4.10、loopback 随机端口。SQL/JWT/HTTP/WS/Chromium 均使用正式路径与独立 schema；新流量使用受控 Provider 和合成只读资源，没有外部模型请求或生产变更。容量事件满足正式 OperationalEvent schema，但是直接 SQL 植入的容量夹具，不代表十万次 admission。

原始日志、SQL 回执、截图、历史失败及源码/产物 SHA256 随 Issue 附件交付。版本化计划见 `t12-plan.md`，回切、恢复和操作者场景见 `t12-runbook.md`。源码哈希 manifest 绑定候选 head；运行报告中的 sourceCommit 是当次运行 HEAD，提交前运行通过对应源码哈希关联，不能误称当时已运行提交后的 Commit。

## A01–A18 证据定位

| ID | 当前证据 | 验收边界 |
|---|---|---|
| A01 普通 Chat | workspace `ordinary Chat sends directly`、旧 Session cancel 两路由；frontend 825 单测 | 历史与原 ID 不复制 |
| A02 多 Run | workspace create/cancel/continue；resource-links 三类各两 Run；T10 真实 Provider 回执 | 同调查/Session，两 Run/结果版本 |
| A03 后台 | recovery `all browser contexts closed`，SQL terminal/result，重开/刷新调用计数不变 | 实际关闭所有浏览器上下文 |
| A04 System | system 浏览器正式 composition、源码工具、两 Run；复用 T09 真实模型及新进程恢复 | 自动工程证据与真实模型证据分别保留 |
| A05 三类资源 | resource-links instance/server/network_device；T10 三类真实 Provider UI/raw 回执 | 每类原事件→admission→工具→结果→UI→追问 |
| A06 幂等 | rollout 10,000 次、8 并发；store/trigger SQL 并发、跨窗口 | 一个 admission/Run/预算预留；受控模型计数 |
| A07 取消 | workspace 真实工具进程取消；execution-recovery SQL request/ack、claim/markSent 竞争 | 工具未退出时不得伪写 cancelled |
| A08 WS | workspace 断线/历史分页；recovery 删除 replay 后断线/刷新，原消息 ID 与调用计数 | SQL snapshot 恢复；未证明生产 P95 |
| A09 重启 | execution-recovery/canonical SQL、System 新进程恢复，T09 真模型已完成后恢复零重发 | 发送后 unknown 保留，不重放 |
| A10 权限 | store/routes/observation/governance SQL；resource-links 同 JWT 撤权及全部相关 scope；workspace 清缓存 | 详情、raw、搜索计数、WS 与深链 |
| A11 证据不足 | observation/result 契约、workspace partial/outcome_unknown、raw tombstone | unknown 与 gaps 保留，bound 不等于根因 |
| A12 三层状态 | workspace completed + 未确认，反馈 SQL/页面 | Run terminal 不自动 resolved |
| A13 成本 | budget-ledger/execution-recovery/governance SQL；rollout trace/usage inventory | unknown 非零预留；估算与实付分开 |
| A14 Legacy | bridges SQL/浏览器懒链接、旧结果只读；rollout true→false→true | 原 owner 保持；旧 lane 回调仅验证 admission，不调用旧模型 |
| A15 自身故障 | recovery unavailable、原 System payload、failed/partial、Agent-origin suppressed；system-event-bridge SQL | 原事件不丢、无自动自举 |
| A16 UI | workspace/governance 1600/1024/390、键盘/焦点/空错；recovery 390 截图 | 工程浏览器验证，不等同真人培训 |
| A17 人工处理 | feedback/feedback.production SQL；feedback 与 feedback-workspace 浏览器 | 真实结果版本绑定、撤权、依据不足拒绝关闭、not_applicable SQL |
| A18 转调查 | workspace ordinary Chat conversion；store/session-bridge SQL | 原 Session/消息 ID 保持、活动 Run 拒绝转换 |

这些证据覆盖工程场景；真实 Provider 复用记录、最终完整 gate、父独立复核及合并仍应分别核验，不能把矩阵定位当成所有出口已通过。

## gate 与失败分类

- Agent Core：33 文件 / 675 passed；frontend：103 文件 / 825 passed。
- frontend typecheck/build、API typecheck、contracts:check、qualification:matrix 均通过。lint 0 errors / 266 既有 warnings。
- 正式调查 SQL：31 文件 / 575 passed / 0 skipped（`integration-final/investigation-sql.log`）。
- 完整调查浏览器：最终 `integration-v2/browser.log` 为 60/60，包含两个既有反馈用例；早一轮 58/58、新增 recovery 独立 4/4 保留。固定后完整 integration exit0。
- API 默认完整套件：351 文件通过、42 文件跳过；3413 passed / 632 skipped。不能把 MySQL skips 算通过；完整启用 SQL 候选结果单列于交付索引。
- security:agent：187 passed。release security audit 无已知漏洞、secret scan、334 security:test、deployment invariants 通过；最后 sandbox 步骤失败。

历史脚手架迁移表名、返回字段与保留字错误已修复；最初 SQL 缺 JWT 的 573 passed/2 failed 已由独占串行 575/575 取代。共享 MySQL 下 migration lock/5s timeout 属环境干扰，取消的 API run（exit130）不算通过；交织/NUL 日志 `investigation-sql-overlap-invalid.log` 只作诊断。第一轮独占 integration 的 SQL 575/575、浏览器 58/58 已完成，但运行时编辑 Bash 文件导致末尾读取错位 exit127，整体不算通过；固定文件后重跑 `integration-v2`，并纳入两个反馈页面。旧失败原文保留，不抹去失败或把 skip 当成功。

## 性能与未完成项

容量初版三次列表 P95 17,030ms；有效事件最终版三次 P95 7,163ms，均未达 500ms 提案。10,000 次重复投递最终版 P95 12.04ms 是 record+重复 deliver 延迟，不能代替首次 admission、事件入队、WS 或取消的独立 SLO。列表 `MysqlInvestigationStore.list` 对候选逐对象检查权限；当前范围记录实测，不扩大为查询重构。最终采样以附件最新 rollout 回执为准，三样本不能证明生产 SLO。

`security:sandbox` 要求 Linux/rootless Docker 与真实隔离 controller 环境。当前 macOS 且 Docker SecurityOptions 无 rootless，门禁未通过；不复用生产 controller、不 fake 或 skip。下一步由父任务协调已有授权隔离入口后执行原门禁。未开展真人培训或生产灰度，独立 UI feature flag 当前不存在，UI artifact 回滚未实际执行。

T11 已由 Max 真人定性接受，无需重复评审；七维数值 unscored、DB06/NW05 原失败、80%/90% 软目标未测与盲评 unavailable 全部保留。

## 真实模型复用与用量

T10 `t10-functional-evidence.zip` SHA256 `675fffbb478d7a3e30100cea08e7e0a3f6f69d847412298697d9ae09b53ef93a`，31 源码清单中 29 完全匹配，本次只变测试 fixture/config；realProvider 提前返回分支、产品及工具源码未变。三类每类两个 Run、raw 往返，实际模型 `deepseek/deepseek-flash`，Profile/Prompt hash 和工具源码 hash 沿原资格记录。产品 result 中 unavailable/空 toolVersions 的 provenance 缺口原样保留，不伪造元数据。

T09 System summary 与 real-evidence、T11 原评估包均通过 Multica CLI 获取并保留原文件/hash。唯一批次 `T09-System-V1` 只读递归核验 journal/hash/claim：上限 10,000,000、累计 214,644 token / 153 请求、remaining 9,785,356，stopped、no pending、reserved0。本轮新增外部模型请求为 0；编码 Agent token/实付遥测不可用，不记零。未清 stop/claim、拆批或重放未知发送。
