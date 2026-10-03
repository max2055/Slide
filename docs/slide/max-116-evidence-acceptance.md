# MAX-116 / W08 冻结证据与实际执行来源验收

范围版本 v1；基线 `main@8fe05fc0676e80eb4c01ff6589eecba0f9b13f36`（MAX-114 / PR #120 已合并且父任务验收通过）。仅处理分析证据、完成接口绑定、执行来源、必要的展示与契约；不开放后台数据库工具，不调用付费模型，不变更实际 .env、用户运行服务或生产数据。硬预算未设定；实际 token/费用遥测不可用（平台本 run 尚无计量任务，不能把返回的零计数当实测）。子代理 0，最大代理深度 0，代理并发峰值 1。停止条件：本地验收完成、PR 交付父任务审查；合并和后继激活由父任务串行处理。

## 行为与兼容契约

- 授权后服务端预采集 TopSQL SQL、统计、Schema、索引、非执行式 EXPLAIN；只读 AST 边界拒绝 DML、多语句、危险/未知 SQL 和 EXPLAIN ANALYZE。Schema/索引使用现有 SqlExecutor 的只读校验、5 秒超时与 1000 行限制；EXPLAIN 复用现有 15 秒数据库边界，冻结结果上限 1000 行/64000 字符。无法识别的表、非 MySQL Schema/索引、采集失败或超限均记录 gap；不猜测计划。
- `analysis_dispatches.request_snapshot.evidence` 保存 schemaVersion、UUID、内容 SHA-256、冻结时间、subject、authorizationVersion、脱敏数据及 gap。SQL 字面值和秘密字段脱敏；不采集业务表行数据。统计保留 first_seen/last_seen，诊断包保留其原采集时间。证据在 admission 事务中持久化，结果不会引用后续变化的实时指标。
- 引用解析兼容 RFC 6901 Pointer、`observation:<metricId>:<resourceId>`、现有 64 位证据 hash；另支持 `snapshot:<UUID>#/<pointer>`。所有解析限于当前任务的冻结数据，绝不按 ref 查询全局指标。subject/type/权限范围/hash/引用不存在或属于其他任务时拒绝。
- 稳定错误码：`ANALYSIS_SUBJECT_MISMATCH`、`ANALYSIS_TYPE_MISMATCH`、`ANALYSIS_EVIDENCE_SCOPE_MISMATCH`、`ANALYSIS_EVIDENCE_REF_INVALID`；无服务端完成上下文为 `ANALYSIS_EXECUTION_CONTEXT_REQUIRED`。重复完成为 `ANALYSIS_ALREADY_TERMINAL`；旧 owner/run 仍由现有 fencing 拒绝。
- `resource_diagnosis` 的 envelope.analysisType 匹配请求 purpose；历史 ai_analysis.analysis_type 仍存 `fault_diagnosis`。新结果的验证等级 `bound` 仅代表引用绑定，不代表根因已证实；gap 为 partial，缺失/过期/unknown 或缺少实际执行记录为 unknown。unknown 的假设状态和置信度不能伪装为已验证。
- DirectAdapter 在实际 provider 边界记录 provider、模型、选中路由配置版本、实际 system+tool prompt hash、输入 hash、完成工具版本/Schema hash、每次供应商请求与 usage。provider 身份来自创建该 provider 的服务端路由；模型字段为实际请求的模型 ID，供应商模型别名的底层解析未验证。完成工具提交的 provenance/时间/验证级别均被覆盖。
- `execution_trace` 绑定 analysisId + workflow attempt + runtimeRunId，每个 request 单独保存 usage。供应商未提供 usage 时保存 null/unavailable；部分提供时标 partial。cached_tokens 是 prompt_tokens 的子集，汇总不会重复相加。允许同一有效 owner 在 completion 后完成最后一轮请求并补 usage，只更新元数据，不能改写结论或冒充另一 run。
- 新增 `GET /api/ai/analysis/:id/evidence`：需 ai:view、原用户、当前权限快照一致与当前 subject 访问权限；无权限/不存在/历史无快照统一 404。普通结果和列表不附带快照内容。OpenAPI 与前端生成类型已同步。
- 无新增数据库迁移。快照保留策略：随分析记录长期保留，不使用结果缓存 TTL 自动清除；没有新建清理任务。读取不重建或回填历史快照。旧 Markdown/Envelope 保持可读并标明历史验证信息不可用；不批量写 configured-provider。

## 验收证据

