---
name: topsql-analysis
description: AI-powered TopSQL analysis for query performance optimization
metadata: {}
---

# TopSQL Analysis

Analyzes top slow queries and provides optimization recommendations using metric data and instance health.

## Tool Flow

1. Use `get_instance_summary` to check overall instance health
2. Use `query_metrics` with `mode='realtime', metric_ids=['slow_queries', 'qps', 'cpu_usage']` to check current performance
3. Use `query_metrics` with `mode='history', period='24h'` to view historical trends
4. Use `list_active_alerts` to check for performance-related alerts

## Output Format

Use the following Markdown structure:

## SQL 概述
- Instance name and type
- Slow query count and trend
- Analysis time window

## 性能分析
- Root cause analysis (CPU bottleneck / IO wait / lock contention)
- Correlated metric observations (QPS, connections, CPU)
- Index or query pattern issues

## 优化建议
1. Index optimization with expected improvement
2. Configuration tuning recommendations
3. Application-side optimization suggestions

## 预期收益
| 指标 | 当前值 | 优化后估算 |
|------|--------|-----------|
| Slow queries/min | N | N/2 |

## Completion

Call `slide_complete_analysis` with your analysisId and the full Markdown output.
