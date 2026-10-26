# Slide 项目整体审查与改进建议

审查开始：2026-09-10；报告完成：2026-09-11（Asia/Shanghai）。基线：`main@dfef2f0793a845ef258aae1aef52c49b9ebd5cdc`。采用 repo-scan 的结构盘点方法，对生产入口和高风险链路进行深入抽样；不是逐行全量审计，也不代表生产运行验收。

**判断：项目具备可保留的基础，无需推倒重写。当前最需要改善的是配置、错误和任务状态的确定性；其次是删除已废弃代码、落实共享组件与补齐行为门禁。已有迁移账本、权限/工具策略、结构化分析结果及隔离执行机制应继续保留。**

本次只新增审查产物，未修改业务代码、启动服务、连接真实数据库、执行外部同步或进行 Git 提交。

## 范围、方法与限制

- 覆盖前端、API、agent-core、sandbox-controller、迁移、测试和发布配置；排除具体修复、依赖升级和线上变更。
- 验收为：模块盘点、重点问题的代码/调用链证据、必要定向检查、按优先级给出方案与可执行验收。
- 单主代理执行，子代理数 0、深度 0、并发代理峰值 1。约 25 分钟软时间盒；用户未给 token/费用硬预算，实际 raw/cached/output token 和费用遥测不可用，不用估计数字冒充实际用量。
- 入口图解析静态 import/export 和字面量动态 import；不能证明反射、字符串加载、外部使用不存在。所有未到达项只作为候选，未据此自动删除。
- 仓库原有 AGENTS.md 修改、评估文档、xlsx、tar.gz 等未跟踪文件不归为已提交的无效资产，也未改动。

## 模块判断

行数含该模块内 Git 跟踪的 TS/JS/MJS/CSS 及测试，不代表纯业务代码量。

| 模块 | 代码文件 | 行数 | 测试文件 | 处置判断 |
|---|---:|---:|---:|---|
| frontend | 381 | 88,476 | 80 | 保留 Lit 架构；清理历史 UI，收敛共享行为 |
| apps/db-ops-api | 499 | 97,056 | 236 | 保留业务能力；按域提取路由与统一边界 |
| packages/agent-core | 19 | 5,094 | 9 | 核心资产；修正 timer 和任务生命周期 |
| apps/sandbox-controller | 11 | 689 | 5 | 核心资产；补入 CI，不建议重写 |

Git 跟踪文件共 1,851 个，包含规划/文档/配置；未发现被跟踪的 node_modules/dist/vendor 目录。发现两份被跟踪的 test-results/.last-run.json，宜删除并忽略。前端旧 UI 存在上游迁移痕迹，但本次未做许可证审计，不把它们直接认定为违规 vendoring。

## 优先级总览

P1：优先修复，影响用户配置或业务结果可信度。P2：进入近期改进批次，修复具体缺陷或减少维护成本。下面的优先级与“是否已在生产复现”分开记录。

| 编号 | 优先级 | 领域 | 建议 |
|---|---|---|---|
| R01 | P1 | LLM 配置 | 取消隐式换 Provider，统一测试与实际运行的配置入口 |
| R02 | P1 | 错误语义 | 停止把数据库故障伪装成空数据 |
| R03 | P1 | 任务生命周期 | 让超时、完成和失败共用一个终态决策 |
| R04 | P2 | 无效代码 | 删除已确认废弃入口，分批核实历史 UI 与依赖残留 |
| R05 | P2 | 兼容机制 | 移除与启动迁移约束冲突的缺列兜底 |
| R06 | P2 | 共享组件 | 修复 app-dialog 的聚焦与键盘交互 |
| R07 | P2 | 设计一致性 | 落实共享组件边界，收敛两套 UI 实现 |
| R08 | P2 | 架构与契约 | 按业务域拆出可注入路由，逐步统一错误和类型边界 |
| R09 | P2 | 测试与 CI | 让门禁验证行为，并覆盖实际发布模块 |
| R10 | P2 | 资源生命周期 | 清理 Agent 成功请求遗留的超时定时器 |
| R11 | P2 | 发布可追溯性 | 让源码、前端产物与 manifest 来自同一个 Git 快照 |
| R12 | P2 | 工程脚本 | 修正 smoke 退出码，并清理不可复现的工具入口 |

