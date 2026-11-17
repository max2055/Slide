# MAX-684 Cron 执行与查询响应生命周期闭环

原 managed 装配下未修改的 `cron-live.spec.ts` 一次通过，执行、查询、持久化和刷新闭环已在本地完成。整体验收仍 BLOCKED：当前候选必需 CI gate 尚未确认成功，新增修复待 Chief 交原 Reviewer 汇总复核。MAX-684 保持 in_progress、PR #1010 保持 draft。

## 版本与最小改动

- main base：`451ab8c9969f18d94f17392a74301294de82b5e1`。
- 实施起点：`e3dee63aaaba395e9f6a436317f5eeb54d2617bc`，原分支 `agent/15-backenddev-01/max-684`。最终完整 head 与正常 push 后 PR/CI 单次快照见交付评论和附件。
- 产品仅 `apps/db-ops-api/src/cron/cron-routes.ts` 六处添加 `return`：POST jobs/:id/run 成功202及 catch、GET runs/:runId 成功及 catch、GET runs?requestKey 成功及 catch。
- 新增 `cron-run-lifecycle.test.ts` 23项真实 loopback TCP/socket 回归；原 scripts 创建、jobs 创建和列表回归保留。
- 授权、scope、owner、状态码、错误码、入队/执行、noReplay及全局 hook 未改，公开契约未变化。原 AGENTS 差异未提交；已审四文件、前端、原 spec、超时、其他 CRUD 未修改。

## 同配置分支证据

Fastify 5.12.6；真实 HTTP security、Chat 异步 preSerialization及与 server 相同的异步 onSend。认证身份、service查找和run store transport受控；真实MySQL/JWT另行验证。最终同一测试文件先在起点路由运行，再仅应用上述六行产品修复。

| 分支 | 起点 | 最小修复后 / 处理 |
| --- | --- | --- |
| POST run 成功202 | 状态正确、body 0字节 | 非空JSON、精确四字段合同；triggerJob仅一次，actor/key/空参数准确 |
| runId 查询成功200 | 状态正确、body 0字节 | 精确run JSON，get只调用一次，零trigger |
| requestKey 恢复成功200 | 状态正确、body 0字节 | 精确run JSON，findRequest(job41,actor7,key)一次；零POST/trigger |
| 三入口查job抛错 catch（503） | 各0字节，共3个失败 | 各返回非空、有效脱敏JSON，无后续操作 |
| POST trigger冲突 catch（409） | 0字节 | 保留CRON_IDEMPOTENCY_CONFLICT；trigger一次，不重发 |
| 两查询store抛错 catch（503） | 各0字节，共2个失败 | 非空、有效脱敏JSON，零trigger |
| 三入口missing-job/scope拒绝/helper链 | 全部通过 | 原样保留；404精确JSON，零run操作 |
| 三入口权限拒绝 | 全部通过 | 原样保留；403精确JSON，零run操作 |
| POST参数拒绝、恢复查询缺key、run未找到、跨job runId | 全部通过 | 原样保留；400/404精确JSON及零入队断言 |

最终红：23项中9失败/14通过，失败均为预期状态下body=0，退出1；最终绿：23/23，相关七文件共88/88，退出0。支持这六处发送未与异步handler完成相连的生命周期原因；不把静态缺return推广至其他分支。helper拒绝链虽静态未return reply，本次同配置已通过，因此没有修改。

生产 security hook 将本次503错误体映射为 `INTERNAL_ERROR`，回归按实际公开合同断言，未绕过脱敏。首次绿验证有5项误将内部错误当公开错误的测试预期失败；查明既有hook后仅修正预期，最终红/绿使用一致预期。早期矩阵另有一个重复有效runId案例，最终替换为跨job拒绝；仅重跑受影响测试，未重放浏览器或未知业务请求。

## 独占真实 MySQL/JWT/TCP

沿用并核对任务容器 `a29efbe246f74410cd785f5922466679a6a1f8d13a5ac1849b5601863f618257`，task=MAX-684-jobs；本次PID36106、环回61013、mysqld身份。未访问共享库或私有凭据。生产迁移创建新 `max684_run_probe` schema；真实ActorContext/JWT/权限、CronJobService、RunStore事务、CronManager及脚本SQL执行器。Provider不被调用。

