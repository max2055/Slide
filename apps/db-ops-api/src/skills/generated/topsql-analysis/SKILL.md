---
name: topsql-analysis
description: AI-powered TopSQL analysis for query performance optimization
metadata: {}
---

# TopSQL Analysis

Analyzes top slow queries and provides optimization recommendations using db_* tools.

## Tool Flow

1. Use `db_slow_queries` to get top slow queries by elapsed time
2. Use `db_performance_analysis` to correlate with system metrics
3. Use `db_health_check` to verify overall instance health

## Output Format

Use the following Markdown structure:

## SQL 概述
- Query ID and fingerprint
- Execution frequency and average latency
- Affected tables and indexes

## 性能分析
- Execution plan analysis (full table scan, index usage, join order)
- Resource consumption (CPU, IO, memory)
- Bottleneck identification

## 优化建议
1. Index optimization recommendations with expected improvement
2. Query rewrite suggestions with before/after examples
3. Configuration tuning if applicable

## 预期收益
| Metric | Before | After (Est.) |
|--------|--------|-------------|
| Avg latency | X ms | Y ms |
| Calls/min | N | N |

## Completion

Call `slide_complete_analysis` with your analysisId and the full Markdown output.
