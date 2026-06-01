# Phase 92: AI Analysis Visibility - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-13
**Phase:** 92-ai-analysis-visibility
**Areas discussed:** 告警列表自动分析标记修复, 分析结果统一展示格式, 实例详情页诊断历史展示, 自动/手动分析区分, slide_complete_analysis 工具设计, skill 文件设计, 自动分析 cron 配置

---

## 告警列表自动分析标记修复

| Option | Description | Selected |
|--------|-------------|----------|
| 添加错误日志+修复 | 在 _loadAnalyzedStatuses 中添加 console.warn 暴露失败原因，同时排查 token key 一致性 | ✓ |
| 仅显示已完成分析 | 过滤 status=completed，只对真正完成的分析显示「已分析」标记 | |
| 全面排查再定 | 先运行后端和前端，在浏览器中实际观察网络请求和返回数据再确定修复方案 | |

**User's choice:** 添加错误日志+修复
**Notes:** 用户不确定根因，需要通过日志排查。后续进一步决策：running 状态也显示标记（completed→「已分析」、running→「分析中」、failed→「分析失败」）

---

## 分析结果统一展示格式

| Option | Description | Selected |
|--------|-------------|----------|
| 统一为一个组件 | 将 alerts.ts 和 instance-detail.ts 的分析展示逻辑统一到 ai-analysis-result.ts 组件中 | ✓ |
| 保持各自独立 | 各页面保留自己的分析展示逻辑 | |
| 统一组件+格式 | 既统一为一个组件，也标准化后端 result JSON 结构 | |

**User's choice:** 统一为一个组件
**Notes:** 组件按分析类型区分渲染（alert_rca / fault_diagnosis / topsql），数据驱动（传 result + analysisType），不处理 API 请求和 polling

---

## 实例详情页诊断历史展示

| Option | Description | Selected |
|--------|-------------|----------|
| 最近N条摘要列表 | 最近 5 条诊断摘要（状态+时间+一句话摘要），点击展开完整结果 | ✓ |
| 仅显示最新一条 | 当前行为 | |
| 时间线展示 | 时间线形式展示所有诊断记录 | |

**User's choice:** 最近 5 条摘要列表

---

## 自动/手动分析区分

| Option | Description | Selected |
|--------|-------------|----------|
| 标记来源即可 | 分析结果旁标注「自动分析」或「手动分析」小标签，结果展示格式相同 | ✓ |
| 不需要区分 | 自动和手动分析结果完全一样展示 | |
| 展示策略不同 | 自动分析默认摘要+展开查看完整，手动分析默认显示完整结果 | |

**User's choice:** 标记来源即可

---

## 展示形式

| Option | Description | Selected |
|--------|-------------|----------|
| 弹窗/抽屉中展示 | 点击标记弹出详情（类似当前 alerts.ts 的 modal 模式） | ✓ |
| 内联展开 | 在表格行内直接展开分析结果 | |
| 跳转 Chat 页面 | 点击后跳转到对应的 Agent 对话 session | |

**User's choice:** 弹窗/抽屉中展示

---

## slide_complete_analysis 工具设计

| Option | Description | Selected |
|--------|-------------|----------|
| analysisId + result JSON | Agent 传 analysisId + 结构化 JSON，工具校验 schema | |
| analysisId + Markdown | Agent 传 analysisId + Markdown 文本，直接存储 | ✓ |
| 仅 result JSON | 后端自动匹配最近的 running 分析记录 | |

**User's choice:** analysisId + Markdown
**Notes:** 用户指出 Agent 对话输出天然是 Markdown，不需要额外 JSON 格式转换。前端用 marked 渲染

---

## Skill 文件设计

| Option | Description | Selected |
|--------|-------------|----------|
| 每种类型一个 skill | alert-rca.md / fault-diagnosis.md / topsql-analysis.md | ✓ |
| 一个通用 skill | 一个 analysis.md 包含所有分析类型 | |
| skill + System Prompt | skill 定义工具流程，System Prompt 定义输出格式 | |

**User's choice:** 每种类型一个 skill
**Notes:** 每个 skill 定义：工具调用流程、Markdown 输出标题结构、最终调用 slide_complete_analysis

---

## 自动分析 Cron 配置

| Option | Description | Selected |
|--------|-------------|----------|
| 启用/禁用 + 级别过滤 | 全局开关 + 仅对 critical/error 级别自动分析 | |
| 启用/禁用 + 实例过滤 | 全局开关 + 白名单实例 + 级别过滤 | |
| 完整调度配置 | cron 表达式可配 + 级别过滤 + 实例过滤 + 时间段限制 | ✓ |

**User's choice:** 完整调度配置
**Notes:** 用户关注 token 消耗，需要完整控制粒度。配置持久化到 system_config 表

---

## Claude's Discretion

- Markdown 输出模板的具体标题层级和措辞
- 前端渲染 Markdown 时的样式优化（代码块、表格、列表）
- 错误状态和空状态的 UI 细节

## Deferred Ideas

None — discussion stayed within phase scope.
