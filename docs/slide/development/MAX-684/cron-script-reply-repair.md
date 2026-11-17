# MAX-684 Cron 脚本创建响应修复

本轮只给 `POST /api/cron/scripts` 创建成功分支添加 `return`，等待 Fastify 异步序列化完成。原响应 `{ id, message: '创建成功' }` 和 201 保持。脚本分支回归通过；完整应用原浏览器用例暴露下一处任务创建响应空 body，**整体验收仍未通过，MAX-684 保持 in_progress、PR 保持 draft**。

## 版本和范围

- PR：[#1010](https://github.com/max2055/Slide/pull/1010)，main base `451ab8c9969f18d94f17392a74301294de82b5e1`。
- 本轮起点：`924acc19f1fbc46888df652848974c6f95f522b4`；源码/回归候选提交：`437a6f118`（完整 SHA 见交付评论与证据包）。最终报告提交仅增加本文，不改变被测代码。
- 增量仅为 `cron-routes.ts` 脚本创建成功一行、新增 `cron-script-lifecycle.test.ts` 和本文。已审取证四文件、Chat hook 授权语义、浏览器用例与超时均未修改。AGENTS.md 原有未提交差异保留。
- 不改 `POST /api/cron/jobs` 的成功发送分支；Chief 本轮授权明确限定诊断所指的脚本创建分支。下述新首错交 Chief 决定是否释放下一步。

## 分层验证及退出码

| 检查 | 结果 / 退出码 | 证据边界 |
| --- | --- | --- |
| 修复前新增真实 socket 回归 | FAIL / 1 | 201 后 body=0，非空断言失败，保留原红日志 |
| 最终脚本分支 socket 回归 | 1/1 PASS / 0 | 生产 HTTP security 和 Chat 异步 hook、真实 loopback TCP、非空 JSON、精确响应结构、真实 ScriptService；SQL transport 和身份为替身，精确断言 INSERT 语句/参数/返回 insertId，Chat 授权及模型边界未调用 |
| 真实 MySQL/JWT/socket 探针 | PASS / docker 0、child 0、清理 0 | 生产迁移、真实身份/JWT/权限/ScriptService，201 / 33 字节 / JSON id；查询确认 INSERT 一行，HTTP complete=true、aborted=false；关闭服务并删除独占 schema |
| 后端 typecheck | 宿主 pnpm / tsc 0 | Linux 首次进程退出137、无诊断，原因未证实，不算 PASS；宿主执行同候选 `pnpm --filter slide-api typecheck` 通过 |
| 原 `cron-live.spec.ts` 完整应用 | FAIL / Playwright 1、pnpm 1、Python wrapper 1 | 见下文；不是组合探针冒充完整应用 |
| `pnpm ci:source-policy`、`git diff --check` | 0 | 最终提交另保留区间检查结果 |

真实 socket 回归位于默认 Vitest 收集范围，无私人凭据、开发者路径、固定监听端口或外部数据库依赖。真实持久化另由探针确认，不能把 SQL 替身的断言称为 MySQL 验收。修复前真实 MySQL 红证据继续引用[诊断交付](./cron-empty-response-diagnosis.md)，本包附原 head 元数据及其绑定信息。

准备失败与中间编辑均单列：最初 Vitest 命令误用了版本路径，其后 Vite 无法在只读依赖链接内建立临时目录，均未进入用例；修复任务副本依赖布局后才执行原红回归。首次一行编辑误匹配同文案的 jobs 分支，回归仍红；该编辑已撤回且未提交，最终差异仅脚本分支。浏览器第一次因迁移前的本机依赖链接失效而未启动，第二次缺 CI 已有的 cancellation provider 标志而在 API 启动报 `LLM_CREDENTIAL_NOT_CONFIGURED`；修正环境后只进行一次有效业务重放。没有循环业务请求、增加超时或削弱断言。

## 完整应用原浏览器首错

原命令未改：

```sh
pnpm --filter slide-frontend exec playwright test cron-live.spec.ts --workers=1
```

通过原 Playwright managed webServer 启动未改的 `serve-e2e.sh`，执行完整迁移、bootstrap、真实 `server.ts`、WS、Cron manager 和 Vite。沿 CI 设置 `PLAYWRIGHT_MANAGED_ENV=1`、`QUALIFICATION_CRON_E2E=1`、`QUALIFICATION_CANCELLATION_E2E=1`。后者配置原有本地受控 Provider，未发送付费模型请求。MySQL 及服务端口均为本任务独占；未读取共享3306/3308或私人凭据。

一次有效业务重放的脱敏 trace 元数据：

| 请求 | 状态 | body 字节数 | 结果 |
| --- | --- | --- | --- |
| `POST /api/cron/scripts` | 201 | 33 | 原第16行 JSON 解码成功，取得 scriptId |
| `POST /api/cron/jobs` | 201 | 0 | 第21行 `job.json()` 抛 `SyntaxError: Unexpected end of JSON input` |
| finally `DELETE /api/cron/scripts/:id` | 200 | 0 | 原状态断言通过；不将此响应记为 JSON 成功 |

浏览器结束后独立 SQL 查询：固定 fixture 名的 job 有1行、script有0行；说明 job 已写入但未得到可解码响应，不能自动重发。随后删除整个本任务 schema。未到达执行202、持久化 run、轮询及刷新验收，不能声称 Cron 浏览器通过。

下一步最小候选位置为同文件 jobs 创建成功发送分支（当前约165行），静态同样缺少 return；本轮实际证明的是201/空 body及已落库，不将这一下一分支未经独立对照的因果推断写成已完成修复。建议 Chief 明确释放该分支及相同 socket/原浏览器回归，继续由本 owner 在原 PR 接续，不做全仓 reply 改写。

## 环境、证据和清理

组合/socket探针：Ubuntu24.04.5 ARM64容器、Node24.22.2、Fastify5.12.6、Vitest4.1.8、MySQL8.4.10。完整应用浏览器：macOS ARM64、Node24.11.1、pnpm11.19.0、本机 Chromium、同一独占 MySQL8.4.10；与旧 CI 的 Ubuntu24.04 x64/MySQL8.4.13 不同。宿主复用已有依赖并仅在任务副本修复迁移失效的直接链接，未声称重新 frozen install；精确版本和 lock 对照见 `environment.json`。两个副本的相关源文件逐字节对应候选，见 `source-bindings.json`。

证据位于统一 outputs 下 `max684-cron-fix`，脱敏附件通过 Issue 提供可访问下载。包内含红/绿回归日志、探针及固定元数据、精确命令/分层退出码、源绑定/最小差异、浏览器固定首错和允许字段的 HTTP 元数据、SQL计数及清理结果。原 browser trace 和完整服务日志仅本机保留，不分发其中可能包含的 JWT、请求正文或任意响应全文；证据包不含这些内容，也不含 Cookie、私有凭据或脚本请求正文。

本轮 MySQL 容器 ID `97148147b055272d3673f48e9ffe721d327eb3e783e947f621cc0d038d69f6f3`、PID31246、宿主随机端口55545、mysqld命令、cwd、任务label及日志入口已经核对。脚本业务探针服务/schema均清理；浏览器服务由原 supervisor 结束，任务 API/WS/Vite 端口无监听，专用数据库删除、MySQL优雅停止、任务network删除，均退出0；未停止共享服务。

## 交接边界

正常 push 并回读 PR 身份；准确最终 head、新 CI 链接及单次已知快照见 Issue 最终评论。不等待、轮询、手动重跑或订阅 CI。旧 run44143098993 终态失败不能证明本候选；当前 required gate 成功仍为整体缺口。

本轮不触发 Reviewer，由 Chief 在稳定候选后交原 Reviewer 增量复核。既有独立 PASS 和 MF-T1/T2、MF-I1/I2/I3 关闭项按原有效范围复用；未重跑九文件/TLS全量。supervisor 实际上传链路仍未验证，不制造失败。原 signal/watchdog 根因未知及既有观测限制保持，不恢复人工听读，不合并、部署或关闭 #1009。
