## MAX-175 R10：隔离生产链路补验，仍 blocked

沿原草稿 PR189：https://github.com/max2055/Slide/pull/189 。本轮只新增专属验收脚本及报告，七个产品文件与 R9 `7f024079ba0d800d539d398fcaf6d246674429a0` 字节一致。完整主验收运行候选为 `29a75a3ce1ede58aacfacb2f5fd6e3cabc058f8c`，PR base 固定 `main / 3bf58f08e5f2507fb0c7e2b7de2739e95045d4c0`；只读获取的 origin/main 为 `4c00819a9a28306b938e5042c6d753e532fe9682`，未混入。报告提交可能再前进，产品及实际运行脚本差异见 source-manifest.json。

人工 VoiceOver 实际听读已按 Max 最新决定永久取消，不是待补项。厂商 SNMP／网络流量仍按已决定的测试环境接续，不恢复旧门禁。既有 R8/R9 视觉、主机日志、键盘及性能证据复用。

### 当前验收结果

| 项目 | 结果与证据 |
|---|---|
| 隔离环境与正式入口 | 通过。任务专属 MySQL 9.6.0、完整正式迁移、Fastify/JWT、生产 scheduler/worker、实际 Lit 页面；API3175／WS29775／前端5195。目标与平台用同一独占容器的两个 schema，目标账号只读。没有接口／Provider mock，没有服务直调冒充正式 API。 |
| 正式资源／绑定 | 通过。正式 API 建 instance:1、reload200；mysql-basic@2.0.0 绑定 revision1，5秒周期／5秒超时；回读支持 MySQL9.6，非法周期发布400。首次 reload 的 legacy 采集与后续 scheduler 采集分别记录。 |
| 两个连续周期 | 通过。工作流 `dcf90005-9fc8-47c9-81b0-895b22100adb` 和 `7766d8fd-d504-4d99-9220-e361c5435a1f` 各 attempt1、completed、committed，UTC 00:41:54／00:42:00；49ms／45ms，各 logical_reads1。每周期 raw／normalized uptime 持久化、质量good、时间与 source/job 对应；窗口内无重复执行。完整 SQL 快照见 full-chain.json。 |
| 页面→真实 Agent | 执行与持久化通过。页面选择资源并提交只读调查202，真实 deepseek-flash，实际调用 get_resource_observations(instance:1, connections, limit1)，读取真实 metrics_history。run completed、工具证据与结果均持久化；点击“查看证据与成果”后断言数据库保存的 summary，刷新重开再次相同。不是仅检查完成徽标。 |
| Agent 证据时间 | **失败**。实际 connections=9、source=metrics_history、quality=good，但持久化工具证据的 observedAt、validUntil 都是 `{}`。不能声称观测时间已完整贯通。直接纯函数复现确认 redactSensitiveData(Date)→空对象；executor boundedResult 再递归复制也缺 Date 分支。 |
| 停用 | **部分通过／门禁失败**。正式发布 disable revision2、回读 applied_revision2 后等待11秒，采集attempt保持3→3，任务却4→5。新任务是 revision2 的无I/O应用任务；不是新的真实采集，但违背“停止后无新任务”的当前文字。不能把零采集冒充零任务。 |
| 失败与权限 | 通过。独占不可达33177资源 reload500/INTERNAL_ERROR；390px页显示证据不足，没有伪健康。专属用户撤掉角色，同JWT GET403，刷新后清除旧资源与旧证据；无JWT401。切换／迟到响应清理复用未变产品代码的R8受控自动化证据，不冒充本轮真实并发撤权。 |
| 清理 | 通过。临时两个schema与只读用户回读为空，任务容器及volume已删除，四个子PID均不存在，3175/5195/29775/33176无监听；旧slide-max175-mysql恢复exited。全部任务专属新增绑定、调度及调查数据随隔离schema删除；没有改共享服务／他人绑定。 |

Agent关联：resource/binding `instance:1`；investigation `21de74a6-6860-4b88-bf1f-46ece1cb8fd3`；session `079f4324-19b5-4432-b398-479b7a74c8b8`；request `52ff2826-2d3b-40ed-a6a4-51df411b141e`；job `090cbcdd-7368-4357-a313-c4d6a129b218`；run `9a91f6a3-17de-4ce4-a1e8-15d5dbf99cee`。结果为通用执行摘要，结构化 facts 为空，工具事实在独立 evidence 记录；根因与业务恢复保持 unverified。此次 Agent 读的是 reload 所保存的 legacy metrics_history，**不是**v2绑定的 uptime 观测。v2 normalized 存储不等于正式读取源 cutover；本轮没有伪造shadow/gate或切换来源。若 Chief 要求同一v2观测贯通 Agent，还需明确该验收范围并走真实 rollout 门禁。