## R01 · P1 · 取消隐式换 Provider，统一测试与实际运行的配置入口

**证据状态：** 源码确认；隔离探针复现。

**发现：** createLLMProvider 在 Anthropic 分支读取了 baseURL 却没有传入构造器，同时把数据库密钥与模型写入 process.env。禁用该 Provider 后，环境变量兜底仍可复用旧密钥。LLM 连接测试传入 baseURL，常规 LLMService 与 Agent 的 Anthropic 构造却未传入，形成“测试成功、实际请求走另一地址”的差异。

**影响：** 配置中的代理地址或供应商选择不能可靠约束运行行为；显式禁用配置也可能失效。Agent 工厂还要求所有 Provider 都有 apiKey，与 LLMService 对本地无密钥模型的处理不同。

**建议：** 提取一个小型 Provider 配置解析/工厂，显式传入 apiKey、baseURL、model、apiFormat、deploymentType；测试连接、聊天和后台分析共同使用。区分未配置、显式禁用、配置读取失败，不把三者都转换为环境变量兜底。保留环境变量模式时，应由显式配置选择，并显示当前来源。

**验收：** 用同一组配置分别调用连接测试、聊天和后台分析，断言最终 SDK 配置一致；禁用后不得复用旧密钥；无密钥本地模型可按配置使用；数据库故障返回配置不可用。

代码依据：

- [apps/db-ops-api/src/adapter/get-agent-engine.ts:244](/Users/max/Coding/40-Slide/apps/db-ops-api/src/adapter/get-agent-engine.ts:244)
- [apps/db-ops-api/src/adapter/llm-provider.ts:128](/Users/max/Coding/40-Slide/apps/db-ops-api/src/adapter/llm-provider.ts:128)
- [apps/db-ops-api/src/llm-service.ts:111](/Users/max/Coding/40-Slide/apps/db-ops-api/src/llm-service.ts:111)
- [apps/db-ops-api/src/llm-service.ts:914](/Users/max/Coding/40-Slide/apps/db-ops-api/src/llm-service.ts:914)

## R02 · P1 · 停止把数据库故障伪装成空数据

**证据状态：** 调用链确认。

**发现：** getManagedInstances 捕获查询错误后返回 []，GET /api/database/instances 随后正常发送该列表；上层的 500 分支无法收到被吞掉的异常。getAllProviders/getEnabledProviders 也把读取故障转换为 []。同一个实例服务中的 listActiveInstanceIds 已采用明确错误，说明项目内已有可复用做法。

**影响：** 用户会把数据库不可用理解成“实例被清空/没有配置”；自动流程可能把依赖故障当成不存在，再触发额外兜底。日志记录并不能修复 API 语义。

**建议：** 列表成功无记录才返回 []；按 ID 成功无记录才返回 null。连接或查询失败抛出带 code/cause 的错误，在路由边界统一映射为 503/500。只允许缓存、装饰性信息等明确非关键数据降级，并附 stale/unavailable 状态。收紧异常前同步补齐后台 Promise 的 await/return。

**验收：** mock pool.execute 拒绝：实例列表返回错误状态而非 200 []；真实空表仍返回 200 []；Provider 读取失败不触发隐式切换。

代码依据：

- [apps/db-ops-api/src/instance-database-service.ts:179](/Users/max/Coding/40-Slide/apps/db-ops-api/src/instance-database-service.ts:179)
- [apps/db-ops-api/server.ts:687](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:687)
- [apps/db-ops-api/src/llm-database-service.ts:150](/Users/max/Coding/40-Slide/apps/db-ops-api/src/llm-database-service.ts:150)
- [apps/db-ops-api/src/instance-database-service.ts:158](/Users/max/Coding/40-Slide/apps/db-ops-api/src/instance-database-service.ts:158)

## R03 · P1 · 让超时、完成和失败共用一个终态决策

**证据状态：** 源码确认；时序探针复现。

**发现：** Bridge 启动独立的 120 秒轮询，超时后直接 failAnalysis。后台 invoke 最多 8 轮、每轮 LLM 超时 60 秒，未使用该轮询的取消信号。failAnalysis 的 UPDATE 只有 id 条件；completeAnalysisEnvelope 只排除 completed，仍允许 failed 改回 completed。

