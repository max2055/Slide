# MAX-212：调查部分结果与停止溯源

验收基线为本地 main `63b0ef661bf107d2fedcbfedf5347b39e9a04a9f`。GitHub PR 基于远端 main `d9ee65a5b02d1a42d1f77f4389f0ee86acf40e06`，两者仅有规则/技能文档差异，应用及测试代码相同；交付排除本地尚未发布的两笔规则提交。仅修改调查执行、证据/成果整理、调查页面及直接配套测试和生成契约。未修改全局命令面板、服务器诊断或 MAX-209 的服务恢复逻辑。

## 真实停止路径

2026-10-21 对调查 `a8cb8eb2-7d0c-4d43-8c98-12d3424827b5`、Run `a5b60392-c900-4aa4-8300-062a32f44678` 的保留 SQL 事实进行只读核验，未重放模型或工具：

1. `agent_canonical_facts` 有六条工具回执。前五条为资源信息、正式观测、实时/历史指标及指标发现；两次指标查询返回 warning，正式观测列表为空。
2. 第六条 `list_active_alerts` 的参数为 `since=2026-10-21T01:00:25Z, limit=20`，无显式结束时刻；回执原文为 `Error: INVESTIGATION_TOOL_WINDOW_LIMIT`。执行时以当前时刻作为隐式结束时刻，超过一小时窗口几秒，命中 `boundedInvestigationArguments` 的窗口限制。
3. Runtime `turn-loop.ts` 的 fatalError 分支设置 `stopReason=tool_error`，但该分支未设置 resolution。执行器只读取 `resolution.reasonCode`，落入 `INVESTIGATION_RUNTIME_PARTIAL`，随后终态清理 session checkpoint。
4. `persistExecutionSummary` 无条件生成空 facts/claims/hypotheses/recommendations，并把模型、提示词写为 unavailable；与是否已经获得工具证据无关。因此，缺指标不是本次停止原因，也不能解释空结果整理。

原始共享附件只有五条执行状态 tools 项，但 canonical facts 保留了第六条在参数检查前失败的回执；不能仅统计 execution.tools 推断实际检查数。交付附件 `retained-run-diagnosis.json` 为只读提取的脱敏摘要，不是新增结果版本。

历史 Run 未保留实际 Provider/模型路线身份。当前 deepseek-flash 配置不能证明历史调用版本；不回填或伪造。历史请求冻结了 ops@1，但旧结果省略了提示词溯源。新增执行在发送前保存实际配置模型标识、Provider ID/路由哈希（配置工厂提供时）、提示词版本与实际内容 SHA-256、输入哈希。模型标识是配置来源，不宣称供应商不可见的模型内部版本。

## 修复行为

- 优先保留 Runtime 的具体原因；fatal tool 缺失 resolution 时，仅提取明确的调查机器错误码，其他错误使用安全分类码，原回执仍由证据保留。不发布 rejected candidate、推理或任意错误文本。
- 终态/工具失败检查点保存独立的停止回执，恢复沿原 fencing/授权/预算校验，不重放结果未知的发送。
- 从同一 investigation/request/run 的未过期证据整理可引用检查记录、缺口和下一步，保留正常完成时已确认的回答。机器结果不确认业务恢复或根因，取消不发布撤回结果。
- 旧证据在恢复时复用原摘要，避免新摘要算法改变历史 payload hash。历史结果版本保持不变；不借读取新增版本或补造历史模型身份。
- 首屏呈现最近结果、检查记录、缺口和下一步；当前执行与上一份结果明确区分。过程、会话/工具标识、模型与提示词溯源放折叠详情。保留反馈、证据链接、继续调查及键盘焦点恢复。
- 没有放宽一小时窗口、权限或后台工具白名单。下一次调查应使用有效的窄窗口；运行限制与业务未解决继续分开记录。

## 验证与边界

RED 证据：原整理方法把真实模型标识覆盖为 unavailable；调查详情没有可读结果区；旧证据恢复时摘要改变导致身份不一致；正常完成缺少 resolution 时被错误映射成泛化 partial 原因。均有执行过的对应回归测试。

主要验证命令：

```bash
pnpm --filter slide-api exec vitest run src/investigations/executor.test.ts src/investigations/execution-summary.test.ts src/investigations/result-schema.test.ts src/investigations/evidence-store.test.ts src/investigations/contracts.test.ts src/investigations/summary-receipt.test.ts src/investigations/tool-context-projection.test.ts src/investigations/tool-contract.test.ts --maxWorkers=2
# 以下端口指向本任务临时 MySQL 8.4；JWT 使用一次性测试值，不使用生产凭据
AGENT_RUN_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run src/investigations/observation.mysql.test.ts src/investigations/execution-recovery.mysql.test.ts --maxWorkers=1 --testTimeout=20000 --hookTimeout=60000
T06_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-frontend exec playwright test --config playwright.investigation.config.ts investigation-workspace.spec.ts investigation-feedback-workspace.spec.ts
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
```

当前后端 focused 检查 78/78 通过；隔离 MySQL 终态与恢复检查 140 通过、1 条条件跳过；前端 focused 检查 54/54 通过；调查工作区及反馈浏览器回归 27/27 通过。两端 typecheck、build/CSP、contracts:check 通过。详细最终结果和截图见任务交付附件。浏览器使用真实隔离 MySQL、JWT、HTTP、WS、Runner 与页面，Provider/目标工具使用明确标注的受控数据；它证明集成状态与界面行为，不等同于真实模型分析通过。覆盖 1600/390、明暗主题、无水平溢出、键盘折叠、证据弹窗关闭后焦点恢复、反馈可用以及刷新不重放。

扩大回归时出现隔离容器资源/迁移锁争用，初次运行另有测试 JWT 未设置；失败被保留并分类，随后采用独立实例、串行 SQL 套件和测试 JWT 重新验证。未操作其他工作树服务或重启共享数据库。

原 3000/5173 环境身份：5173 为 main 工作树的 Vite（核验时 PID 30659，日志 main-start-20261021-d9ee65a5/frontend.log）；3000 核验时无监听。最终集成与真实服务复验依赖仍在进行的 MAX-209 稳定候选，不将隔离测试或历史运行读取宣称为运行环境验收通过。

产品模型新增调用为 0；任务开始读取 MAX-208 权威预算账本时已结转 4961 token；同批最新累计始终以父账本为准（缓存输入为输入子集，不重复计数），本任务没有重置或改写账本。编码代理实际 token/费用遥测不可用。

## 交付与回退

PR、当前 head、CI 和最终测试数字记录在 MAX-212 交付评论。未合并或部署，不宣称 Max 已验收。新增公开字段为可选 execution 回执，无数据库迁移。需要回退时撤销本任务提交；已产生的可选结果字段可由旧读者忽略，不删除历史证据、Run 或用量记录。
