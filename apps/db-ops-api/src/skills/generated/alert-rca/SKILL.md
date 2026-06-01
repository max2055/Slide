---
name: alert-rca
description: AI-powered alert root cause analysis using database metrics
metadata: {}
---

# Alert Root Cause Analysis

Performs root cause analysis on database alerts using db_* tools.

## Tool Flow

1. Use `db_health_check` to get current instance health status
2. Use `db_performance_analysis` to get metric trends
3. Use `db_slow_queries` to check slow query data

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
| Metric | Value | Status |
|--------|-------|--------|
| Example | 95% | Normal |

## Completion

Call `slide_complete_analysis` with your analysisId and the full Markdown output.