**影响：** 最后一次轮询读到 running 后，任务可能完成，但紧接着被超时写回 failed；晚到结果也可能把失败改回完成。隔离时序探针已经复现 completed 被覆盖为 failed。

**建议：** 由执行任务拥有唯一 deadline 和 AbortController；轮询只观察状态。完成/失败采用带预期状态的条件更新并检查 affectedRows，明确晚到结果的记录规则。直接串联 Bridge 的 Promise，避免依赖内层吞错来维持稳定。

**验收：** 用 fake timers 覆盖最后一轮查询与完成写入交错、超时后晚到结果、取消、重复完成；终态不得互相覆盖，超时必须传递至执行层。

代码依据：

- [apps/db-ops-api/src/ai-agent-bridge.ts:110](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-agent-bridge.ts:110)
- [apps/db-ops-api/src/ai-analysis-database-service.ts:551](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-analysis-database-service.ts:551)
- [apps/db-ops-api/src/ai-analysis-database-service.ts:318](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-analysis-database-service.ts:318)
- [apps/db-ops-api/src/ai-analysis-database-service.ts:286](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-analysis-database-service.ts:286)
- [apps/db-ops-api/src/adapter/direct-adapter.ts:926](/Users/max/Coding/40-Slide/apps/db-ops-api/src/adapter/direct-adapter.ts:926)

## R04 · P2 · 删除已确认废弃入口，分批核实历史 UI 与依赖残留

**证据状态：** 旧 RCA 已确认；其余为清理候选。

**发现：** 旧 RCA 的 private _executeAnalysis 没有调用者，TypeScript noUnused 也报告该入口未使用；其内部格式化、锁信息收集与 LLM 解析链仍完整保留。前端 app-polling 仅剩注释，renderUsageTab 直接返回 nothing；静态入口图发现 44 个前端未到达候选文件，包括旧设备授权存储、聊天组件与 usage 工具。dreams.css 的 1,162 行仍被主样式导入，业务模板没有查到 dreams 类使用。

**影响：** 维护者需要同时理解新旧实现，误改或复活旧路径的概率上升；无调用 TS 通常会被 tree shaking 剔除，不能直接声称它们都增加 bundle。全局导入 CSS 则应单独检查实际产物。

**建议：** 先删旧 RCA 私有执行链及独占 helper/import。再按入口、动态加载、自定义元素注册、测试、公开 API 五类引用核实候选。优先排查前端 marked、@create-markdown/preview、cron 等无业务导入候选；保留当前 markdown-it 与在用的 device-identity。不要一键删除整个 app/src 或所有候选文件。

**验收：** 删除确认死代码后 typecheck 和对应模块测试通过；所有路由能加载；前端构建产物对比 CSS/JS 大小；移除依赖前用 pnpm why 和干净安装验证。

代码依据：

- [apps/db-ops-api/src/alert-rca-service.ts:173](/Users/max/Coding/40-Slide/apps/db-ops-api/src/alert-rca-service.ts:173)
- [frontend/src/app/ui/app-render-usage-tab.ts:3](/Users/max/Coding/40-Slide/frontend/src/app/ui/app-render-usage-tab.ts:3)
- [frontend/src/app/ui/app-polling.ts:1](/Users/max/Coding/40-Slide/frontend/src/app/ui/app-polling.ts:1)
- [frontend/src/app/styles.css:8](/Users/max/Coding/40-Slide/frontend/src/app/styles.css:8)
- [frontend/src/app/styles/dreams.css:1](/Users/max/Coding/40-Slide/frontend/src/app/styles/dreams.css:1)

## R05 · P2 · 移除与启动迁移约束冲突的缺列兜底

**证据状态：** 源码与迁移约束确认。

**发现：** completeAnalysis 遇到 execution_trace 缺列时重试一份不写该列的 SQL；但服务启动已经先执行 MigrationRunner，且 schema invariants 明确要求 ai_analysis.execution_trace 存在。该运行期兼容分支与当前启动契约矛盾。completeAnalysis 本身仍被 SQL 审计、数据库日志与容量预测调用，不能整段删除。

