# T08 数据库告警与旧 Analysis 兼容

基线：main `9946299096849ecc2236dfe79022b618ac836525`。托管起始 `47482021` 和用户本地材料保留；产品提交不包含用户 AGENTS、私有 `.multica`、历史发布包或本地技能差异。T04–T07 的父准入沿用 MAX-149 v1.2.15；本记录不替代父独立 Review、准确 head CI、正常 merge/main 或 T12 总验收。

## 行为与消费接口

- 数据库 RCA 的引擎、旧 `/api/ai/analysis`、新 `/api/alerts/:id/investigation` 和 Cron 入口共享 `DatabaseAlertBridge`。告警 source owner 先持久冻结 legacy/investigation lane。MySQL source lock 与后续新旧准入复用同一预留连接，同来源本地排队；新 admission 复用原事务桥/事件入口，执行仍由 Workflow/Run owner 负责。
- 初次接入可选择新路径；既有 pending/running/unknown 保留旧 owner。新 lane 接受结果不明时保留决策；重试用冻结命令及原幂等键恢复。关闭 flag 不修改或接管已有 job。新自动权限/预算拒绝、配置缺失、存储错误不 fallback 旧模型。
- 新 `/api/alerts/:id/investigation` 要求 live `ai:manage` 和 source scope，返回 `investigationId` 或旧 numeric `analysisId`/`id`。自动 source 在显式用户进入后仅授予 viewer，不能取消或 append；每次进入和 Workspace 内容都重查完整 scope。
- `POST /api/ai/analysis/:id/investigation` 要求 live `ai:view`、Chat/资源权限。终态旧结果首次显式链接时创建唯一 archived 调查/Session；不创建 request/job/Run/ledger/V2 result。SQL、健康/故障、告警历史原结果按 v1/legacy 只读呈现，unknown 仍 unknown，bound 不等于根因验证。无可信原主体的手动历史拒绝接管，不能仅凭 numeric id 或旧 cache key 推断归属。
- Workspace GET 附带 `legacyAnalysis`；公开 PATCH/Run 入口拒绝只读历史链接。告警与数据库诊断复用 `<legacy-analysis-link>`；组件本身不自动请求，撤权/销毁后的迟到响应不导航。旧 SQL 记录可消费同一桥接 API，没有批量补跑或另建 SQL 历史业务页。

## 配置与回切

三个环境 flag 分别为 `INVESTIGATION_MANUAL_ENABLED`、`INVESTIGATION_OPS_AUTO_ENABLED`、`INVESTIGATION_LEGACY_BRIDGE_ENABLED`，仅精确 `true` 开启，默认均关闭。自动来源另需配置 `INVESTIGATION_OPS_SERVICE_USER_ID` 和有界、明确的 `INVESTIGATION_OPS_INSTANCE_IDS`（逗号分隔、最多 20 项，无 wildcard）。

服务主体由可信 operator 既有 provisioning port 显式配置；本实现不自动创建用户、授予权限或继承 admin。每次接入重载 password-disabled 服务身份与实时 instance grant，冻结原权限上限并复用 `investigationBudgetConfiguration`/共享 ledger。策略固定 Ops v1、threshold=1、window/cooldown=300 秒、每请求上限 32,000 Token；费用预留使用现有 loader。治理页面展示真实配置/flag 状态，不披露 service id 或资源清单；configured/connected 不代表 live authority 或可用额度。

生产 feature flag 未启用；没有部署或生产迁移。additive migration `118_investigation_analysis_bridges.sql` 在隔离 MySQL 正式 runner 中验证两次启动，collation 与既有 investigations 一致。

## 本地验证

全部真实链路在本次自建 disposable MySQL 8.4 与唯一临时 schema 中执行，结束停止容器，未访问平台/生产数据。新测试不跳过、没有环境 fallback 到平台数据库。

| 验证 | 结果 |
|---|---|
| `bash scripts/qualification/run-investigation-bridges.sh` | 14/14；正式迁移、50 并发同 ID、旧真实 dispatch 接受、flag 回切、写失败恢复、旧 unknown/主体拒绝与同 JWT 撤权 |
| `bash scripts/qualification/run-investigation-bridges.sh --browser-all` | 49/49 Chromium（旧 44 + 新 5）；真实 MySQL/JWT/HTTP/WS、CPU/慢 SQL source、取消拒绝、回切、历史查看、SQL 撤权；1600/1024/390 历史视图无横向溢出 |
| `bash scripts/qualification/run-auth-boundary.sh` | 183/183；受影响调查/Session/HTTP/治理实时授权回归 |
| `bash scripts/qualification/run-analysis-recovery.sh` | 41/41；旧 Analysis 派发、崩溃、未知计费与权限恢复 |
| 后端 Analysis/envelope/evidence/public-api/executor/trigger-policy 模块 | 90/90 |
| 前端 legacy-link/alerts/instance-diagnosis/resource-diagnosis/controller/governance 模块 | 56/56 |
| `pnpm security:agent` | 187/187 |
| 前后端 typecheck、`pnpm contracts:check`、frontend build/CSP、diff check | 通过；沿用既有 Vite chunk size warning |

