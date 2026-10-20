# V23 行动执行与效果核验运行手册（P11）

当前规则为 `functional-delivery-1`。本包从已审 P09 `f1839a8eddcd6ff7e3bfd070e6015711e6ddc706` 接续，复用 P07/P08/P10 的授权、执行、效果判断及 helper 安全算法。这里描述正式入口与受控功能测试；不代表生产部署、真实业务资格或长期观察已完成。

## 正式入口与隔离

实际 API 入口是 `apps/db-ops-api/server.ts`（不是 `src/server.ts`），调用 `createOperationsComposition().register()`。它注册计划、独立批准、执行、原回执核对、不可变效果报告以及案例来源链。全部路由使用既有 JWT、实时身份与来源 ACL，返回 `private, no-store`。

启动独立进程：从仓库根目录执行 `pnpm --filter slide-api actions:worker`。该入口从 API 工作目录加载 `.env`，复用 `dbConnection` 与 `loadSecurityConfig`；不导入 server、AgentEngine、Provider 或调查执行器。通用 worker 的所有并发通道排除 `operations.action.execute` 和 `operations.action.verify`。独立 worker 只领取这两个类型，从 SQL outbox 加载原调用者权限上限，先登记核验窗口，再调用既有执行器。队列投递本身不授予写权限。

默认所有 Operations 开关关闭。启用计划和新行动分别需要 `OPERATIONS_ACTION_PLANS_ENABLED=true`、`OPERATIONS_ACTION_DISPATCH_ENABLED=true`。`OPERATIONS_STOP_NEW_DISPATCH=true` 阻止新发送。开关不是资源权限、有效批准、目标资格或签名的替代。

## 受保护配置

配置由部署维护者提供文件路径，不接受 HTTP 上传、命令、SSH 参数或客户端 URL：

| 环境变量 | 文件内容 |
| --- | --- |
| `OPERATIONS_PILOT_MANIFEST_FILE` | 既有签名 envelope：`manifest`、`signature`；包含固定目标、策略、验证器和有效期 |
| `OPERATIONS_PILOT_PUBLIC_KEY_FILE` | Ed25519 公钥 PEM |
| `OPERATIONS_PILOT_SSH_KEY_FILE` | 专用非 root 账户私钥，仅进程内使用 |
| `OPERATIONS_ACTION_TARGET_SIGNATURE_FILE` | 既有 P07 协议的目标签名，base64 文本；签名对象为 `operationsContentHash(manifest.target)` 的 UTF-8 字节 |
| `OPERATIONS_ACTION_VERIFIER_FILE` | 验证器原始 JSON 字节；SHA256 必须等于签名 manifest 中的 `definitionHash` |
| `OPERATIONS_ACTION_HEALTH_FILE` | 严格 JSON `{ "url": "https://collector.example.invalid/action-health" }`；示例不可直接使用 |

manifest 签名对象为 `operationsContentHash(manifest)` 的 UTF-8 字节。使用既有受信签名流程；不在平台自动生成资格或代签批准。目标仍固定为已审 `slide-action` / `slide-action-demo.service` / helper / host pin；本包不扩大目标地址或 shell 能力。

文件必须为普通文件，拒绝符号链接、组/其他用户可写文件；私钥不得有组/其他用户权限。文件读取有大小上限。新执行在预检和发送时重新读配置并核签，缺失、过期、不一致即拒绝。保留历史签名配置和原回执用于只读核对；核对不依赖 dispatch 开关、健康源文件或新工作准入有效期，但目标、计划 hash、operation ID、helper/config hash 必须准确绑定。不要删除未知执行所需的历史材料。

健康源是独立只读采集服务：GET 同一配置 URL，查询参数 `mode=history&from=<ISO>&until=<ISO>` 返回已有采样数组；`mode=sample` 返回一个采样。字段遵循 `healthSampleSchema`。仅接受 HTTPS 或环回 HTTP，无 URL 凭据、不跟随重定向，900ms 请求限制、64KB 响应上限、历史最多100条。采集服务应独立持续采样，不能在收到 history 请求后制造过去的观测。服务未部署或数据缺失不能声称具备恢复证据。

## 执行、停止和恢复

