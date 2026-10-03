# MAX-122 诊断证据与状态实施计划

> **Execution:** 在既有 W13 实施授权内执行，不委派代理；交付现有主任务审查合并。

**Goal:** 用户可从诊断页回答对象、依据时间、不确定性和下一步。

**Architecture:** 保留 Lit 页及现有 API。主摘要使用 app-card，证据/状态用 app-badge，重试用 app-dialog。原始 ID、gap code 和 JSON 保留折叠详情；部分完成只表示 completed 结果的 verification=partial，不能更改后端执行状态或宣称根因已验证。

**Tech Stack:** Lit、TypeScript、Vitest、Playwright/Chromium。

范围 v1：resource-diagnosis、直接关联 evaluation 状态解释及必要测试/config。排除视觉重设计、后端 API/数据库修改、真实供应商调用。预算未设定，实际 token/费用遥测不可用；代理数 0。停止条件为本地验收完成并提交 main PR，或确实缺少外部权限；合并由父任务完成。

1. 在 resource-diagnosis.test.ts 复现资源名称缺失、过期/未知证据、部分完成、状态查询超时及未知重试绕过的问题；运行 focused Vitest，记录失败。
2. 在 resource-diagnosis.ts 增加业务摘要，展示每项证据观测/有效期/质量，自动观测与推论/假设明确分离；原始信息留详情。无事实不判正常；过期/未知质量不当当前可信依据。
3. 映射 pending/running/completed/failed/unknown 和查询未确认；completed+partial 单独解释。未知任务禁用普通提交入口，费用确认通过既有 retryOf/confirmUnknownRetry 流程，查询不产生新任务。
4. resource-evaluation.ts 翻译规则异常、统计偏离和缺输入为业务解释，原始规则/原因/引用留详情；人工判断只作为判断，恢复仍需人工确认。
5. resource-diagnosis.spec.ts 使用假凭证和 API fixture：1440/375px、缺权限/缺数据/旧结果/网络超时、键盘导航/详情展开/对话框取消及确认、浏览器 ARIA snapshot 与无横向溢出。加入 audit 配置，保证 CI 覆盖。
6. focused tests 后对最终候选统一运行 frontend test/typecheck/build、lint 和 audit 浏览器 gate；截图实际查看。在 docs/slide/audits 写 base/head、命令/环境/结果及未验证边界。只提交必要文件，push/create main PR，关联任务，交付 in_review，不自行合并。

验收不将 ARIA snapshot 冒充人工读屏软件认证；未提供真实屏幕阅读器环境时明确报告限制。回滚为 revert 本任务提交，无迁移或历史数据写入。

范围补记 v1.1：resource-decisions 属于诊断页直接嵌入的状态展示；其人工判断类型和读取失败仍是原始代码，阻塞“人工确认/自动观测”和无权限反馈验收。仅调整说明、错误文案与详情折叠，不修改判断写入行为。资源用量累计不中断；仍未设硬预算、遥测不可用、代理 0。

范围补记 v1.2：实际 resource 分析结果接口只返回 result Markdown，analysis_envelope 已保存在同一授权记录但未返回，导致真实调用缺少 verification 与 evidenceSnapshot，直接阻塞部分完成及历史依据时间验收。资源结果服务的既有 result 字段优先返回已保存信封，旧记录仍回退 result；保持同账号/资源/权限快照验证、legacy unknown 隐藏与脱敏。补服务回归及受影响 API 契约生成核对，不新增 API 字段或后端执行状态。用量累计不重置，预算/遥测/代理约束不变。
