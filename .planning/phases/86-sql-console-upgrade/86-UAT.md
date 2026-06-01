---
status: complete
phase: 86-sql-console-upgrade
source: 86-01-SUMMARY.md, 86-02-SUMMARY.md, 86-03-SUMMARY.md, 86-04-SUMMARY.md, 86-05-SUMMARY.md
started: 2026-05-12T00:00:00Z
updated: 2026-05-12T00:00:00Z
---

## Current Test

number: 1
name: 多标签页编辑器 — 创建、切换、关闭、重命名
expected: |
  打开 SQL 控制台页面。默认有一个标签页。
  - 点击 "+" 新建标签页（应出现新标签，默认名称基于首行 SQL 或"标签 N"）
  - 点击标签切换，每个标签独立编辑
  - 双击标签名称可重命名（inline edit）
  - 关闭标签弹出确认框，确认后关闭
  - 刷新页面后标签和内容恢复（localStorage 持久化）
awaiting: user response

## Tests

### 1. 多标签页编辑器 — 创建、切换、关闭、重命名
expected: 打开 SQL 控制台页面。默认有一个标签页。点击 "+" 新建标签页。点击标签切换编辑区域。双击标签名称可重命名。关闭标签弹出确认框。刷新页面后标签和内容恢复。
result: issue
reported: "执行查询后，历史列表不即时刷新；刷新页面后标签在但内容丢失"
severity: major
fixed: "EditorView.updateListener 添加 docChanged → _saveTabs(); _directExecute 成功后刷新 history"

### 2. SQL 自动补全 — Schema 驱动的表/列提示
expected: 输入 SQL 时，编辑器提供自动补全。输入表名后跟 `.` 应提示该表的列名。输入 SQL 关键词也有提示。SELECT/FROM/WHERE 等场景下智能提示。
result: pass

### 3. 结果表格 — 排序、分页、CSV 导出
expected: 执行 SQL 后结果表格支持点击列头排序（升序/降序/无）。底部分页控件可选择 25/50/100/All 每页条数。点击"导出 CSV"按钮下载 CSV 文件（UTF-8 BOM + RFC 4180 格式）。
result: pass

### 4. 查询历史面板 — 搜索、过滤、点击加载
expected: >..<
result: pass

### 5. EXPLAIN 执行计划 — 树形/表格切换 + 效率评级
expected: 点击"分析计划"按钮后，展示执行计划。可切换树形/表格视图。树形视图节点可展开/折叠。顶部摘要栏显示总 cost、扫描行数、效率评级（优秀/良好/一般/较差）。
result: pass

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none]