**影响：** 维护两份更新 SQL；手工删除列等 schema 漂移可能被兼容分支掩盖，执行迹静默丢失。

**建议：** 明确最低受支持 schema 后，删除运行期缺列重试并报告 schema drift。历史 checksum 白名单和向前修复迁移有具体已部署版本依据，应保留到相应升级路径正式退出。

**验收：** 缺列时拒绝启动/明确报错；空库、已支持旧版本升级、重复启动通过；正常完成分析仍持久化 execution_trace。

代码依据：

- [apps/db-ops-api/src/ai-analysis-database-service.ts:245](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-analysis-database-service.ts:245)
- [apps/db-ops-api/server.ts:211](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:211)
- [apps/db-ops-api/src/migrations/invariants.ts:11](/Users/max/Coding/40-Slide/apps/db-ops-api/src/migrations/invariants.ts:11)
- [apps/db-ops-api/src/migrations/runner.ts:15](/Users/max/Coding/40-Slide/apps/db-ops-api/src/migrations/runner.ts:15)

## R06 · P2 · 修复 app-dialog 的聚焦与键盘交互

**证据状态：** jsdom 隔离复现。

**发现：** 组件默认使用 Shadow DOM，_trapFocus 却调用 this.querySelector 查找位于 shadowRoot 内的 role=dialog。探针打开弹窗后，焦点仍在外部触发按钮。函数实际只尝试初始聚焦，也没有 Tab/Shift+Tab 环绕处理。

**影响：** 键盘用户可能继续操作背景；Escape 监听在弹窗内部，焦点未进入时也无法可靠触发关闭。所有复用该组件的页面都受影响。

**建议：** 从 renderRoot 定位内部元素，并正确包含 slot 中的可聚焦内容；使用经过验证的原生 dialog 或实现完整焦点环绕、关闭恢复焦点和背景不可交互。先修好共享组件，再推广迁移。

**验收：** 浏览器测试打开后焦点进入、Tab/Shift+Tab 不离开弹窗、Escape 按 closable 语义处理、关闭恢复触发按钮；覆盖 slotted input 与嵌套 Shadow DOM。

代码依据：

- [frontend/src/app/ui/components/app-dialog.ts:35](/Users/max/Coding/40-Slide/frontend/src/app/ui/components/app-dialog.ts:35)
- [frontend/src/app/ui/components/app-dialog.ts:48](/Users/max/Coding/40-Slide/frontend/src/app/ui/components/app-dialog.ts:48)
- [frontend/src/app/ui/components/app-dialog.ts:169](/Users/max/Coding/40-Slide/frontend/src/app/ui/components/app-dialog.ts:169)

## R07 · P2 · 落实共享组件边界，收敛两套 UI 实现

**证据状态：** 源码确认；未做全页面视觉验收。

**发现：** alerts 同时保留手写 card、三个 modal-overlay、form-group；servers-page、instances-db、index-management 等也使用手写 card。全局 components.css 为 4,601 行，页面内还有各自样式。design-tokens 测试对迁移页面只要求出现任意一个 text/space token，不能证明页面已遵守组件规则。

**影响：** 按钮、弹窗、空状态与表单行为容易漂移；每次修改设计或可访问性都要重复处理。问题不是是否出现硬编码这一单项，而是公共行为没有共同实现。

**建议：** 从 alerts 的三类弹窗开始，迁移到修复后的 app-dialog/app-form-field；卡片和空状态按页面迁移。为新增违规设置增量 lint/AST 规则，已有遗留列白名单逐批减少；避免一次性重写所有 CSS。

**验收：** 目标页面使用共享组件；不同主题与窄屏下无溢出；以键盘交互和渲染断言验证迁移效果，禁止用“源码含有 token”替代验收。

代码依据：

- [frontend/src/app/ui/views/alerts.ts:1594](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/alerts.ts:1594)
- [frontend/src/app/ui/views/alerts.ts:1809](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/alerts.ts:1809)
- [frontend/src/app/ui/views/alerts.ts:2015](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/alerts.ts:2015)
- [frontend/src/app/ui/views/__tests__/design-tokens.test.ts:70](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/__tests__/design-tokens.test.ts:70)

## R08 · P2 · 按业务域拆出可注入路由，逐步统一错误和类型边界