1. 从有效调查结果创建不可变计划；编辑产生新版本并使旧批准失效。
2. 请求者提交准确版本，另一个具有实时权限的主体审核；仅允许 once 批准。
3. `POST /api/operations/action-plans/:id/versions/:version/execute` 提供 `approvalId` 和稳定 `requestKey`。202 只表示已持久化，不表示已执行或已恢复。超时先读取原执行，不更换 requestKey 重发。
4. `GET /api/operations/action-executions/:id` 只读；`POST .../:id/cancel` 请求取消。发送边界之后的取消不证明目标未执行。
5. 未知结果使用 `POST .../:id/reconcile`，只读取原目标的原 operation 回执，不接受人工文本回执，不重启目标。恢复先回收过期 dispatch 为 unknown；不得清理 unknown 的锁、重放 workflow 或改写 once 使用计数。
6. `GET .../:id/verification` 与 `GET .../:id/verification/versions/:version` 读取当前或历史不可变报告；`POST .../:id/verification` 只登记发送前窗口，不能在事后补造基线。
7. 核验固定为发送前120秒、就绪60秒、观察300秒、间隔10秒。测试可以推进显式虚拟时钟，不改变产品常量。缺采样为 inconclusive，无改善为 failed；exit0、执行 succeeded 和业务 resolved 是不同事实。
8. 人工按准确报告版本/hash关闭调查；重开、来源失效或权限撤回使当前结案/案例引用失效。历史证据保留，不覆写为新成功。

停止前核对 PID→端口→cwd→命令→commit→日志；独立 worker 优先 SIGTERM，等待当前有界任务收尾。崩溃后先查询 SQL 与原 helper 回执；不要按端口杀进程或重启未知行动。没有模型必要不调用产品 Provider；本次受控验证零产品模型调用，沿用父任务预算历史且不清零。

## 可复现功能与安全矩阵

执行 `bash scripts/qualification/run-operations-actions.sh`：创建带本任务标签、随机环回端口、无 retained 卷的临时 MySQL9.6，运行 Operations 模块与公开契约测试，再运行实际浏览器套件；退出时只停止本脚本创建的容器。脚本不接触共享3308。完整 API gate 另执行 `bash scripts/qualification/run-investigation-rollout.sh --api`。

| 验收 | 当前自动化证据入口 |
| --- | --- |
| B09–B12 版本/双主体/once、撤权、重复、取消、双 worker/fence/崩溃/未知不重放 | `actions/plan-service.mysql.test.ts`、`actions/execution.mysql.test.ts`；P11 `verification.mysql.test.ts` 改为正式 composition 的 SQL/JWT/HTTP intake |
| B13 固定窗口、无改善、缺采样、不可变报告、关闭/重开 | `actions/verification.mysql.test.ts` 及真实浏览器 `operations-ui.spec.ts` |
| 正式独立 worker 与原调用者上限 | `createActionWorker` 双 worker竞争测试；通用 queue 排除断言；worker入口与 API 分离 |
| 实际目标副作用/丢回执 | 同一测试经 SSH2 握手、签名目标、host pin、生产 adapter、helper 源码子进程；磁盘 restart count=1；只读 reconcile 后仍为1 |
| 缺配置/错签名/错验证器/文件撤回、采集 URL/重定向/超限 | `actions/runtime-ports.test.ts`、既有 `action-environment.test.ts` 和 SSH adapter 安全测试 |
| B14/B18 案例血缘、实时撤权、已审 barrier | knowledge/feedback 与 source-package 回归；复用未变 helper barrier 测试，不重做旧 retained 现场 |
| 实际 Lit 页面完整链路 | 浏览器使用同一个正式 action composition、独立 worker、SQL/JWT/HTTP/隔离 SSH/helper；明示 synthetic 身份、目标、观察和虚拟等待 |

受控 SSH fixture 只把 socket 路由到环回服务器，保留生产 adapter 的固定命令、签名和 host pin。helper fixture 只替换固定路径、root 身份及 systemctl 为隔离磁盘计数，执行原 helper 的 intent/lock/receipt 算法。健康观测和身份为 synthetic；不主张真实 VM/systemd/生产操作。WSS 与此前已审、未变的授权/运输证据复用；不新增人工读屏或 VoiceOver 门禁。各测试计数有交叠，不相加；跳过不计通过。
