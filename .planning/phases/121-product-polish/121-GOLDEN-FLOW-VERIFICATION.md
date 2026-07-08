# Slide 金牌用户故事 E2E 验证清单

**Phase:** 121
**创建日期:** 2026-06-24
**目标:** 端到端验证 DBA 核心链路：实例添加 → 指标采集 → 健康评分 → 告警触发 → 事件聚合 → AI 根因分析 → 通知 → 用户处置 → 历史追溯 → 闭环健康检查

---

## 前置条件

- [ ] 至少 1 个数据库实例已添加且状态为 active（测试连接通过）
- [ ] 至少 1 个 Cron Job 已启用（如「容量数据采集」）
- [ ] 至少 1 个 LLM Provider 已配置且 enabled（用于 AI RCA）
- [ ] 至少 1 条告警规则阈值设置在可触发范围内
- [ ] 系统 API 可通过浏览器正常访问

## 已知限制

- 通知闭环未实现（见 Phase 121 通知 deferred 说明；`consistency-checker.ts` `_checkNotificationDeferred()` 返回 `status: 'deferred'`）
- 当前环境 4/5 实例不可达，13 个 Cron Job 全禁用。部分步骤可能因环境条件跳过，等环境恢复后可完整执行
- 本文档为手动验证清单，非自动化 E2E。Playwright 脚本将在环境恢复后编写

---

## 验证步骤

| # | 步骤名称 | 操作说明 | 预期结果 | 验证方法 | 通过条件 | 实际结果 | 状态 | 备注 |
|---|----------|---------|---------|---------|---------|---------|------|------|
| 1 | 实例可用性 | 打开「数据库实例」页面，查看已添加实例列表 | 至少 1 个实例状态为 `active`，`health_status` 不是 `unknown` | 浏览器打开 http://localhost:5173 → 导航到「数据库实例」 | 看到至少一个实例 status=active，health_status 有值 | | | 如实例不可达，请在「添加实例」页面添加可达测试实例并测试连接 |
| 2 | 指标采集 | 等待 Cron 触发采集（最长 5 分钟），或手动触发采集 | `metrics_history` 表有新记录，`recorded_at` 在最近 10 分钟内 | SQL: `SELECT COUNT(*) as cnt, MAX(recorded_at) as latest FROM metrics_history WHERE instance_id = ?` | cnt > 0 且 latest 在 10 分钟内 | | | 如 Cron 未运行，在「定时任务」页面启用「容量数据采集」 |
| 3 | 健康评分 | 打开实例详情页（点击实例名称），查看「健康评分」概览 | `health_score` 显示基于维度的真实计算值（非硬编码 100），`health_check_history` 中有多条记录 | 浏览器打开 Instances → 选择一个实例 → 查看概览页 | health_score 正常显示且有历史记录 | | | — |
| 4 | 告警触发 | 设置低阈值告警规则（如 `health_score < 90`），等待评估周期触发，或手动创建测试告警 | `alerts` 表出现新 `status=open` 的记录 | 打开「告警列表」页面，查看是否有新告警 | 至少有 1 条 open 状态告警 | | | 可先在「告警规则」页面创建低阈值规则（如 health_score < 90, operator: <, threshold: 90） |
| 5 | 事件聚合 | 同一实例关联告警自动（或等待）聚合到 `alert_events` | `alert_events` 表中有新事件，且 `alert_event_members` 中有对应成员记录 | 打开「告警事件」视图，查看事件列表 | 事件正确聚合了告警成员，members 计数对得上 | | | 事件聚合可能需要 10 分钟滑动窗口。注意：一致性检查（121-01a）覆盖 event_member 状态一致性问题 |
| 6 | AI 根因分析 | 打开已触发告警的详情，触发 AI RCA 分析，或等待自动分析 | `ai_analysis` 表生成分析结果，有根因和建议 | 打开告警详情页 (Alert Detail Modal) → 检查 AI 分析选项卡 | 看到 AI 生成的根因分析和修复建议 | | | 需要 LLM Provider 正常可用。如分析未自动触发，可在告警详情中手动触发 |
| 7 | 通知记录 | 检查 `notification_records` 表是否有与此告警关联的记录 | **已知 gap** — 通知发送链路（钉钉/企微/飞鹰/webhook）未实现。`notification_records` 可能为空或无发送配置 | SQL: `SELECT * FROM notification_records WHERE alert_id = ?` | **DEFERRED** — 通知闭环推迟到下个 phase。此步骤无需通过 | | DEFERRED | 通知闭环完整实现在后续 phase 规划。`_checkNotificationDeferred()` 在 consistency 检查中返回 `status: 'deferred'` |
| 8 | 用户处置 | 手动关闭告警、resolve 关联事件 | `alert` 状态变更为 `resolved` 或 `closed`；`alert_event` 状态同步变更 | 在告警列表点击关闭 → 查看状态变更；在事件列表点击 resolve | 告警和事件状态同步变更 | | | 注意 event_member 状态一致性（121-01a 一致性检查覆盖此场景） |
| 9 | 历史可追溯 | 查看已关闭告警的历史记录和事件时间线 | 可以在告警历史页看到已关闭告警，事件时间线完整 | 在告警列表切到历史视图，点击事件查看时间线 | 历史的告警记录存在且可展开查看详情 | | | — |
| 10 | 闭环健康检查 | 打开「设置 → 闭环健康」页面 | health center 展示各检查项结果，对应步骤的检查项应显示 pass 或相应的状态 | 浏览器打开 Settings → 闭环健康 tab | 页面正常加载，实例/指标/告警/事件/Cron 等检查项显示正确的状态 | | | 某些检查项因环境限制可能显示 warn 或 fail，属于正常情况。未就绪的项在「建议操作」面板中会给出修复指导 |

---

## 汇总

| 类别 | 通过 | 失败 | 跳过 | 备注 |
|------|------|------|------|------|
| 实例/采集（Steps 1-3） | — | — | — | |
| 告警/事件/处置（Steps 4-5, 8） | — | — | — | |
| AI 分析（Step 6） | — | — | — | |
| 通知（Step 7） | — | — | 1 (DEFERRED) | 下个 phase 实现 |
| 闭环检查/历史（Steps 9-10） | — | — | — | |

---

**测试环境信息：**
- 后端 commit SHA: (填写)
- 前端 commit SHA: (填写)
- 测试日期: (填写)
- 测试人: (填写)

---

**使用说明：**
1. 执行前勾选「前置条件」中的所有项
2. 按步骤 1-10 顺序执行，每步完成后在「状态」列标记 `[x] pass` / `[ ] fail-{原因}` / `[ ] skip-{原因}` / `[ ] deferred`
3. 「实际结果」列记录执行过程中的观测值（如：实际告警数、延迟时间、具体页面截图说明等）
4. 「备注」列已预填操作指导和已知注意事项
5. 完成后填写「汇总」表并填写环境信息