**证据状态：** 结构与配置确认。

**发现：** server.ts 有 6,104 行，同时承担启动、迁移、路由、任务编排与内联 SQL；database-service.ts 有 3,221 行。API 与前端 tsconfig 均 strict:false，且未继承根配置；前端 ApiClient 同时兼容 {code,data} 与裸响应，大量页面直接 authFetch 后自行解析。项目已有 TypeBox 公共契约与独立 register*Routes，可作为收敛起点。

**影响：** 修复一个业务域容易触碰启动与其他模块；新增接口继续扩张任意形状，前端为了兼容而堆叠判断，测试被迫读取 server.ts 文本。

**建议：** 按实例、LLM、告警等业务域渐进提取 registerXRoutes(app, dependencies)，入口保留装配。统一错误结构和 HTTP 语义，为触达接口增加 schema/生成类型；传输层只解析一次。不为全仓马上增加通用 Repository/DI 框架，也不先强制所有成功响应套同一 envelope。

**验收：** 路由可用 Fastify inject 在不启动真实服务的情况下验证；改一个业务域无需编辑其它域；为新/触达模块启用严格类型，存量按基线迁移。

代码依据：

- [apps/db-ops-api/server.ts:200](/Users/max/Coding/40-Slide/apps/db-ops-api/server.ts:200)
- [apps/db-ops-api/src/database-service.ts:1](/Users/max/Coding/40-Slide/apps/db-ops-api/src/database-service.ts:1)
- [apps/db-ops-api/tsconfig.json:8](/Users/max/Coding/40-Slide/apps/db-ops-api/tsconfig.json:8)
- [frontend/tsconfig.json:15](/Users/max/Coding/40-Slide/frontend/tsconfig.json:15)
- [frontend/src/api/index.ts:127](/Users/max/Coding/40-Slide/frontend/src/api/index.ts:127)
- [apps/db-ops-api/src/platform/source-routes.ts:6](/Users/max/Coding/40-Slide/apps/db-ops-api/src/platform/source-routes.ts:6)

## R09 · P2 · 让门禁验证行为，并覆盖实际发布模块

**证据状态：** 测试与 workflow 核对。

**发现：** 部分 API 测试仅检查 server.ts 包含路由名/verifyToken 字样，不能证明特定路由实际鉴权。当前 CI 覆盖 API、前端、agent-core 与数据库恢复，但没有 sandbox-controller 独立 typecheck/test 作业，也没有执行 frontend/e2e 的浏览器用例；release-artifact 的依赖没有包含这两项。

**影响：** 安全相关模块或共享 UI 行为发生回归时，CI 仍可能为绿。已有很多真正的行为测试，应保留；不能把全部 readFileSync 测试一概判为无效。

**建议：** 为 sandbox-controller 添加轻量作业；复用现有 Playwright managed environment，选择登录、权限、SQL 审批、Agent 取消及弹窗键盘链路进入发布门禁。将路由鉴权的字符串测试替换为 inject 下的 401/403/200 行为矩阵；资源文件/静态约束测试继续保留。

**验收：** 破坏某条路由鉴权或共享弹窗焦点时对应门禁失败；sandbox 测试失败阻止产物发布；避免先跑完整 API 测试后又无差别重跑同一安全子集。

代码依据：

- [.github/workflows/ci.yml:9](/Users/max/Coding/40-Slide/.github/workflows/ci.yml:9)
- [.github/workflows/ci.yml:93](/Users/max/Coding/40-Slide/.github/workflows/ci.yml:93)
- [apps/db-ops-api/src/ai-analysis-routes.test.ts:44](/Users/max/Coding/40-Slide/apps/db-ops-api/src/ai-analysis-routes.test.ts:44)
- [frontend/playwright.config.ts:6](/Users/max/Coding/40-Slide/frontend/playwright.config.ts:6)
- [apps/sandbox-controller/package.json:6](/Users/max/Coding/40-Slide/apps/sandbox-controller/package.json:6)

## R10 · P2 · 清理 Agent 成功请求遗留的超时定时器

**证据状态：** 源码确认；定时器探针复现。

