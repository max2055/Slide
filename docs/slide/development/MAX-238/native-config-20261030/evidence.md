# MAX238-NATIVE-CONFIGURATION-FLOW：原生固定版本模板配置界面已闭环

2026-10-30。**一句话结论**：从现有资源的“监控与配置”入口，用户可在全授权模板目录中搜索、分页并固定已发布版本（可多选），查看组合监控项、参数默认/覆盖/最终值与来源链，执行真实检查 → 真实只读试采 → 事务应用；发布、等待应用、已应用、首样本与正式采集分别显示。浏览器、真实 Fastify API 与一次性平台库中的原生操作记录一致；一次成功提交在 HTTP 响应被丢弃后通过操作键查询恢复，没有重复 revision、audit 或 operation。**这不是 MAX238 整单完成**：历史阈值、停用/解绑后历史授权、改名/版本身份、SLO/容量、服务器 3、24h、迁移演练、通知恢复与 AI 闭环仍未完成。

机器证据：[evidence.json](evidence.json)。复现脚本：[prepare.mjs](prepare.mjs)（一次性环境）、[setup.mjs](setup.mjs)（真实 API 绑定/试采/应用）、[browser-evidence.mjs](browser-evidence.mjs)（真实浏览器三场景）。

## 1. 代码与分支

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-238` |
| 基点 | `3b1a76d78beffa7877199ff16204ce0210d8a61a`（R4 已接受交付） |
| 实现与测试提交 | `7beba8852` |
| 证据提交 | 本文件所在提交 |
| 未推送 | 本运行时到 GitHub 的 HTTPS 连接不可用（见 §9） |

### 本包改动

- **目录**：`GET /api/metrics/templates` 增加名称搜索、状态筛选、前向游标分页与 `next_cursor`；`TemplateListQuery` 与内存/MySQL 仓库同步。
- **操作结果查询**：新增 `GET /api/metrics/template-bindings/{type}/{id}/operations/{key}`，只读 `metric_policy_operations`（宿主在同一事务写的原生操作行），读取后再次读取实时授权；别的资源的键报告 absent，不泄露。
- **拒绝语义**：候选/预检/解析错误（`CANDIDATE_*`、`PREFLIGHT_*`、`RESOLVE_*`）返回 422 + 稳定错误码；冲突带 `conflicts`/`providers`/`field` 结构化字段。`BindingTransactionError` 的 revision/operation 冲突返回 409、receipt 类错误返回 422，不再落到 500。
- **配置状态**：`MetricConfigurationReader.status` 识别 `templates-v1` 绑定，使用共享持久化 codec 读取其真实事实（不存在包行时也不假装未绑定）；`binding.package=null`，发布/应用/首样本/正式可见仍分离。
- **能力证据**：模板调度提交成功后，在同一事务内把本次真实运行的 capabilities 写回绑定行（与 legacy 路径相同位置），使下一次检查能使用新鲜证据；不改变 activate 谓词、必要名单或正式 writer。
- **前端**：`metric-configuration` 成为来源分派（旧版单包仍走原编辑器，读取失败显示错误而非未绑定）；新增 `native-template-configuration`：目录搜索/分页、固定版本多选、草稿/缺实现/不兼容解释、参数/单位/来源链、冲突显式覆盖、检查/试采/应用、操作键与未知结果查询、显式兼容 re-pin、独立状态事实。试采编码值按真实值显示，不再出现 `[object Object]`。

## 2. 环境（一次性平台库 + 真实目标，只读）

| 项 | 值 |
|---|---|
| 一次性平台库 | 容器 `max238cfg-2e39d54b008108ff`，ID `55799d3288b21efc034aaf09a9000e09cdc58794189303e01f8416206601b736`，`127.0.0.1:13352` → 3306，`mysql:8.4`（8.4.10） |
| 平台库 | `slide_max238_native`，从空库执行完整 migration |
| 目标 | 真实 `mysql3306`：`localhost:3306`，MySQL 9.6.0，只读；本包只执行状态读取 |
| 对象 | 从共享开发库**只读复制**已纳管实例 1（含加密凭据列）与模板/旧版绑定行；共享库未被改写 |
| 身份 | 一次性库内创建测试管理员（真实 JWT、session_version、角色与实例授权）；不是生产身份 |
| 运行 | 真实 `apps/db-ops-api`（127.0.0.1:3001）+ 真实 Vite（127.0.0.1:5173，代理到 3001） |
| 目标写入 | 0；采集器仅执行只读状态查询 |

能力证据由真实模板调度运行刷新：一次性库中 `metric_policy_bindings.capabilities` 最新 `valid_until` 为 `2026-10-29T19:01:48.775Z`、状态 `supported`，来源是 revision 6/8 的真实模板运行（`metric_attempts`）。

## 3. 真实绑定链（setup.mjs）

| 步骤 | 结果 |
|---|---|
| re-pin | 模板 `e19c120027e04da69b130e0f6cea29fc` 版本 1 → 2；只重钉 item `8fbad224ebdf46e7b25a0be015f21972` 到 `mysql-basic@2.0.0`；版本 1 保留 |
| 检查 | `executable=true`，item `db.uptime_seconds` |
| 真实试采 | `decision=attempted`，`db.uptime_seconds` 读取为 `s`，观测时间 `2026-10-29T18:57:53.438Z` |
| 应用 | `committed`，revision 5；绑定来源变为 `template`，pending 目标 5，application `pending` / applied 4（已接受语义：pending 计划不冒充已应用） |

## 4. 浏览器三场景（真实 Lit → 真实 API → 一次性库）

所有操作在 1440×900 主验；另在 1366×768、1920×1080 截图关键布局。控制名、键盘/焦点、空错态沿用共享组件。

### A. 选择、取消、搜索、分页、真实试采、响应丢失恢复

| 断言 | 结果 |
|---|---|
| 绑定中的固定版本被预填 | 是（不默认第一条、不写死模板名） |
| 取消选择 | 未选择；期间非 GET 请求数 0 |
| 名称搜索 “MySQL” | 只剩 MySQL by ODBC；分页测试模板不出现 |
| 目录分页 | 首屏 10 条 + “加载更多模板”；加载后 12 条全部可见，按钮消失 |
| 草稿解释 | “模板为草稿，未发布”；无已发布版本模板显示禁用原因 |
| 检查 | `executable=true` |
| 试采 | 通过；页面显示 `值 92060 s · 2026-10-29T18:59:33.281Z` |
| 一次成功提交 + 丢弃 HTTP 响应 | 服务器收到 1 次 apply 并提交；浏览器看到网络失败后查询同一操作键，恢复为已提交，未重发 |
| 去重 | 该操作键在 `metric_policy_operations` 恰好 1 行；revision 8 的 audit 恰好 1 行；增量 operation 1 |
| 重载恢复 | 发布（已提交）8；没有“上次发布结果尚未确认”，不触发盲目重试 |

### B. 并发 revision 变化

- 浏览器先完成检查与试采（base 8）。
- 另一真实 API 客户端以 base 8 提交不同候选，绑定推进到 revision 9。
- 浏览器点击应用后收到 revision 冲突，页面显示“配置版本已被他人更新”，未写入。
- 重新加载后显示目标版本 9；无重复 operation/audit。

### C. 应用时撤权

- 浏览器完成检查与试采，应用按钮可用。
- 仅移除测试管理员的通配角色并把实例授权降为 `read-only`（读取/状态轮询仍允许）。
- 点击应用触发真实后端重新授权：HTTP **403**；绑定行与操作行均未变化；页面显示“没有此资源的操作权限”。
- 权限在收尾时恢复（一次性库随后删除）。

## 5. 状态分离（页面与 API 同源）

一次性库最终绑定：`templates-v1`，revision 9，`template_resolution.pending.target_revision=9`，application `pending`，`applied_revision=4`。页面分别显示：保存（未保存修改）、发布（已提交）、等待应用（目标版本 + 时间）、调度应用（状态 + 已应用 revision）、首样本（尚无正式首样本）、正式采集（等待应用/第 N 代）。没有把配置 200、旧值或“已发布”当作健康。

## 6. 验证门禁

| 检查 | 结果 |
|---|---|
| 后端模块测试（config/templates/bindings/scheduler） | 32 文件通过 / 31 跳过；512 passed / 132 skipped |
| 前端全量测试 | 150 文件 / 1340 tests passed |
| API typecheck | 通过 |
| 前端 typecheck | 通过 |
| 前端 build | 通过；CSP 检查通过 |
| contracts:check | 通过（OpenAPI 与生成客户端一致） |

新增/更新的聚焦测试覆盖：目录名称搜索与分页（内存仓库）、模板操作日志查询（committed/pending/absent、别的资源 absent、读取后撤权 401）、冲突/候选/解析拒绝映射（422/409）、templates-v1 状态读取（不冒充未绑定）、原生组件（不预选、搜索分页、取消零写入、检查/试采/应用、操作键复用、commit_unknown 只查询、编码值显示、显式 re-pin）。

## 7. 明确边界与未完成

- **未启动生产 worker、未部署、未停写/复制/切换/回退/解绑**；所有平台写入都在一次性库，目标只读。
- `application` 在模板路径保持 `pending`（applied_revision 为上一份已应用配置）是已接受的契约；正式历史仍由模板调度真实写入，不伪造 applied。
- 无绑定行的资源：原生应用需要既有绑定，服务端返回 `TRANSACTION_BINDING_MISSING`（409），页面解释并禁用应用，未写入；本包未新增首个绑定的写入者。零选择/取消路径可用且不写库。
- 能力证据遵循既有新鲜度规则：需要真实调度运行刷新；本包补齐了模板运行的 capabilities 写回，未放宽任何谓词。
- 重钉发布的是全局不可变模板版本，仅在用户显式确认时执行，并展示变更项；不自动改变本资源或其他资源。
- 原范围仍未完成：全指标 good、历史阈值、停用/解绑后历史授权查询、改名/版本身份、SLO/容量、服务器 3、24h、迁移演练、通知恢复与 AI 闭环。

## 8. 清理回执

| 项 | 回执 |
|---|---|
| API PID 2191 | 已停止；`127.0.0.1:3001` 连接失败 |
| Vite PID 2206 | 已停止；`127.0.0.1:5173` 连接失败 |
| 容器 `max238cfg-2e39d54b008108ff` | `docker rm -f` 返回容器名 |
| 按名称 inspect | exit 1（no such object） |
| 按 ID `55799d3288b21efc034aaf09a9000e09cdc58794189303e01f8416206601b736` inspect | exit 1（no such object） |
| 共享 3306 | 只读复制与只读采集；无业务写入 |
| 测试管理员权限 | 撤权场景后已恢复（随后随一次性库删除） |

## 9. 交付与未执行

- 实现与证据提交在任务分支 `agent/15coder1/max-238`，基点 `3b1a76d78`。
- PR #567（base `main`）需要从已安全 head `46fb63339e535b726cf627423212fa040c661f88` 追加本包干净提交；本运行时 GitHub HTTPS 不可达（TLS `unexpected eof`，`gh`/`git ls-remote` 均失败），因此**本次未推送、未更新 PR、未取得 CI 快照**。待推送提交即任务分支上的实现与证据提交，内容已通过本地全部门禁。
- 未执行：watch、merge、deploy、生产 worker、共享 3306 业务写、停写/复制/切换/回退/解绑。
