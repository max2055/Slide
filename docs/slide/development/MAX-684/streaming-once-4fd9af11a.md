本轮按 Chief 评论 `01a1ebc9-3a95-7000-9407-aab507243b43`，仅执行一次原受控 streaming 入口。**业务 FAIL；数值采集完整性标记正常；清理完成；整体验收及监督实际探针仍 BLOCKED。** MAX-684 保持 in_progress、PR #1010 沿用 draft。没有修产品、重跑碰绿或自行放行。

## 版本、核验与命令

实际运行源码 head：`4fd9af11aed4d81cdbe9d040e7c4dfda070176a3`；main base：`451ab8c9969f18d94f17392a74301294de82b5e1`。本报告为运行结束后新增，最终仅报告提交由交付评论及附件版本记录另行绑定，不能把运行重标为报告 head。原 AGENTS 差异保留、未提交；运行时其 diff SHA256 为 `a8459bb4cf270b122b6073b2b51881d0b7ba7e7598ca3ad441d03968c14c22a3`。

运行前通过运行环境 CLI 认证下载 Reviewer 报告 `01a1ebc8-05cb-7bea-ad88-494bfac56318` 和证据包 `01a1ebc8-118c-70dc-a99a-53ae8aef12ce`。包 412,590 字节，15 文件/14 项 manifest，CRC、逐项长度和 SHA256 全通过；包 SHA256 `59f22f3fd06cf3199eea391388b3823d3f77acac1e6f3876b9947a37da32f279`。独立下载报告与包内报告字节相同。

两文件仍逐字节匹配已审 Git 对象和 Reviewer 报告：spec 34,527 字节、SHA256 `e5606c0f7df22fc27249880e6d49f6a9a909c4c99a09c162fd64f95df2a6ec6e`；数值/监督方案 12,945 字节、SHA256 `067421f0002f74daaf11f6a0819428a61cbfdd0173ff80e5eb41d1b06a214d4f`。其余源码未改；另保存 4,932 个 tracked 文件（排除 AGENTS）的运行期哈希。

唯一执行入口，从本任务 worktree 根目录运行：

```sh
pnpm --filter slide-frontend exec playwright test --config playwright.streaming-live.config.ts
```

环境：macOS/arm64，Node v24.22.1、pnpm 11.19.0、TypeScript 6.0.3、Playwright 1.60.0，复用已有 Chromium 1223 安装。失败路径未输出实际 browser.version，因此不把安装元数据称为运行时版本采样。沿用已有依赖，无 frozen install；任务内 pnpm wrapper 显式设置 `--config.verifyDepsBeforeRun=false`，子进程 init-db 继承同一入口。复用依赖中的旧 workspace agent-core 链接在运行前发现，任务本地映射到当前 worktree 的 packages/agent-core，未修改共享依赖。Node 与上轮 v24.22.3 不同，不能声称环境完全相同。

显式环境 DB_HOST=127.0.0.1、DB_PORT=52520、DB_USER=root、NODE_ENV=test、CI=1；空密码仅用于新建独占 loopback 容器，不读取共享数据库或旧私有凭据。MySQL 8.4/arm64 镜像 ID `sha256:c592c15aaf4a1961e15d82eb31ea5987dda862d1c4b1e93424438c0e91dc1f8d`；容器 `af1622a342c8bdba9d79058c0ba46a57d60b24a27a735d9474783150eac5f99d`，标签 slide.task=MAX-684、slide.run=streaming-once-4fd9af11a，容器名 max684-stream-once-21ea93436d。启动前查现有资源及 5199；仅创建/清理本轮对象。数据库 SELECT 1 就绪后才启动入口。

入口 PID 70900，cwd、命令、head、日志位置和容器/端口绑定保存在 binding.json。原配置 workers=1、180 秒、Vite 5199、1000 片段/100000 字节、100 工具、80% 和两项 100ms、真实 SQL/JWT 与受控 Provider 均未改。整个入口退出 1、约 17.024 秒；runner 汇总 1 failed/1 passed（约 16.5 秒）。真实模型调用 0；受控 Provider 的 11 轮是夹具调用，不是付费模型请求。

## 逐项结果与首个失败

以下到达情况由原代码执行顺序及首个失败行确定，没有增加业务观察或修改断言：

| 原检查 | 本轮结果 |
|---|---|
| init-db、真实 SQL 身份/角色/chat:view、UI 登录及 JWT session 创建 | 到达并通过相应初始化/登录断言 |
| 100000 字节负载、legacy auth_ok、100 次工具执行、tool99 暂停及 UI 100 工具 | PASS |
| 首次真正导航刷新、100 工具保持、工具执行 100/Provider 10、完整正文保持 | PASS |
| 释放工具后 completed、durable、SQL 唯一 assistant、100 条工具副作用、Provider 11 | PASS |
| 再次刷新 completed、100 工具，执行次数及 Provider 轮数不增加 | PASS |
| 原比较 parts.bodyBytes ≥100000 | PASS，534571 |
| 原 reduction ≥0.8 | **FAIL，0.17776017473159622** |
| accepted→waiting_model 非负及 ≤100ms | 未到达 |
| receive→paint P95 ≤100ms | 未到达 |
| 成功 metrics、CDP trace 最终写盘 | 未到达 |
| MAX-626 浏览器路由排空/原异常保留回归 | PASS |