**发现：** agent-core 的 withTimeout 使用 Promise.race，但原请求成功或失败后未 clearTimeout。默认 LLM 超时 300 秒，因此快请求也会留下 timer 到到期。项目 API 层已有会清理 timer 的 promise-timeout 实现，语义不一致。

**影响：** 高频请求累积短期 timer 和闭包，可能延迟独立进程退出。Promise.race 也不会主动取消底层请求；SDK 超时与 AbortSignal 应另行明确。

**建议：** 给超时包装补 finally 清理；将取消向 provider 传递。包级依赖保持合理，不要让 agent-core 反向依赖 API；可在核心保留小型正确实现并统一测试要求。

**验收：** fake timers 下成功、失败、超时后 timer 数归零；请求取消能被 provider 接收；保持现有超时错误分类。

代码依据：

- [packages/agent-core/src/runner.ts:56](/Users/max/Coding/40-Slide/packages/agent-core/src/runner.ts:56)
- [packages/agent-core/src/runner.ts:459](/Users/max/Coding/40-Slide/packages/agent-core/src/runner.ts:459)
- [apps/db-ops-api/src/promise-timeout.ts:1](/Users/max/Coding/40-Slide/apps/db-ops-api/src/promise-timeout.ts:1)

## R11 · P2 · 让源码、前端产物与 manifest 来自同一个 Git 快照

**证据状态：** 构建脚本确认；未实际打包。

**发现：** release 脚本先在当前工作区 build 前端，再 git archive HEAD，随后把工作区 dist 复制到归档中，却使用 HEAD 作为构建标识。干净 CI checkout 通常无问题，但本地存在未提交前端改动时，会生成源码与前端不匹配、标识仍为 HEAD 的产物。

**影响：** 复盘与回滚无法仅凭 manifest 的 Commit 重现实际前端；脚本宣称的可追溯性在本地构建路径上不成立。

**建议：** 在独立、固定 Commit 的 staging/worktree 中安装冻结依赖并构建，manifest 同源生成；较小的第一步是在构建前拒绝相关源码/配置 dirty。不要清理用户当前工作区来满足检查。

**验收：** 修改一处未提交前端代码后构建应明确拒绝，或从已固定 Commit 构建并排除该改动；校验源码、dist、manifest 的一致性。

代码依据：

- [scripts/release/build-artifact.sh:7](/Users/max/Coding/40-Slide/scripts/release/build-artifact.sh:7)
- [scripts/release/build-artifact.sh:14](/Users/max/Coding/40-Slide/scripts/release/build-artifact.sh:14)

## R12 · P2 · 修正 smoke 退出码，并清理不可复现的工具入口

**证据状态：** 脚本与依赖声明确认。

**发现：** smoke:ci 使用 tsx ... | tee ...，没有 pipefail，默认 shell 下测试进程失败可能由成功的 tee 覆盖退出码。根 format 调用 oxfmt，但根 package.json 与 pnpm-lock 未声明该工具；同时存在 pnpm 主锁和 frontend/package-lock.json。

**影响：** smoke 调用方可能把失败误判为成功；格式化与安装结果依赖开发者机器的全局工具或所用包管理器。当前 CI 没有调用 smoke:ci，因此不据此声称现有 CI 已出现假通过。

**建议：** 把 smoke:ci 移至 set -euo pipefail 的 Bash 脚本或显式保留测试进程退出码；声明固定可复现的 formatter 依赖。确认部署与开发都使用 pnpm 后移除第二锁文件，更新入口说明。

**验收：** 让 smoke 主命令退出 1，脚本仍退出 1；干净安装后 format 可执行；主锁冻结安装不产生锁文件漂移。

代码依据：

- [apps/db-ops-api/package.json:13](/Users/max/Coding/40-Slide/apps/db-ops-api/package.json:13)
- [package.json:26](/Users/max/Coding/40-Slide/package.json:26)
- [frontend/package-lock.json:1](/Users/max/Coding/40-Slide/frontend/package-lock.json:1)

## 哪些兜底应保留

