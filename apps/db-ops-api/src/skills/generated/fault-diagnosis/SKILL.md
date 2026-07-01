---
name: fault-diagnosis
description: AI-powered database instance fault diagnosis
metadata: {}
---

# Fault Diagnosis

Diagnoses database instance faults by collecting health metrics, alerts, and performance data.

## Tool Flow

1. Use `get_instance_summary` to get current instance health status
2. Use `query_metrics` with `mode='realtime'` to get live metric snapshot
3. Use `query_metrics` with `mode='history', period='24h'` to view metric trends
4. Use `list_active_alerts` to check for active alerts on the instance

## Output Format

Use the following Markdown structure:

## 诊断概述
Brief summary of the diagnosed issue, affected components, and severity.

## 问题分析
- Issue description with specific metrics
- Root cause analysis with supporting data
- Timeline of events if identifiable

## 修复步骤
1. Immediate action to mitigate impact
2. Short-term fix with verification steps
3. Long-term preventive measures

## 指标摘要
| 指标 | 当前值 | 状态 | 说明 |
|------|--------|------|------|

## 验证建议
- Steps to verify the fix took effect
- Monitoring recommendations to prevent recurrence

## Completion

Call `slide_complete_analysis` with your analysisId and the full Markdown output.