新fixture job14/admin1，POST执行仅一次，202/133字节，精确四字段合同；runId `803af058-7780-447c-80e6-308cdea26854` 与数据库唯一run、workflow_jobs唯一cron.execute行精确对应。初始queued；runId与requestKey查询各200/259字节，与同一持久化run精确相等。恢复只查询，不重发POST。随后对该run调用真实manager.executeRun（此层不冒充worker轮询），终态success、completion.status=success、completedAt及runnerFinishedAt非空。服务关闭、连接池释放、probe schema删除，退出0。

历史run `2efc8f83-8003-48af-bb6a-2a6e7b9aea86` 没有重放。

## 原 managed 浏览器一次执行

完整命令：`pnpm --filter slide-frontend exec playwright test cron-live.spec.ts --workers=1`。原 `PLAYWRIGHT_MANAGED_ENV=1` 装配执行reset、生产迁移、bootstrap、server.ts、WebSocket、Cron manager/worker、Vite；沿用 `QUALIFICATION_CRON_E2E=1`、`QUALIFICATION_CANCELLATION_E2E=1`及本地受控Provider。未改原spec、原断言或超时，没有重试、循环碰绿或付费模型调用。

| 原断言/请求 | 本次结果 |
| --- | --- |
| scripts创建、jobs创建、任务列表显示 | 201/33、201/34、200/19684字节，全部通过 |
| 执行202和runId解码 | 202/133字节，合法UUID，通过 |
| runId轮询、成功展示 | 原断言通过，所有poll指向同一run |
| 原持久化GET | 200/601字节；runId/jobId、success、completion.status及两个完成时间全部通过 |
| 刷新后成功展示、单POST和轮询断言 | 全部通过 |
| finally删除job/script | 各200/0字节，原状态断言通过；空body仅作观察，未扩修 |
| Playwright / pnpm / wrapper | 0 / 0 / 0；1 passed，case7.5秒、总18.9秒 |

SQL按本次job14对账唯一run `d73dc429-8068-4cb5-aeff-dd24297b44c7`，triggeredBy=本次admin1，status=success、两个完成时间非空、errorCode=null；路径与原spec持久化GET一致。finally后本任务job/script均0行，browser schema随后删除。原spec所有验收点均到达。

外置同步ServerResponse.end观察仅记录允许路径/方法/状态/长度和创建id，不新增异步hook；API和Vite两层各一条日志不代表重复POST。SQL归属与原spec单POST断言一起成立，不依赖全局计数。原spec产生的完整run附件/截图/trace及原始日志仅本机保留，交付zip不含任意响应全文。

## 检查、环境与交接

相关七文件为 lifecycle、script-lifecycle、security、actor-scope、job-service、run-store、timeout-config；88/88 PASS。后端 `typecheck`、`pnpm ci:source-policy`及diff检查通过，准确argv/退出码见附件。公开契约未变，未另跑contracts。测试副本与3095个既有受控源码/manifest/lock逐字节一致，新增测试单独绑定；浏览器后仅完善测试矩阵，产品代码、spec、装配和配置未变化，复用该一次浏览器结果。

环境macOS ARM64、Node24.22.1、pnpm11.19.0、MySQL8.4.10、Vitest4.1.8、Playwright1.60.0。复用原任务副本依赖链接，未声称重新frozen install；不冒充CI Ubuntu/x64。早期命令因根目录无依赖/PATH无node退出1/127，按环境启动错误记录，修正cwd和显式runtime PATH后才计有效验证。

probe和browser schema已删除；API31063/WS28963/Vite5193/Provider28900无监听；任务MySQL优雅停止、退出0，保留停止容器。无运行服务待接管，未触碰其他任务资源。

证据由原Issue触发线程附件交付：红/绿、固定元数据及SQL归属/清理、源码绑定、命令/退出码、最小diff、PR及新CI单次快照。正常push后不等待/轮询、手动重跑或新增订阅。保持in_progress/draft；由Chief交原Reviewer一次汇总scripts创建、jobs创建、列表及本轮执行/查询增量。既有九文件/TLS/关闭项按未失效范围复用。当前head必需gate成功与独立复核仍为交接缺口；supervisor实际上传未验证、历史signal/watchdog和401/fatal因果未知及观测限制保留。不恢复人工听读，不合并、部署或关闭#1009。
