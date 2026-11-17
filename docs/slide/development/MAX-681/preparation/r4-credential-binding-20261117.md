# R4：资格验收的平台登录与数据库目标分离

输入 head：`7b9ebe8b3ddb3c346a3ad020bdaeb9ad0628e1b7`；PR #920 base/merge-base：`451ab8c9969f18d94f17392a74301294de82b5e1`。本轮只追加提交；最终完整 head 与命令结果见同次 Issue 评论及受控 REPORT.md。本页是作者修复报告，R4 关闭仍由原 Reviewer 独立复核。

## 行为与输入

三个 release-security 场景曾把 QUALIFICATION_ADMIN_PASSWORD 当作 MySQL 实例密码。两个 release-critical-paths 指标场景及其中的连接弹窗也有同类问题，作为同一缺陷修复。

平台登录继续使用 `qualificationPassword()` / `QUALIFICATION_ADMIN_PASSWORD`。实例创建统一先调用 `qualificationMysqlTarget()`，显式读取 `QUALIFICATION_MYSQL_HOST`、`QUALIFICATION_MYSQL_PORT`、`QUALIFICATION_MYSQL_USER`、`QUALIFICATION_MYSQL_DATABASE`、`QUALIFICATION_MYSQL_PASSWORD`，完整传给实例配置；审批提交使用同一个 database_name，指标连接弹窗使用目标密码。没有回退到平台管理员、viewer、DB_* 或固定端点。目标密码允许显式空字符串，未定义则拒绝；其他字段缺失/空值或端口非法均在登录和实例写入之前拒绝。

变量存在不证明目标获授权。运行方仍须核对平台 baseURL、数据库身份、账号和任务资源归属。目标 schema 中须有该场景的 qualification_approval_counter 等夹具；并发审批还核对目标上的执行历史关联，不能任意指向其他数据库。managed runner 只初始化其自身资格验收 schema，不会替任意目标准备业务表。

## 消费者裁定更正

[更正索引](r4-corrections-20261117.json) 对应 W633/W637/W639，以及同类 W614/W616，逐项绑定当前源码、目标展开行和哈希。[657 条原台账](artifact-fields.json) 保留原 ID、历史包/行/锚点哈希、原分类和先前 consumerReview，同时把当前分类更正为数据库实例驱动认证输入，记录从实例持久化到 reload/SQL/审批的调用链。它们不是管理员/viewer 登录输入。原 351 条调查快照仍按其旧版本解释；本次更正不删除历史记录，不加入扫描例外，也不认定共享秘密已经失效。

## 验证与实际执行范围

- `node --test scripts/ci/*.test.mjs`：65/65，通过。其中新增 11 个 R4 回归直接执行五个实际 spec 回调，以不同管理员/数据库值检查两个接收方和全部目标字段；覆盖五项输入逐项缺失、非密码空值、显式空密码兼容及非法端口。拦截在实例请求处停止，网络/SQL 为零。把同一回归放回输入 head，退出 1，证实原错误无法通过回归。
- `node --test tests/qualification/cancellable-openai-server.test.mjs`：5/5，通过。现有本地取消 Provider 原来对普通非流式 SQL 审核也无限输出，阻塞新增的实际审批场景；现按协议对省略 stream 或 stream=false 返回有界合成审核 JSON，stream=true 保留取消流。此夹具修复直接服务本次 CI 场景，不调用真实模型。
- 前端标准 typecheck、受影响 E2E 的独立 TypeScript 编译通过。后者显式使用已有 Node 类型和仅供 Vite `/src/*` 浏览器导入的声明；不改变仓库配置。首次临时编译缺 Node 类型/Vite 路径报错保留为环境/编译入口记录，不宣称该次通过。
- 实际 Chromium + Fastify + MySQL 9.6：三个 release-security 场景 **3/3 PASS（12.0 秒）**。每次使用新建独占容器、随机映射端口、不同的随机管理员/数据库密码与任务独占服务；SQL 边界、reload、并发审批执行一次/事件链/计数/历史关联、浏览器取消与重试/attempt 关联全部实跑。模型审核仅为本地合成接收器。两个指标场景本轮仅有凭据回归，未据此宣称指标浏览器业务通过。

实际命令为 `pnpm --filter slide-frontend exec playwright test release-security.spec.ts --grep 'direct SQL execution|concurrent approval reviews|approval cancellation and retry' --workers=1`，另显式指定受控输出目录和 line reporter。目标通过本任务宿主机非 loopback 接口接入；容器 ID、镜像 ID、映射与运行记录仅留受控证据。最终服务、容器及匿名卷清理成功，没有写入共享库或更换共享秘密。

失败过程按首个有效错误保留：首次缺本地 Provider；loopback 新目标被产品策略拒绝；两次网络入口选择未建立可用目标连接；随后暴露本地夹具非流式审核不结束；最后导航 `Approval` 模糊匹配同时命中实例链接。分别修正执行配置、夹具和测试定位后重新验证，没有放宽目标安全策略、提高超时或重放未决共享操作。旧运行的超时清理错误与主错误分别保留，各次独占容器均清理成功。

CI 的 browser qualification job 现选择三个实际 R4 场景。MySQL 目标五项配置单独注入，密码与管理员不同；从一次性 runner 的非 loopback IPv4 绑定其自身发布的 MySQL service，平台 DB_HOST 保持独立。浏览器导航按 `nav a[href="/approval"]` 定位，避免实例名称造成模糊匹配。未修改产品 UI 或 API 契约。

## A1–F1 接续与版本边界

| 项 | 本轮结果与仍未完成项 |
|---|---|
| A1 | 五条目标数据库消费者裁定已更正；实际活动消费者/旧账号/窗口仍由 Chief 协调 |
| B1 | 持久注入、两次独立 claim 未执行 |
| B2 | 五个用例分离目标输入并补缺值回归；不等于所有历史入口迁移完成 |
| C1 | 真实共享 JWT 轮换、旧认证失效及会话切换未执行 |
| C2 | 本轮独占库上的 reload/SQL/审批已通过；共享两库改密、旧池/在途事务及采集仍未执行 |
| C3 | 共享业务/密文/备份及唯一账本保全验收未执行；本轮没有真实模型请求或账本变更 |
| D1 | R1/R2、技能/lock 保持关闭，R3 接收独立 PASS；R4 修复待原 Reviewer 统一复核 |
| D2 | 本轮更正不增加扫描例外；旧 PF 身份、二进制像素/CFF 等审查边界原样保留 |
| E1 | 历史下载继续暂停；shallow/远端闭包、历史产物及外部副本完整处置未完成 |
| F1 | 旧 head 7b9ebe8… 的 run 44066221360 / artifact14320433191 仅证明旧候选；本轮新 head 的 CI、合成提交和发布物须分别核验，不能继承旧成功结论 |

完整运行脚本、失败/最终日志、回归反证、资源清理、源码差异与 SHA256SUMS：项目受控 `outputs/max-681-r4-repair/`，目录 0700、文件 0600。不上传浏览器 trace、原始认证请求、实际端点或秘密。本轮交付仍保持原 Draft PR；整单 `in_progress`，没有自审放行、真实切换、历史改写、合并或发布。
