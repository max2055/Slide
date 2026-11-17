# MAX-684 Cron jobs 列表响应修复

列表成功发送添加一行 `return` 后，同配置真实 socket 红转绿，真实 MySQL/JWT 列表与 fixture 匹配。原完整浏览器已实际显示任务并收到执行202，但202为0字节，在原spec第43行解码失败。**整体验收 BLOCKED，MAX-684保持in_progress，PR #1010保持draft。** 本轮未扩改执行或查询分支，未触发Reviewer。

## 版本与范围

- main base：`451ab8c9969f18d94f17392a74301294de82b5e1`。
- 起点：`0895047019b6b0823ef6164d35e3536bd57a7c73`。
- 产品/回归提交：`061fe175413304abaface8a4a229c82c1081e333`；最终报告提交的完整head见交付评论。
- 原分支 `agent/15-backenddev-01/max-684`、[PR #1010](https://github.com/max2055/Slide/pull/1010)。
- 产品仅 `cron-routes.ts:98` 列表成功发送由 `reply.send(jobs)` 改为 `return reply.send(jobs)`。新增原生命周期文件中的一项socket测试，含四组身份/scope；原scripts/jobs创建回归保留。
- 未改已审四文件、全局hook授权、前端、原spec或超时；未全仓改写reply。AGENTS既有差异保留未提交。公开响应契约未改，未另跑contracts检查。

## 红绿与真实环境

真实loopback TCP动态端口，生产HTTP security、Chat异步preSerialization及同样的异步onSend配置。修复前3项中列表失败、创建2项通过：HTTP200后body=0，非空断言失败，退出1。其他源码/配置不变，仅列表成功返回reply后，列表及原创建回归通过；相关五文件共60项通过、退出0。支持此列表分支未等待异步序列化的生命周期竞争，非静态相似推断。

新增测试保持真实CronJobDatabaseService查询和enabled映射，仅控制SQL transport和身份。验证非空JSON、精确数组/字段/owner、SQL scope参数：无限制管理员全量；仅实例12可见其他owner的该实例任务；无scope空数组；受resourceBoundary约束的管理员仅实例11。当前列表按实例授权过滤，**不按owner本人过滤**；本轮保留此既有语义，不引入新owner政策。

独占真实MySQL8.4.10、生产迁移、真实ActorContext/JWT/权限/TCP，使用原spec fixture在内存创建script/job后GET列表。返回200、19574字节、有效JSON，与真实service数据库列表精确序列化值一致；列表内fixture jobId14/scriptId7/owner1对应，按id+name+scriptId+owner SQL确认一行。probe/child/清理退出0，complete=true、aborted=false、服务关闭、schema删除。此层已含两个创建请求成功解码，不重发未知请求。

后端typecheck退出0，source-policy及diff检查退出0；准确命令、退出码与源码绑定见附件。候选副本3095个受版本管理的apps/frontend/scripts/packages及manifest/lock文件与工作树逐字节一致，无运行源码差异。未重新frozen install，沿用此前任务副本的宿主依赖链接和pnpm verifyDepsBeforeRun=false包装。Node24.22.1/pnpm11.19.0、Fastify5.12.6、Vitest4.1.8、Playwright1.60.0，macOS ARM64；不冒充Ubuntu/x64 CI。

## 原managed完整浏览器：一次有效重放

命令：`pnpm --filter slide-frontend exec playwright test cron-live.spec.ts --workers=1`。原managed脚本完成reset/生产迁移/bootstrap/server.ts/WS/Cron manager/Vite装配；沿用PLAYWRIGHT_MANAGED_ENV、QUALIFICATION_CRON_E2E和QUALIFICATION_CANCELLATION_E2E，使用本地受控Provider，零付费模型调用。原spec及其超时未改，无循环碰绿。一次前置准备误用cwd导致FileNotFoundError，未修改产品，不计业务重放；有效红绿和浏览器另有独立结果。

| 实际请求/阶段 | 结果 |
| --- | --- |
| POST scripts | 201/33字节，原JSON解码通过，scriptId7 |
| POST jobs | 201/34字节，原JSON解码通过，jobId14 |
| GET jobs | 200/19684字节，任务行可见断言通过 |
| 点击执行/确认，POST jobs/14/run | 202/0字节，原202断言通过；第43行 `accepted.json()` Unexpected end of JSON input |
| finally DELETE job/script | 各200/0字节；仅状态断言通过，空body继续仅作观察 |
| Playwright / pnpm / wrapper | 1 / 1 / 1 |

浏览器观测采用外置NODE_OPTIONS同步包装ServerResponse.end，仅记录允许路径/方法/状态/长度和创建id，不添加异步hook、不存正文/认证头。API和Vite两层各记录一次，重复元数据不是两次业务POST。完整日志/trace仅本机保留，附件只给哈希/固定首错；观测工具不能替代原spec断言。

**已按本任务归属对账**：从创建响应id与执行路径关联job14，SQL `cron_runs WHERE job_id = ?` 查到唯一run `2efc8f83-8003-48af-bb6a-2a6e7b9aea86`，triggered_by=本次admin1，status=queued，completed_at和runner_finished_at均空、error_code为空。这是本次请求已持久化的证据，不是全局计数；响应未知后未重发。浏览器finally后fixture job/script均0行；run保留至整个专用schema清理。未将queued说成执行成功，未补发请求或单独GET探针制造浏览器覆盖。

**未到达**：客户端runId解码、按runId查询/轮询、成功展示、原持久化GET断言、刷新后成功展示及单POST/轮询路径最终断言。SQL行归属证明入队，不能替代上述原浏览器验收。

## 同一验收路径的只读生命周期候选清单

以下在浏览器执行前一次检查，范围为原spec和CronRunTracker必经/恢复路径；未自动改写。缺return仅作风险候选，除本次列表红绿外不宣布已逐项定因。

| 分支 | 位置/依据 | 本轮实际状态 |
| --- | --- | --- |
| jobs列表成功 | cron-routes.ts:98；初始加载、静默刷新和reload共用 | 本次唯一产品修复，红绿及真实验证通过 |
| POST job/run成功202 | :279，triggerJob后未return reply | 实际到达202/0字节且SQL入队；下一最小候选，需同配置socket红绿验证再归因 |
| GET jobs/:id/runs/:runId成功 | :309，未return reply | 原spec和正常轮询必经，本轮未到达 |
| GET jobs/:id/runs?requestKey成功 | :296，未return reply | CronRunTracker未知回执恢复路径，本轮未到达，不主动重放 |
| requireCronJobAccess拒绝及上述路由catch | :85、调用者`if (!config) return`等；发送与handler完成未相连 | 仅静态候选；happy-path尚不能证明拒绝/错误body |
| finally DELETE jobs/scripts成功 | :329及脚本DELETE成功发送，未return reply | 实际200/0字节，原spec只读status，保持观察不扩修 |

原spec不走脚本列表/编辑、job详情、日志或preview；这些不加入本轮产品写入。建议Chief基于已发生202空响应释放最小执行成功分支及必要回归，并据该清单决定是否授权同验收路径的查询增量；本轮没有自行越界。

## 清理、证据及交接

证据目录：`outputs/max684-cron-list-fix`，最终脱敏zip由原Issue线程附件交付，哈希见评论。包中有红绿日志、真实probe固定元数据、HTTP允许字段、SQL归属/清理、源码绑定、命令/退出码、最小diff及PR/CI单次快照；不含JWT/Cookie/凭据/脚本正文/任意响应全文。原始日志和trace仅本机保留。

沿用并核对任务MySQL容器 `a29efbe246f74410cd785f5922466679a6a1f8d13a5ac1849b5601863f618257`，label=task=MAX-684-jobs，启动后PID34714、127.0.0.1:59140、mysqld；未操作共享数据库。probe和browser专用schema已删除，原managed服务退出后API31063/WS28963/Vite5193/Provider28900均无监听；专用MySQL优雅stop退出0，保留停止容器，未停止其他服务。无run-owned后台工作遗留。

本轮是阶段交付，保持in_progress/draft；不同时派Reviewer，待Chief交原Reviewer汇总scripts创建、jobs创建、列表及必要增量。正常push后只读一次新CI链接/状态，不等待/轮询/重跑或订阅；旧run及089504701快照不能证明后续候选gate。当前head必需gate成功仍为最终缺口。复用未失效九文件、Linux TLS及既有关闭项证据，不机械重跑。supervisor实际上传未验证、历史signal/watchdog与401/fatal因果未知及观测限制保持原结论。不恢复人工听读，不合并、部署或关闭#1009。
