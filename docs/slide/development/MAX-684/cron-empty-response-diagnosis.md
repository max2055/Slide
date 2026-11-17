# MAX-684 Cron 创建接口空响应诊断

本轮仅交诊断。实施起点/被测 head 为 `bdbf1ea6a1357047cfa70c2aba5d7d3407246333`，main/PR base 为 `451ab8c9969f18d94f17392a74301294de82b5e1`。PR #1010 为 OPEN/DRAFT，分支 `agent/15-backenddev-01/max-684`。本报告所在提交只增加诊断材料；产品、已审四文件取证机制和 AGENTS.md 均未纳入改动。

## 结论与最小建议

隔离真实 MySQL/JWT/TCP HTTP 对照复现了原首错：POST `/api/cron/scripts` 返回 201，但响应 body 为 0 字节，JSON 解码失败；数据库已写入一行，HTTP 报文完整、未中断。

`apps/db-ops-api/src/cron/cron-routes.ts:431` 创建成功分支在 async handler 内调用 `reply.code(201).send(...)` 后没有返回 reply。`src/chat-routes.ts:80` 新增的全局 async preSerialization hook 即便对 Cron 立即返回 payload，仍增加异步边界。二者组合使 handler 先以 undefined 完成，Fastify 在原序列化链写出前尝试发送空响应。现有 security hook 在 base/head 字节一致；Cron 路由本身也一致，不能因此将失败归为无关既有问题。

本地对照将其归为本次共享 hook 触达的 HTTP 返回生命周期兼容回归。CI 内部时序没有完整请求级观测，不能声称取得了 CI 中同样的内部调用轨迹；本地因果证据与 CI 的 201/空 JSON 首错一致。没有证据指向 watchdog 或传输重置。

建议 Chief 释放的最小产品差异仅为该创建成功分支添加 `return`，让 handler 等待 reply 生命周期。本轮仅在仓库外的导出副本做一行控制实验，未修改工作树产品源码，也未将控制补丁作为产品候选。不要直接应用附件中的控制 diff。建议后续增加真实 socket 回归，保留全局生产 hook、201/JSON/id 断言，再以隔离环境运行原 Cron 浏览器场景及相关失败响应/清理检查；不扩大为全仓 reply 改写。

## 已有 CI 首错与版本

只在 `2026-11-17T18:15:27Z` 读取了一次原 run 的最终状态及 job 清单；没有等待、轮询、重跑或查询新 run。