首个有效失败：`frontend/e2e/streaming-live.spec.ts:349` 的 `expect(reduction).toBeGreaterThanOrEqual(.8)`，原 Error 为 Expected >=0.8 / Received 0.17776017473159622。属于原业务断言失败；没有初始化、采集或清理错误覆盖它。保留原始错误的数值及错误类型；证据包仅去除其 ANSI 颜色控制符，未分发完整日志。

旧运行实际 `0.12413694796619557` 的 FAIL 以及当时两项 100ms 未到达仍是历史事实。此次仍 FAIL，不从两次差值推导回归、性能改善或队列根因，也不把诊断中的服务端 startup 时长代替未到达的浏览器断言。

## 冻结数值与语义

原 `tool99-before-refresh` 前缀原位冻结，比较值如下；未使用包含刷新流量的全量 wire 重算分母。

| 原比较数组 | 帧数 | 正文 JSON 字节 | 整事件 JSON 字节 |
|---|---:|---:|---:|
| parts：服务端 stream.delta/snapshot 发送层 | 689 | 534571 | 1545238 |
| legacy：客户端接收层 | 82 | 650140 | 689962 |

reduction=`1 - 534571 / 650140`=`0.17776017473159622`。正文 JSON 字节是原递归算法对指定字符串 JSON.stringify 后的字节，不是裸正文长度。parts 原连接全部 send 层另为 691 帧/1545463 JSON 字节，包含 auth/run 帧，不能拿该总数替换原比较的 689 帧。

首次刷新前各层观察：

| 连接 | writer 调用/接受/拒绝 | socket.send | callback 成功/失败 | 客户端接收 |
|---|---|---:|---|---|
| 1 legacy | 130 / 129 / 1 | 82 | 82 / 0 | 82 帧、650140 正文字节、689962 JSON 字节 |
| 2 parts | 691 / 691 / 0 | 691 | 691 / 0 | null：未观测 |

writer 接受不等于 send；send/callback 不证明浏览器消费。连接编号依本 fixture 装配顺序，非生产身份识别。legacy 在 tool99-paused 及首次刷新前已观察到 4009、guard-queue-limit、closed=1、closeRequests=2；仅为精确 reason 的已审枚举映射，不证明唯一根因。该连接 closeQueue=47 事件/1033617 字节、pending=0；采样 peakQueue 为 queued 47/1033617、pending 1/16773。parts 原连接对应采样 peakQueue 为 queued 98/246294、pending 1/119292；均为逐字段采样峰值，不是连续绝对峰值，也不保证各最大值同时发生。原 writer 上限为 128 事件/1048576 字节。

最终共 4 连接、3 快照，刷新连接独立保存。parts clientReceive 始终 null。最终 parts 连接关闭观察为 1005/empty；legacy 保持 4009/guard-queue-limit。完整队列/关闭枚举、callback 和三个边界见 `MAX-684-streaming-numeric.json`。文件 10053 字节，businessExit=1、collectionFailed=0、dropped=0、overflow=0；这里只确认本次采集标记正常、文件保存成功，businessExit 不冒充 runner 退出码。

## 清理、隐私与限制

原 finally 的 browser、legacy、adapter、REST、数据库池、schema、独立 connection 和 workspace 清理阶段均 start/end 完成，cleanupFailed=false、cleanupFailures=[]。独占容器查询无残留 slide_stream schema，精确核对 ID/名称/标签后 docker stop/remove 均退出 0。入口 PID 已退出，5199 和 52520 无监听。临时 REST/WS 动态端口未另行捕获，不能宣称逐端口独立复验；它们有相应 close 阶段完成证据。未触碰其他工作树服务或共享数据库。

初始化原 try 外失败、原清理若永不返回仍不在保存保证内；本次确实到达业务并完成 finally。没有另做观察开销实验。同步 JSON 遍历、WeakMap 读取、冻结复制，以及已有真实 SQL guard、自动 trace 关闭、平台/运行时/复用依赖差异，都可能影响调度与性能可比性。

脱敏包采用文件白名单，只含本报告、数值文件、已清理颜色控制符的诊断、运行绑定/清理/版本/源码哈希、必要已审快照、命令和 Reviewer 认证核验记录。原始 wire、正文、DOM/error-context、trace、截图、完整服务/runner 日志保留本机 private 目录，不上传或入库；结构扫描不声称任意秘密检测。

## 交接边界

监督只保留已审确认表，build-id/schema/具体写后探点和扩展权限仍缺；本轮未读取旧凭据，未执行 root/BPF/perf/ptrace/uprobe，也没有实际监督探针。资源成员提供资料及 Max/有权成员扩展授权后，才由 Chief 协调原 owner 和 Reviewer 核验。其阻塞未拦本轮 streaming 运行。

已关闭 MF 和有效 runtime/TLS/上传证据按原版本复用，不改标新 head；旧 CI 失败及传播、历史缺失/未知仍保留。本轮无推送、CI 查询/重跑、最终 gate、新任务/订阅、未知 POST 重发、人工听读、合并部署或关闭 #1009。报告及脱敏包交 Chief 后，请原 Reviewer 仅增量核验本次版本绑定、冻结数值、断言到达情况、异常/清理和包完整性，不自行再发原场景或实际探针。