环境：本机 Node v24.18.0 / pnpm 11.19.0，隔离 worktree；供应商全部为假模型；MySQL 8.4 临时 Docker 容器，脚本退出后清理；未运行生产迁移。

| 验收项 | 证据 |
| --- | --- |
| 错 subject、错类型、虚构引用拒绝 | `analysis-evidence-binding.test.ts`、隔离 MySQL 完成接口测试 |
| 真实的其他任务/作用域引用拒绝 | MySQL 创建两个真实 dispatch/snapshot 后，提交另一个 snapshot UUID 与越界 observation ref；当前记录保持无结果 |
| 真实快照引用通过、历史格式兼容 | Pointer/转义、observation、64 位 hash 与限定 snapshot 引用测试 |
| 缺口/过期/null 为 unknown | gap、null、stale bucket 的 Pointer/hash 回归；无实际执行来源不升级验证等级 |
| 实际模型/提示词/路由版本区分 | provider wrapper 记录不同模型、system prompt/input hash；Date 路由更新时间不会发生 hash 碰撞 |
| completion 在最终 usage 前落库 | 真实 DirectAdapter + 假模型两轮请求 + MySQL：第一轮 tool 保存 completion，第二轮返回 usage；汇总输入 15、输出 3、缓存 4，伪造来源被覆盖 |
| 补元数据不改结论、不冒充其他 attempt | 完成后再次提交结论拒绝；其他 runtimeRunId 回写拒绝；原结论不变 |
| 反查原快照而非当前指标 | admission 后改变原内存证据，MySQL 中 request_snapshot 仍保存 qps=7 |
| 快照访问控制与历史兼容 | 原用户原权限可读；另一用户、权限撤销、session version 改变拒绝；旧 Markdown/Envelope 展示测试 |

验证命令与结果：

- `pnpm -r test`：frontend 566 passed、agent-core 654 passed、sandbox 22 passed / 4 条件跳过。backend 首次仅新增 API 的旧路径 fixture 失败，修正后单独重新运行 backend gate。
- `pnpm --filter slide-api test`：2956 passed / 205 条件跳过；条件跳过包含环境相关 MySQL 等测试，不能冒称这些全部通过。
- `bash scripts/qualification/run-analysis-recovery.sh`：40 passed，包含本次新增的真实 DirectAdapter/假模型/MySQL 验收、已有 7 个真实 SIGKILL 恢复窗口与 MigrationRunner 两次执行；本次必需 MySQL 检查没有跳过。
- `pnpm --filter slide-api exec vitest run src/analysis/analysis-envelope.test.ts src/ai-analysis-lifecycle.test.ts src/contracts/public-api.test.ts`：18 passed。
- `pnpm --filter slide-api exec vitest run src/analysis/analysis-evidence-binding.test.ts src/analysis/analysis-provider.test.ts src/ai-agent-bridge.test.ts src/adapter/llm-provider-factory.test.ts`：56 passed。
- 前后端 `typecheck`、`pnpm contracts:check`、`pnpm qualification:matrix`（37/37）、`pnpm lint`（0 errors；262 个既有 warnings）、前端 build/CSP 与 `pnpm security:scan` 通过。
- 隔离 MySQL 回归还发现已有测试 helper 假定 SQL 同时间排序总会领取指定任务；它偶尔实际领到已 unknown 的前序任务。已让 helper 按真实 worker 行为先确认终态任务不会重放并确认 acknowledgement，再领取目标任务；没有改变生产调度逻辑。
- 未单独采集代码行覆盖率；确定性行为覆盖以上验收项。

## 迁移、回滚与未验证项

新增字段位于现有 JSON 契约内，schemaVersion=1 的历史 Envelope 仍可读。回滚先停止新 admission/dispatch（`ANALYSIS_DISPATCH_ENABLED=false`），保留现有 request_snapshot、execution_trace、分析结果和未知任务，不自动重跑或再次计费。旧执行器不能充分理解新引用/验证级别时保持只读。没有历史数据批量填充、删除或新 schema 迁移。

真实模型的少量已知根因案例评估：预算未设定，付费调用未授权，供应商环境/凭证未使用；本次只证明确定性证据绑定和执行来源，不宣称模型业务诊断质量通过。Oracle/PostgreSQL/Dameng 的真实环境质量和本次人工浏览器全链路未验证；安全 EXPLAIN 复用现有已测试边界，其 Schema/索引缺口如实保留。外部 CI 由 PR 触发，父任务需核验当前精确 head 的八个 job 后再串行审查合并。
