---
phase: 114-verification-清账
created: 2026-05-27
status: discussed
---

# Phase 114: Verification 清账

## Objective

执行 Phase 100/102/112 遗留的 12 项 human_needed 验证项，关闭所有 HUMAN-UAT pending 项，清空 verification debt。

## Scope

### Phase 100 (2 项) — 安全紧急修复

1. **Login page eyeOff icon (SEC-02)**: 浏览器打开登录页，点击密码可见性切换，eyeOff 图标应正常渲染无 JS 错误
2. **Unauthenticated 401 responses (SEC-01)**: curl 不带 auth header 请求 4 个受保护路由，全部返回 401

### Phase 102 (5 项) — UI 统一

3. **Login page renders without errors**: 登录页加载无错误，密码 eye/eyeOff 图标正常
4. **Dashboard stat cards**: 6 张 stat cards 正确显示 label/value/hint，颜色正确
5. **Migrated stat-card views**: Alerts/Reports/Schema Management/Overview 页 stat-card 颜色和内容正确
6. **Emoji replacement**: Query Analysis 页 search/bar-chart 图标, Instance Detail 页 package 图标, Event Management 页 triangle-alert 图标都渲染为 SVG
7. **No console errors**: 所有页面 DevTools Console 无 JS 错误

### Phase 112 (5 项) — 前端清理 & 定时任务

8. **Settings tab navigation**: "Cron Jobs" tab 在 Settings 组中正确显示
9. **Toggle switch enable/disable**: 开关立即切换状态，API 成功时持久化，失败时回退
10. **Inline cron expression editor**: 双击编辑，预设下拉填充，预览下 5 次执行时间
11. **Backend server startup**: 后端启动无报错
12. **E2E full flow**: 创建任务 → 编辑 cron → 切换开关 → 删除任务 全流程

## Locked Decisions

### D-01: 验证方式 — 人工在浏览器中执行
所有 12 项都是 human_needed 类型，需要在浏览器中实际验证。不是自动化测试。

### D-02: 输出 — 更新 HUMAN-UAT/VERIFICATION 文件
验证完成后更新对应 phase 的 HUMAN-UAT.md 或 VERIFICATION.md 为 `status: resolved`。

### D-03: 范围 — 仅 12 项，不加新范围
不修改任何源码。纯验证 + 文档更新。如果发现 bug，记录但不在此 phase 修复。

### D-04: 依赖 — 前后端都需运行
验证需要 backend (port 3000) + frontend (port 5173) 都在运行。
