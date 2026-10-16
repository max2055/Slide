# P03 案例治理与检索

实施依据：父任务 implementation-1.2，SHA256 `459c81c1b67a3867db8ba181e91da6ebe075e8e676f5d77a3ff735ccae48e915`，B01～B04。基线为 P01 merge `758d1255948c252a56336dd3845c2d8b5541033d`。

## 实施与验证计划

1. `search.ts`：中文 unigram/bigram 和英文词索引；有界查询、结构化适用版本过滤、加密游标。测试中文匹配、长输入、游标篡改和跨查询/权限复用。
2. `store.ts`：使用 P01 schema，事务内读取既有调查/准确结果/证据；完整资源 SQL 授权先于搜索、计数、排序、分页。候选版本不可变，独立人审绑定 hash，修订重新审核，撤回/过期留记录；写入既有事务 outbox。
3. `service.ts`：校验人工确认字段、脱敏、版本与生命周期；同步发送回调在最终实时核验后调用。模型参考单独放在 `case_references`，不进入事实 `evidence`；WS 采用代际校验丢弃 unwatch/切换后的迟到结果，无内容缓存。
4. `routes.ts`：显式注册函数供 P10 装配；认证、严格输入、no-store、错误脱敏。真实 MySQL + 真实监听 HTTP 验证自审、canary、修订、撤回、过期、来源缺失、双角色、撤权计数和发送竞态。测试 fixture 明确 synthetic，不能计入真实准入。
5. focused checks → operations/调查受影响模块 → 后端完整测试/typecheck、安全检查、契约检查。提交 PR 并配置准确 head checks 接续；独立审查由父任务承担。

## 装配边界

P10 安装 `operations/schema/operations-v1.sql`、注册权限、注入 pool/认证、注册路由和 WS 适配。默认功能关闭。构造游标 codec 时各 worker 必须使用同一个持久 32 字节密钥，不能每个 worker 随机生成。服务不调用产品模型、不采集服务器、不授予执行权限。

入口：`new KnowledgeStore(poolProvider, new CaseCursorCodec(key))` → `new KnowledgeService(store)` → `registerKnowledgeRoutes(app, verifyToken, service)`。HTTP 前缀 `/api/operations/knowledge`；GET 搜索、GET `/:id`、POST 候选、PUT `/:id` 修订、POST `/:id/{submit,review,withdraw}`。`revision` 为可变生命周期的乐观锁；`version` 为不可变内容版本，审核必须同时绑定 `contentHash`。拒绝产生新草稿版本；修订已发布内容立即退出检索，不继承审核。

搜索支持 `query/state/faultType/resourceType/productVersion/resourceVersion/limit/cursor`，默认只搜 published。中文词由双字切分匹配，固定 ID 顺序与快照上界分页；页码和全局排序位置不进入游标。权限/来源变化可能返回 409，调用方应清空当前列表与游标后重新搜索。候选列表只向管理者/独立审核者开放。服务不缓存内容，HTTP 使用 no-store。

模型出站用 `service.references(actor, [{id,version,contentHash}], synchronousSend)`，不得重用早先 detail/search 的返回值作为出站权限。`case_references` 是不可信参考数据，与当前 `evidence` 分开；P10 必须在系统提示中保留参考隔离策略。WS 使用 `KnowledgeWatchService.watch/unwatch/refresh`；P10 在重连、授权变化及 outbox 事件后 refresh，按连接清理 unwatch。严禁把 outbox 审计 payload 直接广播给客户端。P09 清空 invalidated 或切换资源后的旧内容；本包没有前端装配。

真实 SQL/HTTP focused 复验：`OPERATIONS_TEST_MYSQL_PORT=<隔离端口> pnpm --filter slide-api exec vitest run src/operations/knowledge`；密码从同名 `..._PASSWORD` 环境变量读取，兼容 `AGENT_RUN_TEST_MYSQL_PORT/PASSWORD`。测试建立随机数据库并清理，不连接平台业务库。

真实案例数/冻结查询质量由 P12 核验。本模块始终返回 `qualification: not_qualified`，直到独立真实数据资格实现与审定接入；不能用 fixture 或仅 SQL 行数自动准入。前端/公开契约/server 装配及真实 Provider 验收分别由 P09/P10/P11 完成。
