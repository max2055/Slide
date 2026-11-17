MF-F1 本地实现方验证完成，待 Chief 交原 Reviewer 增量复审。MAX-684 保持 in_progress、整体 BLOCKED、PR #1010 保持 draft。MF-R1/R2/S1 已由 Chief 接受独立复核关闭，本轮未重开。

main base `451ab8c9969f18d94f17392a74301294de82b5e1`；起点 `50adea4cd5fdb5291c47c6c17b44e9ff03059589`；实现/测试提交 `b4b37dc564931a304c134a551356760733bc58ac`，后续仅增加本报告，最终交付 head 见 Issue 回复及附件 version-binding.json。开工远端 main/原实现分支分别仍为该 main base 与 `00bf3c3defcb698acde20f21d9c17aaae4f33a4a`，没有覆盖远端。AGENTS 原差异保留且不提交。

通过认证 CLI 下载 Reviewer 附件 `01a1eb76-de9a-7204-af31-5b831e189567`，核验 450,368 字节、SHA256 `95dbe9a67d2b2787b58ba57c785a7a5be90c8aed2528b7f6d14452d1a377822d`、ZIP CRC 和 SHA256.json 的 29 项长度/哈希，全部匹配；阅读 REPORT 及 admission-race.test.mjs。Reviewer 报告提交 `c2434e13a138f324abcc04c253e31c30077c281d` 仍属 Reviewer，不声称已进入原 PR。

根因是首次 admitted.has 在异步 ownership SQL 前，两个合法请求可同时通过；SQL 返回后各自 add 并 claim，Set.add 不替第二个请求拒绝重复。复用 Reviewer 原反例，直接执行只去除 TS 类型的原 handler，在两个不同 requestKey 的查询同时挂起后返回合法行：旧候选 claimCalls=2、两个不同模拟 runId，断言失败、退出 1。没有启动监听、JWT 请求或数据库，这不是两条实际数据库写入的证明。

最小修复只在合法 SQL 范围确认之后、admitted.add 之前增加一次 admitted.has 检查，重复请求固定 403/FIXTURE_SCOPE。重新检查、占用和进入 claim 之间无 await，单进程事件循环中仅一个请求能越过该边界。claim 抛错或结果未知时保持 Set 占用，不自动重试或释放；首个回复仍为既有 403/FIXTURE_CLAIM_REJECTED，后续回复为 403/FIXTURE_SCOPE。首次用户名、owner/session/本批 nonce SQL 范围、真实 JWT/SQL ActorContextService、相同 security-config 和 request.user 原 Actor 第五参全部保留，未改生产授权、服务/tracker、trap、DEBUG 或原预算。

新增 `apps/db-ops-api/tests/runtime-claim-fixture.admission.test.mjs`，使用 VM 模块替身和确定性 deferred 查询直接执行实际 handler，不复制准入实现。依赖替身表示已认证 Actor 与 SQL 范围回复；保留原 Actor 引用、SQL 参数及最小 runId 回复断言，不将其冒充认证矩阵或真实 SQL 验证。

验证命令：

```bash
node --experimental-vm-modules --test apps/db-ops-api/tests/runtime-claim-fixture.admission.test.mjs
```

Node 24.22.1；stripTypeScriptTypes/VM Modules 的实验性警告按原样保留。6 项回归在旧候选为 4 PASS/2 FAIL、退出 1；新实现为 6/6 PASS、退出 0。覆盖正常单请求、两个查询完成顺序各自先返回时只调用一次 claim/另一请求稳定拒绝、顺序以同/不同 requestKey 重复均不再 query/claim、claim 未知异常后同/不同 key 均不能第二次 claim，以及非法 owner 或 SQL 范围不消耗后续合法准入。确定性调度不靠 sleep 或随机重跑。Reviewer 原反例在新实现 claimCalls=1、另一请求 FIXTURE_SCOPE，1/1 PASS、退出 0。

上述调用计数来自离线替身，只证明本 helper 的单次调用边界，不证明实际 SQL 提交次数、认证、权限或新的浏览器结果。旧真实 SQL/JWT/TCP 前置矩阵 9/9 与唯一 runtime 三场景 3/3、退出 0、32 条 complete/dropped0，按 Reviewer 已核验的精确边界复用：旧业务源码绑定 `2d8024aa034661bd508a0c0b25afbc914bfa9f75`，后续 `50adea4cd5fdb5291c47c6c17b44e9ff03059589` 仅增加旧报告；本轮再增加上述一行 helper 检查、离线回归及本报告。不得将旧业务运行重新标注为新 head 的实测。

本轮未启动数据库或其他服务，未重跑浏览器、九文件入口、TLS 或已关闭 MF。未发送真实模型请求、重发未知 POST、推送、查询/触发 CI 或执行最终 gate。source-policy 与 diff 检查通过；附件保留上游验证、原红反例、作者红绿、源码快照/哈希、最小补丁及准确版本绑定，不含原始 trace/DOM/error-context、真实凭据或任意答案正文。

剩余仍为原 Reviewer 对 MF-F1 的独立复审、历史监督投递/赋值根因，以及获准推送后的选中上游/release-artifact/ci-gate 完整最终门禁。旧 run44163115865/attempt1 已终态 26 success/4 failure（backend/browser 原始失败，release-artifact/ci-gate 传播）继续保留，不写待定或借本地成功改绿。有效旧业务/TLS、原 artifact 已独立验证、A 非零/EROFS、B 环境差异、历史缺失/401/fatal 与观测限制不变；不新增任务、权限、订阅，不恢复人工听读，不合并、部署或关闭 #1009。
