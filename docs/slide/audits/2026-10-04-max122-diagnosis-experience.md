# MAX-122 / W13 诊断证据与运行状态验收

范围版本 v1 → v1.1（直接嵌入的人工判断展示）→ v1.2（返回已保存的结果信封）。详细执行边界见 `docs/superpowers/plans/2026-10-04-max122-diagnosis-experience.md`。前置 W05/W08/W10/W11 及严格串行上一项 MAX-120 均已由父任务核实合并与验收；本任务不推进后续阶段。

基线：`1b6d5dc2d9121b636f3180573199e4c570a78e3d`（origin/main，2026-10-04 fetch）。实现提交见本报告所在提交的直接父提交；报告提交仅增加本文件，复用未变化的代码/配置验收证据。PR 最终精确 head 另回写 MAX-122 评论。

## 行为及兼容决定

- 主摘要展示资源名称、当前证据是否可用、读取时间与观测时间的区别、有效事实数量、不确定性和下一步。配置在线不冒充健康；缺失/过期/未知质量/未知或未来时间不当当前可信依据。
- 证据摘要展示指标、质量、观测/有效期与自动观测/推论/假设。ID、关联 ID、gap code、JSON 保留折叠详情；缺口映射为业务说明与下一步，未知代码保守解释。
- pending 是排队，running 是运行，failed 没有可用结论，unknown 是供应商可能已执行且计费但结果无法确认。查询超时/拒绝/不可用单独显示“状态待确认”，保留上次状态和任务身份，不能直接重复提交。
- completed 且 verification=partial 展示“部分完成（证据不完整）”：执行已经结束，证据覆盖未完成；不是新增后端状态。历史采集时间来自已保存 evidenceSnapshot，缺少则明确未知；当前观测另列，刷新不会更新旧结论。引用绑定不代表根因确认，未验证 Evidence ID 的提示保留。
- unknown 普通开始入口禁用，仅费用确认对话框发送既有 `{retryOf, confirmUnknownRetry:true}`。展示可能再次计费及具体金额无法估算；取消/查询不 POST。失败后的新分析也提示费用。15 秒证据/状态读取超时可见；证据加载失败不阻止查询已存在的任务。
- 自动规则超界、统计偏离、无法判断分别解释；人工推论/假设不等于事实确认或处理/恢复。建议未自动执行，恢复仍需人工确认。
- 资源分析 GET 既有 `result` 字段优先使用同一记录的 `analysis_envelope`，无信封的旧记录回退 `result`。保留账号/资源/权限快照检查、legacy unknown 的结果隐藏和脱敏。无新 API 字段、迁移或执行状态；生成契约无差异。其他分析结果接口不变。

## 复现与验证

环境：macOS 本地隔离 worktree，Node/pnpm 项目环境，Chromium headless；Vite 测试启动在 `127.0.0.1:5186`，由 Playwright 生命周期管理。API/模型/认证使用 fixture，未调用付费模型、真实凭证或用户服务；未修改 `.env`。

首先复现 4 项前端失败：缺业务摘要、缺 partial 展示、unknown 普通入口可提交、查询超时无独立状态。另复现服务仅返回 Markdown、未返回已存储 verification/snapshot 的失败。修复后 focused 检查通过。新增测试最初的无效子组件响应夹具曾产生 unhandled rejection，已修正并重新运行相关最终单元门禁；没有忽略错误。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm --filter slide-frontend test` | 83 文件、574 测试通过；0 unhandled error |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm --filter slide-frontend build` | 通过，含 CSP 校验；存在既有分块/动态导入提示 |
| `pnpm --filter slide-frontend test:browser` | 56 通过，含本任务 8 场景；42.9 秒 |
| `pnpm --filter slide-api exec vitest run src/resources/resource-agent-diagnosis-service.test.ts src/resources/resource-routes.test.ts src/contracts/public-api.test.ts` | 22 通过；含结构化结果/旧结果回退、不同账号拒绝、legacy unknown 隐藏 |
| `pnpm --filter slide-api test` | 317 文件 / 3015 测试通过；27 文件 / 250 环境型测试跳过，未计为通过 |
| `pnpm --filter slide-api typecheck` | 通过；AiAnalysisRecord 补已存储字段类型声明后核验 |
| `pnpm contracts:generate` / `pnpm contracts:check` | 通过，生成产物无差异 |
| `pnpm lint` | 0 错误，262 既有警告；本任务 9 个重点代码/测试文件的 scoped oxlint 为 0 警告 / 0 错误 |
| `git diff --check` | 通过 |

浏览器在 1440×900 与 375×812 覆盖：资源名称/规则异常，排队→运行→未知→费用确认→部分完成→失败，历史采集时间与当前观测；无 ai:manage 时隐藏提交、证据和结果 403、没有证据、过期结果、15 秒状态与证据读取超时；未知及状态不明禁止直接重新计费，读取证据失败仍保留任务身份。

纯键盘实测：搜索→资源选择→原生 details Enter 展开→诊断按钮 Enter；重试 dialog 的 Tab/Shift+Tab 焦点约束、Escape 关闭与焦点恢复、确认按钮提交既有重试参数；当前证据链接以键盘聚焦实际证据区域，随后 Tab/Enter 展开引用详情。实际 Chromium ARIA snapshot 核对资源标题、status、dialog 名称与按钮、具名事实 region。受影响交互无 pageerror，桌面与窄屏均无横向溢出。实际查看 overview/result/detail 截图，使用共享组件、主题 token 与 Boolean property binding。

截图由 `resource-diagnosis.spec.ts` 生成：`diagnosis-overview-1440.png`、`diagnosis-overview-375.png`、`diagnosis-result-1440.png`、`diagnosis-result-375.png`、`business-diagnosis-*.png`，关键截图随任务评论附件交付，不依赖运行目录链接。

## 限制及回滚

读屏语义为实际浏览器 accessibility tree/ARIA snapshot 与键盘验证，未使用 VoiceOver/NVDA 人工听读，不宣称正式 WCAG 或真实屏幕阅读器认证。未做真实模型质量/生产数据库/真实 JWT 端到端认证；后端 MySQL 环境型测试跳过，现有 CI 的隔离 qualification 由主任务合并门禁核验。本任务不 self-approve、不合并或标 done；交付 in_review，父任务审查当前 PR head 与八项 CI 后合并。

回滚：revert 本任务实现提交和报告提交；无迁移/历史数据修改。旧结果 fallback 保留。

硬预算未设定；实际 raw input/cached input/output/费用遥测增量不可用，不填写估算实测数。代理总数 0，最大子代理深度 0，并发峰值 1；范围补记没有重置累计用量。