CPU 与慢 SQL 的告警行和工具返回是明确的受控合成事实；走正式 RCA/事件/admission/后台/观察/浏览器组件。Provider spy 每场景证明 **一个 request、一个 Run、一条请求链（两轮受控 provider 调用 + 一次只读工具）**，旧 ai_analysis 没有第二条派发。不能将受控 provider 冒充真实外部模型；本次零新增外部模型调用，父历史累计 5/6 成功停发不重置或转授。

首轮正式 migration 因新增表默认 collation 与引用列不一致失败，业务测试未执行；已修复并用正式 runner 验证。后续失败分别来自受控服务夹具混入不允许的 AI 权限、测试 SQL 直接比较不同历史 collation、浏览器错误假设 viewer 已有 operator/深链权限、公开契约路径快照未同步；均按具体根因修复，保留原日志，不以失败轮或未执行项目计通过。

agent token/费用实际遥测不可用，没有自行估算为实测；子代理 0。新增外部真实模型验收不在当前授权内；Web Vitals/axe 全面审计与完整 V1 总 gate 未执行。

## T08-POOL-01 修复与新增证据（2026-10-13）

父审查在原 head `33a515f8` 确认不同告警占满生产上限 10 个连接后，又申请同池事务连接形成循环等待。原同 ID 50 并发证据不能覆盖它。本次真实 MySQL RED：10 个不同告警在连接取得屏障后全部报 `NESTED_POOL_ACQUISITION_TIMEOUT`；诊断超时只存在于测试，不进入生产。

修复保留同来源跨进程 `GET_LOCK`、持久 lane 的 autocommit 和事务提交边界。事件摄入复用 Outbox 的 caller-reserved transaction；手动入口复用原 `createOnConnection`；旧入口的模型配置读取、enqueue 和可选 cache callback 查询也使用同一连接。事务仅提交/回滚，锁和连接由桥接 owner 最后释放。未增大生产连接池、引入第二个池或修改隔离级别。

新增并发覆盖发现 InnoDB 的 gap-lock 死锁：手动消息创建与旧 `ai_analysis` 插入会选事务受害者。仅在明确 `ER_LOCK_DEADLOCK`、事务已回滚且尚未发送模型的准入边界，最多重试 3 次并使用短暂随机退避，避免立即重复同一冲突；连接错误、提交不明、unknown 和 provider 不自动重试。

| 本次修复验证 | 结果 |
|---|---|
| `bash scripts/qualification/run-investigation-bridges.sh --browser-all` | 25/25 正式 MySQL 桥接 + 49/49 Chromium，无 skip/retry |
| 新 `alert-bridge-pool.test.ts` | 11/11：容量 1/2/10 × 自动/手动/旧路径，各 10 个不同 source 并发及 flag 回切；单连接生产旧配置/派发入口；独立连接池的同 ID 50 次竞争 |
| Outbox / AI bridge / Scene routing / Trigger policy focused | 4 文件 38/38，无 skip（其他未命中文件不计入） |
| Provider factory 错误传播契约 | 23/23；按无参/带参方法实际签名调用，保留底层错误 cause 断言 |
| `bash scripts/qualification/run-auth-boundary.sh` | 183/183 |
| `bash scripts/qualification/run-analysis-recovery.sh` | 41/41 |
| API typecheck / contracts check / diff check | 通过 |

小业务池在正式迁移两次运行并关闭初始化池后创建。首轮容量 1 的夹具提前限制迁移连接池，暴露 runner 既有 nested invariant query 问题并阻塞初始化；只调整夹具初始化顺序，未修改迁移模块。失败轮的即时 deadlock 重试仍有冲突，保留失败日志，采用有界随机退避后全部业务回归通过。所有容器/独立 schema 与本次服务均已收尾，无平台/生产数据操作。

准确最终 PR head 的 CI 结果和文件 SHA256 随交接附件交付；父独立 Review、普通 merge/main 核验仍为完整出口前置，不以本地通过代替。本次新增外部模型请求 0，历史 5/6 成功停发记录保留；子代理 0，累计 token/费用实测不可用。

首个修复 head `c5cb8e61` CI `38395261633`：新增 11 项池回归通过，后端 3315 passed / 1 failed / 615 既有 skipped。失败为旧 provider factory 测试将字符串传给原无参 `getAllProviders`，与新增内部预留连接参数冲突；修正测试调用签名后重新收集新 head CI，不将该失败轮作为完整 gate 通过。
