---
name: fault-diagnosis
description: AI-powered database instance fault diagnosis
metadata: {}
---

# Fault Diagnosis

Diagnoses database instance faults using db_* tools.

## Tool Flow

1. Use `db_health_check` to get current instance health status
2. Use `db_active_sessions` to inspect running sessions and blocking locks
3. Use `db_performance_analysis` to analyze metric trends

## Output Format

Use the following Markdown structure:

## 诊断概述
Brief summary of the diagnosed issue, affected components, and severity.

## 问题分析
- Issue description with specific symptoms
- Root cause analysis with supporting metrics and session data
- Timeline of events if identifiable

## 修复步骤
1. Immediate action to mitigate impact
2. Short-term fix with verification steps
3. Long-term preventive measures

## 验证建议
- Steps to verify the fix took effect
- Monitoring recommendations to prevent recurrence

## Completion

Call `slide_complete_analysis` with your analysisId and the full Markdown output.
