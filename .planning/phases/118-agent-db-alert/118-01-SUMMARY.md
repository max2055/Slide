---
phase: 118-agent-db-alert
plan: "01"
subsystem: api
tags: [alert, metrics, bugfix, fastify]

requires: []
provides:
  - Fixed _availability false alerts from stale metrics detection
  - Fixed resolveDynamicThreshold overriding explicit rule thresholds
  - Fixed API metric_name returning null
affects: [118-02]

tech-stack:
  added: []
  patterns:
    - "Instance health_status gate: availability alerts only fire for critical health_status + stale metrics"
    - "Threshold priority: explicit threshold > threshold_template > metric_definition defaults"
    - "API response completeness: all DB columns mapped to response fields"

key-files:
  created: []
  modified:
    - apps/db-ops-api/src/alert-evaluator.ts
    - apps/db-ops-api/src/alert-database-service.ts

key-decisions:
  - "Stale threshold raised from 5min to 10min to match 3x collection interval"
  - "Availability alerts gated on health_status='critical' to prevent false alarms on healthy instances"
  - "Static rules with explicit threshold now bypass threshold_template resolution"

patterns-established:
  - "multi-level threshold evaluation: static rules with explicit threshold use single-threshold path"

requirements-completed: [R2, R3, R4]

duration: 8min
completed: 2026-06-09
---

# Plan 118-01: 告警系统 Bug 修复 总结

**修复 3 个告警系统 bug：可用性误报阈值调整、阈值优先级修复、API 字段补全**

## 问题与修复

### Bug 1: `_availability` 误报
- **问题**: 健康实例每 15 分钟触发一次可用性告警
- **根因**: stale 检测阈值固定 5 分钟，但 monitor-collector 采集间隔为心跳 10s + 定时采集 5min，某些指标采集间隔 > 5min
- **修复**: 阈值提升至 10 分钟，并仅当 `health_status='critical'` 时才创建可用性告警

### Bug 2: QPS 阈值绕过
- **问题**: Oracle QPS 规则阈值设为 30000 但 QPS~888 仍在触发告警
- **根因**: `evaluateRuleWithLevels()` 中 `threshold_template`（来自 metric_definition）优先于规则显式 `threshold` 值
- **修复**: static 规则有显式 threshold > 0 时，优先使用单阈值评估，不再被 threshold_template 覆盖

### Bug 3: API `metric_name` 为 null
- **问题**: 前端 API 返回的告警数据中 `metric_name` 始终为 null
- **根因**: `getAlerts()` 的 items 映射未包含 `metric_name`、`metric_value`、`threshold_value`、`description` 字段
- **修复**: 在 items 映射中补充这 4 个字段

## 文件变更
- `apps/db-ops-api/src/alert-evaluator.ts` — stale 阈值调整 + health_status gate + 阈值优先级修复
- `apps/db-ops-api/src/alert-database-service.ts` — items 映射补充缺失字段

## 决策
- 阈值优先级链：规则显式 threshold > threshold_template > metric_definition 默认值
- 可用性告警条件收窄：需同时满足 health_status='critical' + metrics 过期/缺失

---
*Plan: 118-01*
*Completed: 2026-06-09*
