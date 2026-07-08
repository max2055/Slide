---
phase: 121-product-polish
status: planned
created: 2026-06-24
updated: 2026-06-24
requirements: [POLISH-01, CONSISTENCY-01, GOLDEN-FLOW-01, ONBOARDING-01, UI-CONSISTENCY-02]
---

# Phase 121 Validation Plan（修订版）

## Plan Structure（修订后）

| Plan | Type | Wave | Depends | Description |
|------|------|------|---------|-------------|
| 121-01a | execute | 1 | — | 闭环一致性检查后端 API + 测试 |
| 121-01b | execute | 2 | 01a | 闭环健康中心前端页面 |
| 121-04 | execute | 3 | 01a | 首次启动检查（复用 readiness API） |
| 121-03 | verify | 3 | — | 设置页模板统一收尾（grep guardrail + build） |
| 121-02 | verify | 5 | 04 | 金牌链路手动验证文档（checklist） |

## Required Verification

| Plan | Verification |
|------|--------------|
| 121-01a | Unit test 至少 3 个 check 方法；API smoke test 返回符合 schema 的 JSON |
| 121-01b | Build passes；页面在设置导航可见；渲染 4 种状态 |
| 121-04 | Readiness API 缺依赖时返回 degraded；前端显示修复建议 |
| 121-03 | Build passes；grep guardrails 零增量违规 |
| 121-02 | 输出手动验证 checklist 文档；每步记录实际结果 |

## Exit Criteria

- `npm run build` succeeds for frontend.
- Backend relevant unit tests pass.
- `GET /api/health/consistency` returns stable schema.
- Notification closure remains deferred, not accidentally half-implemented.
- No新增 `.card` / `.modal-overlay` / `class="btn primary"` 等禁止模式。
- Phase 120 remains closed; Phase 121 owns new polish work.