- [run 44143098993](https://github.com/max2055/Slide/actions/runs/44143098993)：completed/failure，run head 为上述 bdb。
- 实际 checkout `c59265f8d3097035812f5730abe31a5e9de12873`，parents 为 base451 和 head bdb，tree `39f0ac44e6019dfe740e4b23174a0dc1b049d4cb`。checkout 日志与 Reviewer 保存的 commit API 记录相符；run head 不冒充 checkout。
- [browser job 134251046490](https://github.com/max2055/Slide/actions/runs/44143098993/job/134251046490) step12，原命令 `pnpm --filter slide-frontend exec playwright test cron-live.spec.ts --workers=1`：201 断言之后，`frontend/e2e/cron-live.spec.ts:16:52` 解码失败，`SyntaxError: Unexpected end of JSON input`，进程退出1。没有保存实际响应头/body 的原始 CI 观测，不倒推其字节数。
- 30 个 job 中 27 success、3 failure。backend 成功，143/143 结论复用既有证据；失败为 browser、release-artifact 的 selected-check 前置门和 ci-gate 的 selected-check/release 汇总门，后两者并非新的业务首错。完整 job 名称、状态、失败 step 和 URL 见附件 `ci-summary.json`。

认证下载并校验 Reviewer 原包：4,587,232 字节，SHA256 `dffa6a09b916dee9906f90f9a55dc083bf8c436f0a0e0ad4a7a8562496028db0`。原红日志仍在[原审查附件](https://multica.ai/api/attachments/01a1eab5-28b9-7d7b-b6f9-4edbebf4d45f/download)中；本轮只交固定首错行和原日志哈希索引，不重新分发可能包含请求/源码片段的完整日志。

## 真实 HTTP 对照

环境：任务独占 Ubuntu24.04.5 ARM64 容器、Node24.22.2、Fastify5.12.6、tsx4.22.4、mysql2 3.24.3、MySQL8.4.10。依赖复用此前冻结锁安装；base/head 使用相同依赖、配置、生产迁移与观察代码。CI browser 为 Ubuntu24.04 x64/MySQL8.4.13，故本轮不是该 runner 的逐环境重放。未读取平台3306、共享3308或私人凭据，未调用模型或执行目标 SQL。

各场景从 git archive 导出源码，不切换分支；各自建立独立 schema，运行真实迁移、加载真实 SQL actor、在内存签发 JWT、使用生产 verifyToken/权限校验与真实 ScriptService INSERT。请求对象从原 Cron fixture 在内存提取，保持原业务字段及值；响应以真实 loopback TCP 接收。检查原 201、JSON 解码及 id；没有记录脚本正文、token、Cookie、凭证或任意响应全文。

| 场景（每个一次有效业务请求） | HTTP/body | 原断言 | child/docker 退出码 |
| --- | --- | --- | --- |
| 原 head，生产 security + chat hook | 201 / 0 字节 | FAIL：JSON 解码失败 | 1 |
| 原 base，同配置 | 201 / 33 字节 | PASS | 0 |
| head，控制：不注册 Chat routes/hook | 201 / 33 字节 | PASS | 0 |
| head，控制：仅 Cron 创建成功分支 return reply | 201 / 33 字节 | PASS | 0 |

四次均确认 INSERT 一行、HTTP complete=true/aborted=false、服务关闭、schema 删除。去除 Chat 注册也去除了未调用的 Chat 路由；该对照仅说明新增共享链与 Cron 的交互，不是建议删除授权检查。

head 时间线：preSerialization 观察到 status201/hasId=true；onSend 先观察到非字符串/Buffer payload，随后观察到33字节 JSON。客户端已收到201/content-length0；最后服务端 onResponse 元数据为500，不能用它替代线上实际201。Fastify5.12.6 `lib/wrap-thenable.js:31` 在 handler resolved undefined 且尚未发送时调用 reply.send(undefined)，`lib/reply.js:172` 对 undefined 绕过序列化进入 onSend，解释了竞争。观测 hook 同步只记固定元数据，不引入新的 Promise，但仍有时间扰动；不将该时间线推广为所有运行时的必现概率。

最小组合保留生产 HTTP security、Chat hook 和 Cron 路由；未启动完整 server 的恢复引擎、WS、前端和业务后台任务。handleChatSend 为不可达边界，未替代 Cron 的 SQL/认证/HTTP。它是明确定位生命周期交互的真实 HTTP 组合实验，不是完整 Cron 浏览器验收。

首个准备阶段在生产迁移已建立 admin 后重复插入 admin，得到 ER_DUP_ENTRY/退出2；尚未发业务请求。修正 harness 为读取迁移 admin 后进行上述矩阵，没有循环请求碰绿。源导出工具的 Python tar 参数兼容和控制定位断言也在业务请求前纠正。所有准备失败单列，未计为产品通过。

## 命令、退出码与证据索引

源码导出：`git archive <base|head>`。核心命令（SRC 为 base/head，SCENARIO 见矩阵）：

```sh
docker run --rm --name max684-cron-probe-SCENARIO --label task=MAX-684 \
  --network max684-cron-diagnostic \
  -v <frozen-installed-candidate>:/deps:ro -v <diagnostic-output>:/evidence \
  -w /evidence/SRC/apps/db-ops-api max683-supervisor-ready:local \
  node --import tsx /evidence/probe.mjs /evidence/SRC SCENARIO
```

镜像 ID、模块哈希、实际命令、返回码与固定关联 ID 在附件中；输出归档的校验和与下载链接见对应 Issue 交付评论。最初 head 的 shell 使用 printf 汇报后自身退出0，但实际 child/docker退出1；其 JSON也明确 childExit1。矩阵 Python wrapper 退出0表示完成记录，不能冒充 head 原业务 PASS。

- `probe.mjs`：实际最终业务矩阵使用的诊断代码，仅读取 fixture，无原业务正文副本。
- `*-result.json`：允许字段 headers（content-type/content-length/transfer-encoding/connection）、状态、字节数、关联 ID、ns时间线、断言/清理结果。
- `matrix-commands.json`、`execution-index.json`：精确命令和 wrapper/child 分层退出码，准备失败另列。
- `source-bindings.json`、`external-control-only.diff`：base/head/控制副本绑定；外部控制仅一行。
- `ci-summary.json`、`ci-first-error-sanitized.log`、`raw-evidence-index.json`：同 run 最终快照、首错与历史原始证据入口。
- `environment.json`、`max684-cron-diagnostic-mysql-identity.json`、`cleanup.json`：任务资源归属及清理。MySQL 无宿主发布端口，PID、容器ID、cwd、命令、版本核对后仅停止该容器并删除任务 network；没有处理其他测试容器。

## 复用与剩余阻塞

本轮不修改已审四文件，不重跑九文件/单文件监督测试、TLS或全量本地测试。MF-I1/I2/I3、MF-T1/T2及 G1/SQL/browser/runtime 只按原有效范围复用。TLS artifact 的已有核验不代表 Cron trace 上传；supervisor 专项实际上传链路仍未验证。本轮本地归档也不代表 CI artifact 上传成功。

Cron 产品修复尚待 Chief 释放；当前候选 required checks/ci-gate 未成功，整体仍 BLOCKED、MAX-684 in_progress、PR draft。旧 signal/watchdog 根因未知；trace 扰动/截断、BASH_ENV 平台边界、startup及历史401/fatal、内部观测限制、BODY焦点基线照旧保留，不恢复人工听读门禁。不合并、部署或关闭 #1009。
