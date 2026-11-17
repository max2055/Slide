本轮仅修复取证实现 MF-R1/R2/S1，并实施 Chief 已释放的测试专用认证 claim fixture。实现方验证通过，待原 Reviewer 增量独立复审；MAX-684 保持 in_progress、整体 BLOCKED、PR #1010 保持 draft。本轮未推送、查询或触发 CI，未执行九文件入口、TLS、全套浏览器或最终 gate。

main base 为 `451ab8c9969f18d94f17392a74301294de82b5e1`；本轮起点为 `2341b7fbfd910cb59ee0a37b5d2f0903462a50ff`。开工只读核对远端 main 与原实现分支，分别仍为上述 base 和 `00bf3c3defcb698acde20f21d9c17aaae4f33a4a`，未覆盖远端。实现及实际运行绑定 `2d8024aa034661bd508a0c0b25afbc914bfa9f75`；后续仅增加本报告，最终交付 head 在附件 version-binding.json 和 Issue 回复中给出。原 AGENTS 差异保留且不提交。

已认证下载 Reviewer 附件 `01a1eb58-d7d8-72a7-80c0-877ed5de34be`，实测 99,711 字节、SHA256 `0cd70565eb8892d2b5291ac191f3a59e2c35c6dc75d618813a684aa667ace95a`，ZIP CRC 通过；阅读 REPORT 与独立反例。Reviewer 报告提交 `ab63718ed905c0316544b033026d41de1da588c6` 仍归 Reviewer，不冒充进入原 PR。红证据来自该附件，绿证据由本实现方执行，不称独立复审通过。

MF-R1：kind 必须为字符串且为字段表自有枚举；HMAC 字段先检查字符串类型，随后才检验 64 位 hex；必需字段为自有属性。新增数组 kind、数组 HMAC、constructor、__proto__ 反例，拒绝时没有 records 输出，不回显输入。MF-R2：最终必要 result 携带 collectionFailed/dropped；collection 标记写 EIO 后更新的内存状态仍进入 result，若 result 本身丢失则缺必要结果而失败关闭。新 runner 强制要求该状态，业务 0 加采集失败返回 2，业务非零保留原码。collection 与 result 均不能覆盖源头丢失。

MF-S1：离线校验将同场景 kill_before/after 的 caller 与 target PID/start/PPID/namespace、预期信号、序列及时间先后配对；started/wait 与同目标关联，watchdog kill 单独配对。不把目录预操作目标误当成尚未启动的服务。显式检查不依赖 Python assert；真实非零 kill 返回码按原值保留，测试 rc=7 可准确归档。没有改变记录器、服务、tracker、assignment-only trap、DEBUG、默认并发或 12/120 秒预算。

离线 Node 11/11、Python 3/3 通过。以 Reviewer 原脚本内容执行 MF-R1/R2 三项反例，3/3 转绿；其监督错目标/错信号两项反例 2/2 转绿。这里仅选取 MF 反例执行，未把旧 runner 正向样本的无 latch 格式冒充新 runner 的有效输入。作者测试另覆盖成功、业务失败、采集失败、双失败、signal143、旧输入零 launch、敏感字段排除、丢行、身份/时序错配及非零 kill 原码。定向 marker EIO：业务 0→2、业务 9→9，两者 collection=failed、dropped=2。

既有 runtime 26 条离线重收有效、businessExit=1、collection=complete；它们是无新 producer latch 的历史格式，只作显式兼容的 schema 重验，不追溯证明新源头状态。既有监督 46 条经新校验通过，9 组 kill、dropped=0、watchdog=0，原 rc 不变；没有重新执行九文件。原实录最大观察跨度约 0.342ms、同 realtime 域及扰动限制继续保留；配对通过不能证明内核投递或 Bash 赋值位置。

认证 fixture 限测试文件：runtime 用例捕获原 UI 登录响应 token，仅留 worker 内存；runner 给本批生成 nonce 和独占 coordinate 路径。测试 preload 只匹配原 managed API server.ts 进程，其他继承 NODE_OPTIONS 的迁移、Vite、模型或 Playwright 进程不启动 helper。该 API 进程内打开 127.0.0.1 临时端口，加载与 managed API 相同的 security-config 和实际 JWT secret，真实 SQL ActorContextService 经 createVerifyToken 完成认证。handler 将 request.user 原对象作为 claim 第五参，保留 WeakMap credential 的原始来源；不重建 Actor/credential、不增加生产路由、不修改授权策略。coordinate 只含 port，以 wx/0600 创建，不返回凭据。