| 机制 | 判断依据 | 建议 |
|---|---|---|
| Worker lease / fencing、幂等键、审批与权限校验 | 防止多实例重复执行和越权，有明确失败模型 | 保留，继续验证跨进程竞争 |
| SDK/运行超时、工具重复调用保护、资源配额 | 约束网络不确定性和模型循环 | 保留，统一取消与资源释放 |
| 明确历史 checksum 的迁移兼容 | 对应真实已部署版本，支持向前升级 | 保留至支持窗口结束，不随意改旧迁移 |
| 前端 token 刷新合并、重复过期事件抑制 | 避免并发 401 导致刷新风暴 | 保留并用行为测试验证 |
| 指标能力的 unsupported/degraded/unknown 状态 | 表达异构数据库与设备的真实能力差异 | 保留，避免用 0 或空列表替代未知 |
| 任意异常 → 空列表、隐式换模型、运行时缺列重试 | 模糊了成功/失败或违背当前配置、schema 契约 | 按 R01/R02/R05 收紧 |

判断兜底是否必要，应问：应对哪一种已知失败、是否改变业务语义、能否观测、由哪一层负责、何时退出。不是 catch 越少越好，也不是检查越多越安全。

## 建议实施顺序

1. **结果可信度批次：R01–R03。** 统一 Provider 配置，恢复真实错误，建立唯一终态；只为这些链路补故障/竞争回归。
2. **确定性清理批次：R04–R06、R10、R12。** 删除确认死代码和失效兼容，修正共享弹窗、timer 与脚本退出码。每类独立提交，便于回退。
3. **持续收敛批次：R07–R09、R11。** 先提取一个业务域证明收益，补对应 inject/浏览器门禁；再逐域推广，构建从固定快照生成。

不建议以文件行数为唯一理由拆文件、一次性启用全仓 strict 产生大量 any、全量重写 CSS、删除所有兼容层，或为此次清理建立新的通用框架。每批以实际减少的分支/重复实现、关键行为覆盖与回归结果衡量收益。

## 验证结果与证据边界

| 检查 | 结果 |
|---|---|
| 前端、API、agent-core、sandbox-controller 常规 typecheck | 均通过 |
| 前端额外 noUnusedLocals/noUnusedParameters | 77 条诊断；非现有门禁失败 |
| API 额外 noUnusedLocals/noUnusedParameters | 138 条诊断；含旧 RCA 私有入口；非现有门禁失败 |
| 定向 Vitest | 实际匹配并运行 10 个文件、82 个测试，全部通过 |
| 弹窗 jsdom 探针 | Shadow DOM 存在 dialog，Light DOM 查找失败，焦点留在触发按钮 |
| Provider 工厂隔离探针 | Anthropic 未传 baseURL；改写环境；禁用后复用旧密钥 |
| 生命周期隔离时序探针 | 最后一次轮询后完成，被无条件超时更新覆盖为 failed |
| timer 隔离探针 | 快速成功后仍保留 1 个超时 timer |
| Bridge 拒绝探针 | 模拟 getAnalysisById 抛异常时出现未处理拒绝；当前实现通常吞掉数据库错误，所以这只证明潜在 Promise 断链，不能声称数据库故障必然导致现网进程退出 |
| 前端静态入口图 | 44 个未到达候选；后台图 14 个候选包含脚本、动态工具等，不能全删 |

定向测试实际覆盖：API Bridge/实例枚举 13 项；前端 API/设计 token 40 项；agent-core timeout/lifecycle 12 项；sandbox 10 项；迁移 runner 7 项。命令曾附带两个未存在的测试过滤路径，Vitest 只运行匹配文件；上面只统计实际执行结果，未把公共契约测试或 managed-list 测试虚报为已跑。

隔离探针从当前源码抽取/转译，使用 stub、jsdom 和受控时间；不访问真实 SDK、数据库或线上服务。因此它们能验证局部控制流，不能代替修复后的集成验收。未执行全仓测试、浏览器端到端、真实迁移/同步、发布构建、依赖漏洞扫描或性能压测。

前两次通过 pnpm 调用 typecheck 时，pnpm 自动进行了一次本地依赖链接协调（输出 +1/-1，并出现 oxc_language_server bin 缺失警告）；未主动发起安装/升级，Git 源码及锁文件没有新增变更。后续检查直接运行已安装的 tsc/vitest。

证据文件见本目录 evidence/；检查日志与探针保留，便于复核。inventory.json 给出全仓文件分类；frontend-unreachable-candidates.json 保存前端候选清单。
