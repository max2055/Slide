# MAX-242 AI 工作空间：能力盘点、体验设计与可审阅原型（R1–R7 + R4 精确绑定 stage3）

日期：2026-10-26。对应 GitHub Issue [max2055/Slide#266](https://github.com/max2055/Slide/issues/266)、Multica MAX-242（主任务 MAX-235）。

## 当前基线与交付边界

| 事实 | 值 |
|---|---|
| 本任务作者起点（首次交付） | `81cdcc92c8533a3c2f094528d79095cc55ec374e`（父提交 `46420d963`） |
| 首轮被审 PR | [#358](https://github.com/max2055/Slide/pull/358)，head `e8d5cd323fd36ecc9bf787b7be443746139b5382` |
| 首轮 PR 对 main 的实际差异 | **255 文件**：26 个 MAX-242 文件 + 225 个 `.qualification` 运行产物 + 4 个 `.planning` 占位 |
| 前进清理提交 | `e3b2993777338e2a8a67705734851bdd3b46ae2e`（仅删除 PR 自己带入的 229 个无关文件，不改起点） |
| 当前 main | `e11f6ba2ed8108af585af022c4acf8817c1d1fec` |
| 当前 PR 元数据 | 仍为 OPEN、head `e8d5cd323`、255 文件；本轮**未推送**，原因见“发布安全” |

本轮是 Chief 首轮复审后放行的**有界设计/原型修订**，不是生产实施：

- 仅修改 `docs/slide/development/MAX-242/**` 与独立原型；共享前端组件、主题、生产 `investigations`/`contracts`/生成 API/OpenAPI/工作空间、MAX-241 原型均未改动。
- 未发产品模型请求、未执行运维动作、未重启共享服务、未写 MAX-224 账本；未推断预算余额。
- **整单仍未完成**：真实事件→调查→结构化补充→判断→必要时审批/执行→三类实际观测，依赖 MAX-238/239/240 的 P1 证据（当前均 `backlog`）及明确契约/集成放行。A01–A22 与 Issue 六项验收未削减。
- MAX-224 当前 `done`、PR #354 已合并，仅更新历史依赖事实，不替代 MAX-235 的 P0/P1、契约与最终集成门禁。

## R1–R7 修订对照

| 项 | 修订内容 | 主要落点 |
|---|---|---|
| R1 | 前进提交清除 PR 带入的 229 个无关基线文件；区分作者起点与当前 main；记录准入/预算/治理/alert-bridge 差异；说明发布安全与未推送原因 | 本 README、[capability-inventory.md](capability-inventory.md) |
| R2 | 平台故事独立打开；场景/自定义问题/资源搜索真实驱动上下文；事件/资源/指标历史/平台异常四来源均带对象、绝对时间、来源、返回位置；至少一条非数据库平台故事走通只读调查与三类复测；提醒按角色投影“可处理/仅可查看”，本人三条“去处理”分别打开精确原补充（INV-2041 V2）、原审批（PLAN-71 v2/APP-302）与原复测（INV-2032/REP-P1）；新增可操作跨资源故事：关系来源/纳入理由、确认/移除、缺权限不可加入、加入只影响下一轮且在途范围不变；无数据/缺模型/无权限实际禁用动作 | `prototype/app.js`、浏览器证据 |
| R3 | 计划持有不可变来源结果版本/范围/摘要/证据；`actionView` 不再 `latest()` 静默改绑定；确认框保存用户看到的计划与批准快照，提交时比对当前版本/摘要/批准绑定，改版即拒绝并要求重新确认；确认执行时重新校验角色、批准版本/摘要/有效期与唯一执行；撤权/过期/改版/重复/未知反例均实测 | `prototype/app.js`、`verify-prototype.mjs` |
| R4 | 报告状态、人工复测、事件恢复分离；报告通过不显示“已恢复”；证据不足只有 EV-11 时拒绝恢复且不新增 EV-12；报告必须带 id/版本/摘要/来源与对象/完整绝对窗口/有效期/非空证据，缺任一字段拒绝恢复（N5–N8），报告在确认期间改版需显式重新核对；增加“无需行动、仅凭后续观测复测”路径与三类结论 | `prototype/app.js`、浏览器负例 |
| R4 精确绑定（stage3） | 报告必须绑定当前调查、本次执行与**授权观测记录**（范围/窗口/既有证据），按稳定身份而非显示名称核对；未知来源、跨对象/跨调查执行、不存在证据、授权窗口外观测一律拒绝；同一 id/version/hash 的登记内容不可替换；正确改版须重新核对并重新选择结论；补 B1–B8/P1–P5 负例与三类结论正例 | `prototype/app.js`、`verify-prototype.mjs`、[contract-proposal.md](contract-proposal.md) |
| R5 | 补充值/变更/症状/未知均保留原值并区分“授权读取 / 用户输入 / 假设”；输入 333 后新结果使用 333 且不伪称 cmdb；“先查再问”提供只读读取入口 | `prototype/app.js` |
| R6 | 只读导入并实际使用共享 `app-card`/`app-dialog`/`app-badge`/`app-toast-container` 与 `tokens.css`/`shared-btn-styles.css`；独立构建入口生成 `dist/shared.js`；不复制 `.card/.badge/.btn/.toast/.dialog`；补充键盘打开、焦点约束、Escape、关闭后焦点恢复的自动化证据 | `prototype/index.html`、`build-shared.mjs`、`vite.config.mjs`、`styles.css`、浏览器证据 |
| R7 | 契约提案区分 UI 派生文本与真正需要持久化的扩展；P2 明确“校验前归一化”与 union 两条边界之一并给有效/无效/幂等/版本/过期/撤权样例；P7 复用 `operations/knowledge/store.ts:153–183` 既有校验，不重复实现、不无意放宽；`view=rules` 只做兼容落点 | [contract-proposal.md](contract-proposal.md)、[entry-compatibility.md](entry-compatibility.md)、[acceptance-matrix.md](acceptance-matrix.md) |

## 基线差异（作者起点 81cd → 当前 main e11f6ba2）

`81cdcc92c..e11f6ba2e` 共变更 379 个文件（含 main 自身的 qualification 产物）；其中生产/前端/包代码 48 个文件、+5770/−159。与本盘点/设计直接相关的差异：

| 模块 | 当前 main 变化 | 对盘点/设计的影响 |
|---|---|---|
| `alert-bridge.ts` | +25/−3：自动派生前检查 `automaticAlertSuppression`；已有 accepted work 不再产生第二条 lane；自动触发重试与 owner 语义收紧；reserve 使用共享常量 | 首轮盘点基于 81cd 的 `:64-122`；当前行为需按 main 重新核对，不能把起点当集成版本 |
| `automatic-alert-admission.ts`（新） | 持久化 `alerts.tags.auto_analysis`（status/reason/investigationId/analysisId/requestId）并支持恢复未准入告警 | “未派生原因可读”在 main 已有部分真实基础，不应再写成完全缺失 |
| `automatic-alert-policy.ts`（新） | 主配置、严重度、实例白名单、时间窗统一抑制原因；枚举 `AUTO_ANALYSIS_*` | 预算/去重/冷却之外的准入原因已有服务端事实来源 |
| `automatic-analysis-status.ts`（新） | 由 master/investigation 开关、scope、service identity、coverage、budget、entry 推导 blockers 与 `unverified` | “自动分析状态”已具备纯函数事实推导；设计应复用其语义 |
| `budget-ledger.ts` | 新增 `AUTOMATIC_ALERT_RESERVE_TOKENS = 32_000`，预检查与准入共用 | 预算展示/预留不能另造第二套常量 |
| `governance-contracts.ts` / `governance-store.ts` | +111/+433：admission reason/blocker schema、治理读取与 ACL/revision/审计扩展 | 工作空间引用治理事实时需对齐 main 契约，不能只按 81cd 描述 |
| `execution-allocation.*`、`runtime-configuration.ts` | 执行分配与运行时配置测试/实现更新 | 预算与分配证据需在 main 上重验 |
| `investigation-governance.ts` | +170：治理视图接入新事实 | 与本设计的“启动前能力检查”存在可复用展示，不应重复实现 |
| `event-aggregator.ts`、`server-alert-evaluator.ts` | 事件聚合/服务器告警变化 | 事件来源上下文需按 main 核对 |

`capability-inventory.md` 中的 `path:line` 明确标注为 **81cd 作者起点**；凡上表模块，行号/结论须以执行时 main（或 P1 合并后的基线）重新核对。

## 原型与验证

`prototype/` 是独立静态原型，**明确标注演示数据**，不请求后端、不调用模型、不执行运维：

```bash
# 直接打开 index.html；或先构建共享组件层
node prototype/build-shared.mjs   # 需要仓库已安装前端依赖
node prototype/verify-prototype.mjs
```

- 共享 `app-card`/`app-dialog`/`app-badge`/`app-toast-container` 由只读构建产物 `dist/shared.js` 提供；主题与按钮样式通过只读 `<link>` 引用生产 `tokens.css`、`shared-btn-styles.css`。
- 本轮真实 Chrome/CDP 检查 **100/100 通过**，无控制台错误；覆盖 R2–R6 的正向与负向交互，含 N1–N8、跨资源关联故事，以及 R4 精确来源绑定的 B1–B8（资源行动）与 P1–P5（平台无行动）负例，证据见 `prototype/browser-evidence/latest-run.json`。
- 截图覆盖 1440×900、1366×768、1920×1080，以及平台详情、333 补充、撤权确认拒绝、证据不足拒绝恢复、无行动复测、原记录跳转、关联对象、确认改版拒绝、报告缺失字段拒绝、报告来源绑定核对与窗口越界拒绝、同 id/version/hash 内容替换拒绝等关键态。
- 原型交互通过不等于权限、采集、审批、执行或恢复能力已可用；它是设计审阅材料，不是业务端到端验收。

## 发布安全与 PR 状态

- 首轮 PR 的 255 文件差异包含 `.qualification` 运行产物（部分文件名含 `jwt/config.json`）。**本轮未读取或输出其中任何值**，也不宣称已确认是真实凭据泄露；按最小脱敏原则只报告存在该类文件。
- 前进提交 `e3b299377` 已把 **PR 对 main 的差异**收敛为仅 MAX-242 文件，但任务分支的**祖先历史仍包含**这些产物。按 MAX-236 已确认的发布边界，即使后续删除也不能消除祖先历史，因此**本轮不推送该分支、不重写历史、不 force-push**。
- 可发布路径需独立证明：从当前 main 新建清洁分支，仅 cherry-pick/应用 `docs/slide/development/MAX-242/**` 允许清单（含原型与证据）后由 Chief 决定；本轮不擅自推送。PR #358 继续保持 head `e8d5cd323`，本修订的准确 SHA 见交付评论。

## 文件索引

| 文件 | 内容 |
|---|---|
| [capability-inventory.md](capability-inventory.md) | 真实代码能力盘点：已有能力、精确证据、缺口；81cd 起点与 main 差异 |
| [experience-design.md](experience-design.md) | 统一 AI 工作空间体验设计：来源、检查、详情、补充、异常、行动、复测、交接 |
| [entry-compatibility.md](entry-compatibility.md) | 旧入口与深链接兼容表（含 `?view=rules` 兼容落点） |
| [acceptance-matrix.md](acceptance-matrix.md) | Issue 六项验收 + 少输入矩阵 + R1–R7 修订证据与未完成项 |
| [contract-proposal.md](contract-proposal.md) | 跨模块契约提案（只提案；区分 UI 派生与持久化扩展，含 P2/P7 边界与样例） |
| [prototype/](prototype/index.html) | 独立可审阅原型（演示数据）+ 共享组件构建入口 + 100 项浏览器检查 |
| [prototype/browser-evidence/latest-run.json](prototype/browser-evidence/latest-run.json) | 本轮浏览器检查、负例、截图清单与控制台错误记录 |

## 与依赖的关系

| 依赖 | 当前状态 | 对本项的影响 |
|---|---|---|
| #262 / MAX-238 模板绑定、有效配置与测试—应用—正式采集 | `backlog` | “缺数据→补采集”“有效窗口/质量语义”只能按既有契约设计，真实采集证据不可得 |
| #263 / MAX-239 统一触发器与事件中心、真实恢复判定 | `backlog` | 事件→调查自动上下文、真实恢复证据不可得；不得把既有告警接口当成新触发链 |
| #264 / MAX-240 最新数据与历史图表 | `backlog` | 指标历史进入调查、复测观测窗口的完整查询证据不可得 |

因此涉及真实采集、事件自动派生和恢复判定的验收项仍标为“未验证”，不以原型或单测代替。
