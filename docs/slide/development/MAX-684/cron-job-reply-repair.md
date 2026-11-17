# MAX-684 Cron jobs 创建响应修复

本轮仅在 `POST /api/cron/jobs` 创建成功发送分支添加 `return`，保持 201 和精确 `{ id, message: '创建成功' }` 结构。真实 socket 同配置红绿对照及真实 MySQL/JWT 探针通过；原完整浏览器进入下一首错：`GET /api/cron/jobs` 返回 200 / 0 字节，任务行未显示。**整体验收仍 BLOCKED，MAX-684 保持 in_progress，PR #1010 保持 draft。**

## 版本和范围

- main base：`451ab8c9969f18d94f17392a74301294de82b5e1`。
- 起点：`e500f9e2808587cbc9dd71d2ba154c1c5b4da600`。
- 源码/测试提交：`707466c33952f2a98c4555dc5ddc9cc2d1ed42cc`；后续报告提交不改变被测代码，最终完整 head 见交付评论。
- 分支保持 `agent/15-backenddev-01/max-684`，原 [PR #1010](https://github.com/max2055/Slide/pull/1010)。
- 产品差异只有 `cron-routes.ts:165` 的一行 return；在原 `cron-script-lifecycle.test.ts` 增加 jobs 成功回归，保留原脚本回归。未改全局 hook、已审四文件、前端、原浏览器断言或超时。AGENTS.md 原差异保留未提交。

## 因果与回归

真实 loopback TCP 监听动态端口，注册生产 HTTP security、Chat 异步 preSerialization hook 和同样的异步 onSend 配置。修复前脚本 PASS，jobs 已断言 201，随后 body=0 非空断言失败，测试退出1。保持其他源码/配置一致，只在 jobs 成功发送返回 reply 后，两项均 PASS、退出0。这组控制支持该成功分支提前结束与异步序列化的生命周期竞争；不以相似代码代替本分支红绿证据。

jobs 测试保留真实 identity binding、CronJobDatabaseService 和 INSERT 路径，身份查询和 SQL transport 为替身。断言 201、非空有效 JSON、精确响应结构和 insertId，精确 INSERT SQL/参数、owner/scope/audit/defaults、reload 一次及无 Chat 授权/模型边界调用。不能把此层称为真实 JWT/MySQL 验收。

## 分层验证

| 层级 | 结果 / 退出码 | 边界 |
| --- | --- | --- |
| 修复前 socket | 1 failed / 1 passed，退出1 | jobs 201/0字节；脚本通过 |
| 修复后 socket | 2/2 PASS，退出0 | 相同生产异步 hook；精确结构和创建结果 |
| 相关四文件 | 57/57 PASS，退出0 | cron-job-service、cron-security、cron-actor-scope、cron-timeout-config |
| 后端 typecheck | 退出0 | `pnpm --filter slide-api typecheck` |
| 真实 MySQL/JWT/TCP 探针 | 退出0，child0、schema清理0 | 生产迁移、真实 actor/JWT/权限、ScriptService/CronJobService；201/34字节，有效精确JSON；按 responseId+name+scriptId+owner 查得一行；HTTP complete=true/aborted=false；服务关闭、schema删除 |
| 原 managed 浏览器 | Playwright1 / pnpm1 / wrapper1 | 一次业务重放，下一首错见下文 |
| source-policy / diff | 退出0 | 增量和最终提交区间，命令/日志见附件 |

未改变公开契约，未额外运行 contracts 检查。未机械重跑九文件、TLS或完整全仓 gate；当前候选 required gate 仍待 CI 证明。

## 完整应用浏览器：下一首错

未改命令：`pnpm --filter slide-frontend exec playwright test cron-live.spec.ts --workers=1`。原 managed `serve-e2e.sh` 完成 reset、生产迁移、bootstrap、完整 server.ts、WS、Cron manager、Vite 和本地受控 Provider 装配。保留 CI 的 `PLAYWRIGHT_MANAGED_ENV=1`、`QUALIFICATION_CRON_E2E=1`、`QUALIFICATION_CANCELLATION_E2E=1`，无付费模型调用。此次只有一次业务重放，无准备失败、无重试碰绿。

| 实际请求 | 状态 / body字节 | 原用例结果 |
| --- | --- | --- |
| POST scripts | 201 / 33 | 第16行 JSON 解码通过 |
| POST jobs | 201 / 34 | 第21行 JSON 解码通过，得到 jobId |
| GET jobs | 200 / 0 | 未显示任务行；第37行原5000ms可见性断言失败 |
| finally DELETE jobs / scripts | 各200 / 0 | 原状态断言通过；不冒称 JSON 响应成功 |

**未到达**：确认执行、POST run202、该 run 持久化、轮询和刷新。不是浏览器 PASS。finally 后 SQL 确认固定 fixture 的 job/script 均0行。schema 的全局 cron_runs 总数为1，但本次 fixture 没有发送 run 请求，且未留该历史/后台行归属证据；此计数不能作为本次 run 持久化验收。删除整个专用 schema 后不再补查或重放请求。

下一最小调查/修复候选为 `cron-routes.ts:98` 的 jobs 列表成功发送 `reply.send(jobs)`。本轮只证明浏览器实际读取200/空 body以及可见性首错；该分支静态缺return尚未经单独红绿对照，不宣称已定因。建议 Chief 释放该成功分支及针对性 socket、同一原浏览器回归；当前不扩改该分支或其他 reply。DELETE 的200/空响应另作观察，不在本轮扩修。

## 环境、证据和清理

macOS ARM64，Node24.22.1、pnpm11.19.0、Fastify5.12.6、Vitest4.1.8、Playwright1.60.0、MySQL8.4.10。与旧 CI Ubuntu24.04 x64/MySQL8.4.13不同；与前轮宿主 Node24.11.1不同。复用前轮已修好的任务副本依赖链接（非重新 frozen install），pnpm 使用声明版本及既有 verifyDepsBeforeRun=false 包装。源文件、lock、原spec/managed脚本绑定哈希保留，候选副本与当前源码一致。未读取共享3306/3308或私人凭据。

证据统一放 `outputs/max684-cron-jobs-fix`，脱敏包由 Issue 附件交付：红绿/相关测试/typecheck/source-policy日志、probe固定元数据、允许字段HTTP元数据、源绑定、分层退出码、SQL计数、命令和清理。原完整浏览器日志/trace仅本机保留，附件只给入口/哈希及固定首错；不分发 JWT、Cookie、凭据、请求脚本正文或任意响应全文。

专用 MySQL 容器 `a29efbe246f74410cd785f5922466679a6a1f8d13a5ac1849b5601863f618257`，label `task=MAX-684-jobs`，PID33250，127.0.0.1:57442，命令mysqld。已核对归属；探针服务/schema均关闭删除，managed API31063/WS28963/Vite5193/Provider28900无监听，浏览器schema删除，MySQL优雅停止退出0。保留停止的容器供核对，无新任务network，未停止其他任务或共享服务。

正常push后只单次读取新CI快照，链接和已知状态见交付评论；不等待、轮询、手动重跑或新增订阅。旧run44143098993及前轮e500快照不能证明当前候选gate。

本轮不触发Reviewer，按Chief决定待稳定候选交原Reviewer汇总两处分支增量复核。既有独立PASS、关闭项按原有效范围复用；supervisor实际上传链路未验证，本地包不替代artifact。历史signal/watchdog、401/fatal因果未知和观测限制保留，不恢复人工听读，不合并、部署或关闭#1009。
