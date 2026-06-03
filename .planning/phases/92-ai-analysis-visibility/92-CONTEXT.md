# Phase 92: AI Analysis Visibility - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning

## Phase Boundary

让用户能在告警列表和实例详情页中看到 AI 自动/手动分析的结果。核心链路：Agent 对话执行分析 → 调用 `slide_complete_analysis` 工具保存 Markdown 结果 → 前端从 `ai_analysis` 表读取并渲染。

## Implementation Decisions

### slide_complete_analysis 工具
- **D-01:** 工具参数为 `analysisId` + `markdown`（Markdown 文本），Agent 从 System Prompt 中拿到 analysisId
- **D-02:** 工具实现：接收 Markdown，调用 `aiAnalysisDatabaseService.completeAnalysis(analysisId, { result: markdown })` 存储
- **D-03:** 该工具当前缺失（CLAUDE.md 待修复项），是实现本 Phase 的前置条件

### 分析 Skill 文件
- **D-04:** 每种分析类型独立一个 skill 文件：`alert-rca.md` / `fault-diagnosis.md` / `topsql-analysis.md`
- **D-05:** 每个 skill 定义：工具调用流程、Markdown 输出标题结构（`## 分析摘要` / `## 根因分析` / `## 建议操作` / `## 关键指标`）、最终调用 `slide_complete_analysis` 保存
- **D-06:** 输出格式统一为 Markdown（非 JSON），Agent 自然产出，前端用 `marked` 渲染

### 前端统一展示组件
- **D-07:** 统一为 `ai-analysis-result` Lit Web Component，数据驱动（传 `result` + `analysisType`）
- **D-08:** 按分析类型区分渲染：alert_rca 突出 root_causes + recommendations，fault_diagnosis 突出 diagnosis + fix_steps，topsql 突出优化建议
- **D-09:** 展示形式：弹窗/抽屉中展示完整结果，不在表格行内展开
- **D-10:** 自动/手动分析在结果旁标注来源标签（「自动分析」「手动分析」）

### 告警列表标记
- **D-11:** 告警列表显示分析状态标记：completed →「已分析」、running →「分析中」、failed →「分析失败」
- **D-12:** `_loadAnalyzedStatuses()` 需添加错误日志，排查 auto 分析结果不可见的根因（怀疑是认证/数据关联问题）

### 实例详情页诊断历史
- **D-13:** 实例详情页顶部展示最近 5 条诊断摘要列表，每条显示状态+时间+一句话摘要，点击弹窗查看完整结果
- **D-14:** 需要新增或扩展 API 支持按 instance_id + analysis_type 查询最近 N 条已完成的诊断

### 自动分析 Cron 配置
- **D-15:** 自动分析支持完整调度配置：cron 表达式可配 + 级别过滤（critical/error/warning）+ 实例白名单过滤 + 时间段限制
- **D-16:** 配置项持久化到 `system_config` 表（复用已有配置机制），前端管理界面提供开关和过滤设置

### Claude's Discretion
- Markdown 输出模板的具体标题层级和措辞
- 前端渲染 Markdown 时的样式优化（代码块、表格、列表）
- 错误状态和空状态的 UI 细节

### Folded Todos
- **自动 AI 分析结果在告警列表中不可见 (V12-BACKLOG):** 通过 D-01~D-03（实现 slide_complete_analysis）+ D-11~D-12（修复标记显示）解决
- **自动 AI 分析结果在告警列表中不可见 (普通):** 同上，重複記錄一併處理
- **定时任务改为可配置:** 通过 D-15~D-16（自动分析 Cron 配置）解决
- **慢查询 avg_time_ms.toFixed 报错:** 在统一组件中做 null-safe 处理

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Roadmap
- `.planning/REQUIREMENTS.md` §AI-01 — AI 分析结果可见的完整验收标准
- `.planning/ROADMAP.md` §Phase 92 — 阶段目标与成功标准

### Backend — AI Analysis Infrastructure
- `apps/db-ops-api/src/ai-agent-bridge.ts` — 统一 AI 分析入口，dispatchOrReuse() 派发分析到 Gateway
- `apps/db-ops-api/src/ai-analysis-database-service.ts` — ai_analysis 表 CRUD（createAnalysis, completeAnalysis, getAnalysisList 等）
- `apps/db-ops-api/src/alert-rca-service.ts` — 告警 RCA 服务，analyzeAlert() 包含 related_id 关联和 Agent 调用
- `apps/db-ops-api/server.ts` §L1681-1815 — /api/ai/analysis 路由（POST/GET/:id/status/GET/:id/GET）
- `apps/db-ops-api/CLAUDE.md` — 待修复项：slide_complete_analysis 工具缺失

### Frontend — Current Analysis Display
- `frontend/src/openclaw/ui/views/ai-analysis-result.ts` — 现有 AI 分析结果组件（需重构为数据驱动 + 按类型渲染）
- `frontend/src/openclaw/ui/views/alerts.ts` — 告警列表页（含 _loadAnalyzedStatuses, _startRCA, _renderAnalysisSummary, 弹窗等）
- `frontend/src/openclaw/ui/views/instance-detail.ts` — 实例详情页（含 _runFaultDiagnosis, diagnosis 状态和轮询）

### OpenClaw Skills (for reference)
- OpenClaw skill 目录 — 参考现有 skill 文件结构，新建 `alert-rca.md` / `fault-diagnosis.md` / `topsql-analysis.md`

## Existing Code Insights

### Reusable Assets
- **`ai-analysis-result` Web Component** (`ai-analysis-result.ts`): 已有 startAnalysis/polling/result 渲染框架，重构为接收外部 result 数据即可
- **`marked` 库**: 已在 ai-analysis-result.ts 中 import，可直接用于 Markdown 渲染
- **`aiAnalysisDatabaseService.completeAnalysis()`**: 后端已有完整的结果存储机制，只需实现 slide_complete_analysis 工具来调用它
- **`alertRCAService.analyzeAlert()`**: 已有 related_id=alertId 的正确关联逻辑

### Established Patterns
- **Lit @state() + fetch**: 所有页面使用 Lit 状态管理 + fetch API，统一组件应遵循相同模式
- **Modal 弹窗模式** (`_renderAlertDetailModal`): 告警页已实现弹窗展示分析结果，可作为统一组件的嵌入参考
- **Polling 模式** (`_startDiagnosisPolling`): 3s 间隔轮询 + 超时处理，统一组件可复用

### Integration Points
- **Gateway chat.send**: ai-agent-bridge 通过 Gateway 派发分析 → Agent 执行 → 调用 slide_complete_analysis 写回结果
- **API /api/ai/analysis**: 前端读取分析结果的主要入口，可能需要新增 /api/ai/analysis/recent?instance_id=X&analysis_type=Y&limit=5
- **导航事件**: `slide-navigate` CustomEvent 用于从分析结果跳转到 Chat 页面或实例详情

## Specific Ideas

- 用户明确：分析结果使用 Markdown 而非 JSON，因为 Agent 对话输出天然就是 Markdown
- 用户关注 token 消耗：自动分析必须有完整开关和过滤机制，避免所有告警都触发分析
- Markdown 输出结构由 skill 文件约定标题层级，不强制 JSON schema

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 92-ai-analysis-visibility*
*Context gathered: 2026-05-13*
