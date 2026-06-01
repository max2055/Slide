---
status: complete
phase: 89-gap-closure
source: 89-01-SUMMARY.md, 89-02-SUMMARY.md, 89-03-SUMMARY.md, 89-04-SUMMARY.md, 89-05-SUMMARY.md
started: 2026-05-13T00:00:00Z
updated: 2026-05-13T00:00:00Z
---

## Current Test

[testing complete] — 数据库选择器
expected: |
  打开 SQL 控制台，选择实例后在工具栏看到数据库下拉菜单。
  下拉菜单列出该实例所有数据库/schema。
  选择数据库后执行 SQL，执行结果来自所选数据库。
awaiting: user response

## Tests

### 1. SQL 控制台 — 数据库选择器 (D-01)
expected: 选择实例后工具栏显示数据库下拉菜单。
result: pass
note: 显示所有可访问数据库（含系统库），schema树暂未联动

### 2. 审批详情 — 目标数据库显示 (D-01)
expected: 提交审批后，审批详情页元信息卡片显示目标数据库名称。
result: pass

### 3. 慢查询 tab — badge 与内容一致 (D-03)
expected: 实例详情 → 慢查询 tab，badge 数与列表内容一致。首次加载时不应空白。
result: pass

### 4. 表结构检测 — 错误信息显示 (D-04)
expected: 表结构页点击"检测变更"，失败时显示具体 API 错误信息而非通用 "Bad Request"。
result: pass

### 5. 指标管理 — 内置指标说明 (D-05)
expected: 内置指标删除按钮 disabled 且有 tooltip 说明原因。
result: pass

### 6. EXPLAIN 普通化器 (D-06)
expected: 不同 MySQL/PostgreSQL EXPLAIN JSON 格式均能正确解析显示。
result: pass

### 7. 审批 checkbox 视觉 (D-07)
expected: 批量选择 checkbox 与执行开关视觉分离清晰。
result: pass

## Summary

total: 7
passed: 7
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none yet]
