# T11 反馈领域交付与共享装配请求

本阶段实现领域模块和局部真实验收。生产 `server.ts`、公共契约注册和 workspace 主容器仍由父任务按 T08→T09→T11 移交。**本交付不等于完整 T11 出口，也不能释放 T12。**

## 行为与边界

- `feedback-contracts.ts` / `feedback-types.ts` 定义严格、版本绑定的 rating、handling、root_cause、recovery、close 契约与只读历史响应。拒绝客户端伪造确认人/时间、知识发布及未知字段。
- `feedback.ts` 复用 ObservationDatabase 事务与实时权限；固定锁序 Session→Investigation。只有真实用户 operator 可写，viewer 可读，service 不能做人类确认。当前主体、Profile、所有必需资源和结果/证据附加资源均重新校验。
- 每条反馈绑定实际 result ID/version/request/run；新写入只能针对最新结果，并匹配 investigation version。幂等键按 investigation/author 隔离；相同请求重放先重新鉴权，异载荷 409。旧反馈仍保留精确版本且标记 staleResult。
- 人工确认不改写机器结果；人工根因、外部处理、业务恢复分别记录。closure resolved 需要当前未过期证据，真实 observed window 覆盖所声明窗口以及全部必需资源；null/缺失窗口不当作恢复。其它问题状态可关闭但不能携带伪恢复验证。活跃执行拒绝关闭。
- `120_investigation_feedback.sql` 在 main 无同名文件，经正式 MigrationRunner 自动发现，无需注册修改。不可变反馈/服务器归属验证、调查状态版本、durable stream change 同事务提交。负反馈无可信知识写入路径。
- 历史检索返回过期证据 tombstone/hash，不返回 raw；撤权、过期 membership 和 JWT session-version 失效拒绝检索。历史人工确认不因过期变成当前有效证明。
- UI 专属 `investigation-feedback` 复用 app-card/app-form-field/app-empty-state 与按钮/theme token。展示结果版本、人工确认人/时间、过期/旧引用；未知接受重试原 command/key，409 保留草稿，结果切换/权限事件清空敏感数据并丢弃迟到响应。组件未挂载生产 workspace。

## 真实验证

用本任务独占的临时 MySQL 8.4 容器，127.0.0.1 随机映射端口；每次 suite 用随机独立 schema、正式迁移、结束 drop schema。未读取或修改平台/生产数据库。浏览器夹具使用真实 ActorContext/JWT/Fastify HTTP/SQL，证据和 terminal fixture 是明确合成数据，无 Worker/Provider/外部目标调用。

|检查|命令/结果|
|---|---|
|领域单测与真实 SQL/JWT/HTTP|`T11_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run src/investigations/feedback.test.ts src/investigations/feedback.mysql.test.ts`；29 passed，0 skipped|
|受影响 backend 依赖边界|加 contracts、authorization、result-schema、evidence-store 直接测试；71 passed，0 skipped|
|前端组件及复用边界|`pnpm --filter slide-frontend exec vitest run src/app/ui/components/investigation-feedback.test.ts src/app/ui/components/investigation-create.test.ts src/app/ui/controllers/investigations.test.ts`；40 passed，0 skipped|
|浏览器局部真实业务链|`T11_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-frontend exec playwright test --config playwright.feedback.config.ts`；Chromium 1 passed，0 retries/skip；误判反馈→人工根因→无证据关闭拒绝→带观察窗口关闭→撤权拒绝；桌面/375px无溢出，截图随 Issue 附件交付|
|类型/构建/契约|前后端 typecheck、前端 build/CSP、`pnpm contracts:check` 通过；构建既有 chunk/dynamic import warnings，未扩展整改|
|静态检查|本任务11个TS文件 oxlint 0 warnings/0 errors；全仓 lint 无 errors，既有 warnings 不阻塞|

真实 SQL 包括20并发同键仅1 audit/version/event、异键同版本仅1成功、restart、异载荷/过期/跨Run引用、viewer/service写拒绝、成员过期/相关scope撤回、伪造身份、缺观测窗口、多资源证明不足，以及 audit INSERT 后失败时整事务回滚。

## 请求移交的确切共享文件与最小改动

以下是可审阅的装配方案；本 PR **没有修改**这些共享文件。父核验前一 owner PR/合并/释放后，才实施并验证。

1. `apps/db-ops-api/server.ts`：引入 `registerInvestigationFeedbackRoutes`（`./src/investigations/feedback-routes.js`），在现有 investigation route registration 后调用 `await registerInvestigationFeedbackRoutes(fastify, verifyToken)`。复用 server 现有真实 JWT 与默认 pool/authorization。
2. `apps/db-ops-api/src/contracts/public-api.ts`：引入并 spread `InvestigationFeedbackSchemas`。`src/contracts/generate-public-api.ts`：导入该专属 schema，新增 `/api/investigations/{id}/feedback` GET/POST；GET response FeedbackPage，POST body FeedbackRequest/response FeedbackRecord，必填 Idempotency-Key，bearerAuth、400/403/404/409/410/503。生成 `docs/slide/openapi.json` 与 `frontend/src/api/generated/public-api.ts`，再 contracts:check。切换组件类型来源为生成公共类型后保留 transport parity。
3. `frontend/src/app/ui/views/investigation-detail.ts`：引入组件，在当前 detail 下用 `controller.results.items` 最大 version 的实际 result 作为 resultId/resultVersion；传 `detail.id`、`detail.version`、Boolean activeRequest、operator只读提示。`investigation-feedback-saved` 触发现有 `controller.refreshFacts()` 更新三层状态；不得创建第二 Session/Run。父容器权限清空流程保留，错误刷新只能保留当前授权数据。
4. `apps/db-ops-api/src/investigations/store.ts`（共享核心，需单独准入）：现有通用 PATCH 可以重开已经 resolved 的调查且保留旧 problem_status。新的 admission UPDATE 同样只更新 lifecycle/version。装配时必须在**显式重新打开**及**新的 admission**两处把旧关闭问题状态失效为 unconfirmed，避免新执行继承旧恢复结论；仅在现有事务更新里增加字段，不重做执行/权限/ledger。新增真实 SQL/HTTP reopen→admit→新result测试证明旧反馈保留版本、旧恢复不能作为新结论。当前有界模块不修改这个共享核心，故不能宣称完整关闭/重开验收。
5. `.github/workflows/ci.yml`：经父串行所有权加入本专属 SQL 和浏览器命令，使用现有 MySQL service；环境 T11_TEST_MYSQL_PORT/PASSWORD 仅测试值。当前本PR focused CI默认不设置此变量，因此不能把CI中SQL skip算作真实SQL证据；本地零skip证据与生产共享准入分别核验。

MigrationRunner 已自动加载专属SQL，不申请 runner/迁移注册的多余改动。任何公共契约/UI主容器改动均待移交。

## 剩余出口

- 共享生产注册、workspace 接入、重开语义补接及正式迁移装配准入；随后用真实 JWT/HTTP/WS/browser 验证生产入口，局部 HTTP/组件夹具不能替代。
- 父独立 Review、PR当前head required CI、正常merge、main包含merge后才可判对应领域出口；本阶段先交 in_review。
- 40样本/ID/版本/rubric/runner未修改，复用已核验 PR156。零新增外部模型请求，40例仍 unscored；AI质量及硬安全模型评估尚未完成，不用离线检查或受控夹具冒充。
- 原模型累计5/6停发历史保留；本run无子代理、新Issue、生产部署或生产迁移。家族/本run实际token和费用遥测不可用。
