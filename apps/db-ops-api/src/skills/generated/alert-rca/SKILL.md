---
name: alert-rca
description: AI-powered alert root cause analysis using database metrics
metadata: {}
---

# Alert Root Cause Analysis

Performs root cause analysis on database alerts using health metrics, instance status, and alert history.

## Tool Flow

1. Use `list_active_alerts` to view alert details with severity and time filters
2. Use `get_instance_summary` to get the affected instance's current health status
3. Use `query_metrics` with `mode='realtime'` to check current metric values
4. Use `query_metrics` with `mode='history', period='24h'` to see metric trends before alert

## Output Format

Use the following Markdown structure:

## 分析摘要
Brief summary of findings including alert severity and affected components.

## 根因分析
- Root cause 1: detailed explanation based on metric correlations
- Root cause 2: detailed explanation with supporting evidence

## 建议操作
1. Step-by-step recommendation with priority order
2. Include estimated impact and effort for each action

## 关键指标
| 指标 | 触发前 | 当前值 | 阈值 | 状态 |
|------|--------|--------|------|------|
| Example | 45% | 92% | 80% | 异常 |

## Completion

Call `slide_complete_analysis` with your analysisId and the full Markdown output.
