# Phase 121: 可信闭环与体验打磨 - Context（修订版）

## Objective

将 Slide 从"功能模块完整"推进到"关键链路可信、首次体验顺畅、核心 UI 统一"的产品状态。

六件事按优先级：闭环健康中心 → 首次启动检查 → 设置页收尾 → 金牌链路文档 → 通知闭环排期 → 定时任务可靠性优化。

## Background

2026-06-24 评估结论：
- 闭环模型合理，但缺少统一的一致性健康检查 API 和产品化展示。
- 代码中已有闭环部件（监控采集、告警评估、事件聚合、Cron 日志等），但没有集中检查入口。
- 关键用户故事缺少可重复验证文档，但不适合在当前环境做 E2E（实例不可达、Cron 全禁用）。
- 设置页统一工作已大部分完成，只需收尾验证。

## Scope

### In Scope

1. 闭环健康中心（121-01a + 121-01b）
   - 后端新增 consistency checker service + API。
   - 前端新增闭环健康页面。
   - 覆盖 10 个可自动检查的闭环类别。
   - 通知闭环标记为 deferred，给出修复路径。

2. 首次启动检查（121-04）
   - 复用 consistency API 的 readiness section。
   - 前端展示：主库连接、实例可达性、LLM Provider、Cron 状态、Agent Engine 状态。

3. 设置页/管理页模板收尾（121-03）
   - 验证 Phase 120 + 当前分支的修改已完成。
   - Grep guardrail + 截图对比，修复遗漏。

4. 金牌链路文档（121-02）
   - 手动验证 checklist 形式。
   - 等环境恢复后再做 Playwright E2E。

5. 定时任务可靠性优化（121-05）
   - next_run_at 持久化到数据库，前端不再显示 "—"。
   - CronExecutor 增加 wall-clock 硬超时（Promise.race）。
   - 手动触发结果写入 last_result。
   - 启动时清理崩溃残留 running 日志。
   - 修复 REVIEW.md 发现的 WR-01（poll 泄露）和 WR-05（formSaving 残留）。

### Out of Scope

- 告警通知自动发送链路（排入下一 phase）。
- 新的数据库类型支持。
- 大规模重写 agent-core。
- 引入新的设计系统或 UI 框架。

## Execution Order

1. 121-01a: 闭环一致性检查后端 API + 测试
2. 121-01b: 闭环健康中心前端页面
3. 121-04: 首次启动检查（复用 121-01 的 readiness API）
4. 121-03: 设置页模板统一收尾
5. 121-02: 金牌链路验证文档（手动 checklist）
6. 121-05: 定时任务可靠性优化

## Success Criteria

1. `GET /api/health/consistency` 返回结构化检查结果，至少覆盖：
   - instance_count_match, capacity_sum_match, metrics_freshness,
   - alert_rule_metric_refs, event_member_status_match,
   - rbac_orphan_records, cron_hung_jobs,
   - chat_session_stats, approval_event_integrity,
   - notification_closure_deferred
2. 前端闭环健康页面展示 pass/warn/fail/deferred 状态和修复建议。
3. 首次启动检查能告诉用户系统是否 ready，给出修复路径。
4. Build passes，无新增手写 `.card` / `.modal-overlay` 等禁止模式。
5. 金牌链路有可执行的手动验证 checklist。
6. 定时任务 next_run_at 准确更新、超时强制生效、手动触发结果完整记录、崩溃恢复自愈。

## Constraints

- 遵守 AGENTS.md 前端共享组件规则。
- 不回滚用户已有改动。
- 通知闭环 deferred，不半实现。

## References

- Obsidian 闭环分析文档：`202606191449-Slide项目完整分析-闭环验证与用户故事.md`
- Phase 120 共享组件规则：`AGENTS.md`
- API 入口：`apps/db-ops-api/server.ts`
- 前端设置入口：`frontend/src/app/ui/views/settings-shell.ts`
