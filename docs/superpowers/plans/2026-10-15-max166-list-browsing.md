# MAX-166 长列表实施计划

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 按已确认 R04 方案实现表结构、索引、指标、权限目录与报表历史的查找和分批浏览。

**Architecture:** 保留各页面布局和服务接口；共享轻量检索/页长/分页控件。先按既有资源条件筛选，再检索、稳定排序并分页。明确已载入范围，失败不展示旧结果，异步资源切换拒收旧响应。

**Tech Stack:** Lit、TypeScript、Vitest、Playwright。

1. 当前基线 Chromium 定向复现表与同名索引长列表；检查接口全量/截断边界。
2. 创建 `frontend/src/app/ui/components/list-browser.ts`：25/50/100 页长、搜索、上一页/下一页、范围与已载入数量、页码收敛、名称正反排序；复用 sharedBtnStyles。
3. `schema-management.ts` 接入表名称/注释检索，保留实例与展开详情。验证代表页面再推广。
4. `index-management.ts` 接入独立索引/未使用/冗余列表分页；按表名和索引名共同分组，列排序保持 seq_in_index；保留表筛选，切换实例拒收旧响应。
5. `metric-registry.ts` 接入 ID/名称检索，保留资源/数据库类型筛选及历史缺失 target_type 语义。
6. 核实权限目录实际所有权（当前在 rbac-page.ts，任务写 users-management.ts）；仅改确定授权的权限功能。
7. `reports.ts` 历史列表按标题/资源搜索，保留后端获取范围；分页期间不生成报表、不调用模型。
8. 添加错误/撤权后旧数据隐藏、同名索引、筛选页码重置与越界收敛回归。Playwright 覆盖100+表、数百索引、长权限/历史；明暗/390与1280视口、键盘、空/加载/失败/未知。真实服务基本流单列证据，受控数据明确标注。
9. 运行 focused tests、前端完整单测、typecheck/build；无公开契约变更无需 contracts gate。提交 codex 分支的 MAX-166 PR，核验 base/head，配置实际关联 PR 的 checks 条件与1800秒 timeout wake，回读后交付。