入口固定 managed owner=admin，SQL 还要求 actor 为 session owner 且 session 含本批 recovery nonce 的用户消息；同 session 一经接纳即不再接受第二次创建，未知写入结果不重试。Node worker 发一次受保护请求，回复仅 runId，然后从原服务只读取得 run，继续原 storage getConnection 失败注入；不调用 recoverCompletion、不直接写绑定列、不辅助恢复。原 60 秒 case、15 秒恢复显示、pending、终态、再次刷新及唯一消息断言均保留。

前置使用任务独占 MySQL 8.4、随机 loopback 端口、全量真实迁移和实际 TCP 请求。SQL/JWT 8 个子用例加父测试为 Node 9/9：合法 token/owner 创建一条 run，三绑定布尔均 true；缺失、过期、无效签名、sessionVersion 失配、跨 owner、跨批次、实时撤销 chat:view 全部零创建。撤权用例在签名后删除真实授权，再发原 token。为避免产品 admin 超级权限使撤权负例无效，前置 helper 使用固定普通 owner fixture-owner；managed helper 默认仍为原 UI admin，身份范围参数只能由测试启动端提供，HTTP 无此参数。

前置失败与业务运行分列：初次 schema 自带 admin 与测试新 admin 重名，在 HTTP 前初始化失败；其后以 admin 作普通 owner 的第一次撤权负例返回 200 并创建了 run，原因是现有 actor-context 对 admin 用户名授予通配权限，不能据此宣称产品越权。修正测试数据为普通 owner 后才得到有效拒绝；所有前置 schema 均在 finally 删除，每次为新独占 schema，没有重发未知 POST，没有修改生产权限或默认共享 DB。失败摘要与最终前置日志均保留，不把初始化失败算成 runtime 业务失败，也不隐藏无效负例。

三项 MF 与前置验证通过后，只执行一次原 managed runtime 三场景，入口 `node scripts/qualification/runtime-browser-evidence.mjs`；recovery/length/reject 3/3、退出 0，耗时约 16.74 秒。实际代码为 `2d8024aa034661bd508a0c0b25afbc914bfa9f75`，启动前对隔离副本 4,923 个受控文件逐个哈希比对（排除原 AGENTS 差异），完全一致。环境 Darwin arm64、Node 24.22.1、pnpm 11.19.0；复用既有依赖及 verifyDepsBeforeRun=false，未声称新 frozen install。原 managed 装配和受控模型替身继续使用，真实模型调用 0。

新脱敏归档 32 条、collection=complete、dropped=0，三个 result 均 passed 且 producer latch false/0。恢复场景 finally 快照为 completed、pending=false、目标消息 1 条、固定恢复样本匹配、长度 12；原刷新恢复、再次刷新及最终唯一消息 SQL 断言均到达并通过。额外只读审计在新 schema 按 recovery 前缀筛出唯一 session，两条 run 均 completed 且三绑定存在，恢复样本仅对应一条最终消息。审计不输出原 ID、绑定值、token 或正文；其 SQL 唯一性范围与 worker HMAC 分别说明，不假装可以跨批反解 HMAC。

只上传结构化允许元数据、固定样本匹配布尔/长度及代码补丁/哈希；原 trace、DOM、error-context、任意正文、认证日志不在附件中。runtime 私有日志仅本机 owner 可读；workflow 仍只上传明确的 evidence.json，coordinate 不在上传路径中。最终归档清单及敏感标记扫描结果随附件，独立脱敏边界仍交 Reviewer。历史缺失 trace 不补造，归档修复不等于历史业务故障修复。

任务 MySQL 精确 ID `b25839574043fd0fda9ea4c52e343f250a51b5919f1bb0d402baf9c7c26590d9`，label 与本 issue 一致，端口 50443；核对身份后优雅 stop、remove 成功。managed 父进程已收集退出，MySQL/API/WS/Vite/受控 Provider 的 50443/31183/28983/5213/28900 均无 listener，未停止任何共享资源。source-policy 0 violation、diff check 通过，受影响语法与离线验证通过。

剩余：原 Reviewer 对此本地候选的独立复审；历史两次监督失败的投递/赋值因果仍缺证据；获准推送后的选中上游、release-artifact 和 ci-gate 完整最终门禁。旧 run44163115865/attempt1 已终态 26 success、4 failure（backend/browser 原始失败，release-artifact/ci-gate 传播）继续复用，不记待定、不重查。已关闭 MF 与未失效业务/TLS 证据、原 artifact 已验证事实、A 非零/EROFS、B 环境差异、历史 401/fatal 与观测限制按原边界保留。没有新增任务/订阅、权限或特权取证，没有人工听读、合并、部署或关闭 #1009。