### 越写锁缺口与最小接续

1. `apps/db-ops-api/src/metrics-v2/scheduler/store.ts` 的 enqueue 明确让 disabled plan 继续由worker应用，当前每个周期仍排无I/O任务。请 Chief 审定：若当前要求仍是“应用停用后零新任务”，协调该文件及专属 scheduler 回归的最小写锁，确保仅首次停用应用任务被允许、已应用后不再周期排队，并保留旧revision隔离、取消／lease／防重复语义；若认可现有零采集语义，先修改有效验收文字，不能由本任务自行豁免。
2. `apps/db-ops-api/src/security/sensitive-data.ts` 与 `apps/db-ops-api/src/investigations/executor.ts` 的脱敏／有界复制丢失 Date。请 Chief 协调最小修复所有权与回归：保留ISO时间、既有敏感字段脱敏、大小／深度限制及持久化一致性。没有修改或放宽产品安全限额。

正式共享在线部署未验收；本轮隔离链路不能写成共享在线已通过。上述门禁解决前保持 blocked、PR draft，不合并。

### 调试历史与验证边界

- attempt1迁移超时，attempt2正式runner拒绝遗留running账本；只清理本任务schema，未绕过migration ledger。
- attempt3目标loopback被DB_TARGET_ADDRESS_DENIED拒绝，改任务自有LAN目标，没有放宽安全策略。
- attempt4/5双MySQL启动与内存压力；旧任务容器一度OOM exit137，恢复后只清理当轮临时schema并还原exited。后改单任务容器双schema。两枚确认属于本轮且无容器引用的匿名volume已精确删除；未prune或停止其他容器。
- attempt6/7 MySQL8.4/mysql-basic@1.0.0真实collector parse_error，保留失败。旧实现要求counter生命周期证据，而资产transport没有权威counter epoch；不伪造证据。改用已安装、正式声明适用的MySQL9.6/mysql-basic@2.0.0 uptime-only包，不改collector。
- attempt7 Agent partial/CONTEXT_UNRECOVERABLE，不重放该调查；其实际用量由持久化usage回执补记。attempt9单摘要工具调查完成。attempt11缺资源ID导致模型拒绝观测读取，尽管run completed也不算成功；该轮报告被后续worker覆盖，保留脱敏浏览器网络证据，未重建不存在的SQL快照。脚本已改声明时skip与按worker PID独立报告。attempt12明确正常输入资源ID，确认真实观测工具证据与成果面板刷新，最终全链测试仍因停用新任务断言失败。
- 最终新增时间有效性断言后没有再发模型请求：已在原始attempt12 JSON上独立检查失败，见acceptance-analysis.json及纯函数复现。与实际运行候选相比仅增加此证据断言；不修改产品代码。
- 本轮前／后端typecheck、contracts:check、meter语法、diff检查通过；scheduler lifecycle/compiler 11/11复用本轮同源码已有结果。专属权限补验1 passed／1 skipped；默认无opt-in为2 skipped，不能计作业务通过。完整主验收1 failed／1 skipped，唯一当时的测试失败为stopNoNewTasks；后续证据审查另确认时间丢失。

### 统一预算与保密

沿MAX-155/MAX-157同一授权账本，累计输入144,681、输出57,261，总计 **201,942/10,000,000 token（2.01942%）**；cached input 88,320为输入子集、不重复相加。本轮增加13,643。无pending，无未知发送重放，未清零。编码代理token及费用遥测不可用，不冒充产品测试用量。

早期qualification全局fetch观察器被OpenAI v4内部node-fetch绕过：生产ledger已预留32000，实际持久化回执usageUnknown=false/provider=null，据此补记input3140/output306/cached1408；底层调用次数不可用，账本sequence21明确为聚合补记，不能称26次实际请求。修复后的observer覆盖SDK ESM/CJS同一原生transport，发送前锁内预留、真实usage结算；本轮最后5个底层请求均有回执。不改Provider、共享路由、请求参数或真实字节；实际为非流式调用。

只读复制已有安全运行时选择的deepseek-flash配置到隔离库，密钥仅内存解密再用随机隔离key加密。报告/附件不含JWT、密码、密钥、私有服务日志或原始trace；旧评论凭据不重复输出。

### 附件清单

ZIP按白名单打包：本报告、full-chain.json（attempt12原始完整报告）、failure-permissions.json、acceptance-analysis.json、budget-checkpoint.json、source-manifest.json、validation.txt、attempt7-failure.json、attempt9-checkpoint.json、attempt11-browser-sanitized.json及5张最终截图。SHA256SUMS列出每个内容文件；ZIP另附sha256。所有产物放项目统一outputs目录，逐个检查实际大小；不交付临时路径链接。
