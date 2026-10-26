# Slide 范围收敛与原型 V4 更新计划

> **Execution:** Follow this plan within existing authorization and repository rules; track dependencies and acceptance evidence. 本轮由主代理实施，不派生代理，不启动外部任务。

**Goal:** 将用户确认的版本边界写入项目规则，同步更新原生模板/无 Agent 采集方案与可点击原型。

**Architecture:** 沿用独立 Lit 原型，主页面保留既有 AI 调查；通过局部采集映射组件展示已注册指标、原始输出和转换链。只使用本地演示数据，不修改生产服务、配置或数据库。

**Tech Stack:** Lit、TypeScript、Vite；Markdown；CUA 浏览器检查。

## 1. 快照与范围（依赖：已确认讨论）
- [x] 将 V3 源码、三份设计及交付索引归档 archive-v3，保留 screenshots-v3。
- [x] 新建 docs/slide/requirements/current-version-scope.md，写入已确认排除项、桌面基线及保留质量。
- [x] 根/前端 AGENTS.md 引用范围，取消通用移动/深色验收扩张；不清理未触达产品功能。

## 2. 详细方案（依赖：1）
- [x] 更新 docs/superpowers/specs/2026-10-22-monitoring-operations-optimization-design.md 为 V4：去除本版 Zabbix 集成/导入适配路线，补无 Agent 采集映射、模板人工建设及事件职责。
- [x] 同步 AI 工作空间、输入负担文档中的范围；保留历史决策和分阶段交付边界。
- [x] 验收追加：原始输出→指标→模板项→序列→规则引用可追溯；无实现阻止启用；事件快照不受新模板/资源参数污染。

## 3. 原型（依赖：2）
- [x] prototype/main.ts：移除深色切换、事件“规则与策略”；模板改为原生内置/自定义，无上游转换状态。
- [x] 新建 prototype/collection-v4.ts：模板内采集映射预览；无 Agent 来源、原始字段/单位、转换及稳定身份；切换选项只更新本地样例。
- [x] 监控项编辑从已注册指标选择，自动生成名称/标识/单位，缺能力不可加入；不执行 SQL/SSH/SNMP。
- [x] 事件详情保留事件时规则快照和跳转模板入口；通知投递只展示记录职责。保留 AI 工作空间和资源概览主线。
- [x] 原型固定浅色，不新增手机/平板适配；既有未触达样式保留；保留桌面表格局部滚动及基本键盘语义。

## 4. 验证与交付（依赖：3）
- [x] 原型 tsc noEmit、Vite build 通过；结构化检查文档与源文件旧范围残留。
- [x] 浏览器检查模板选择/复制、指标选择及加入草稿、三类采集映射、草稿不可用、事件四标签/快照/模板回链、通知记录、AI/概览回归。
- [x] 在 1440×900、1366×768、1920×1080 的关键变更页面检查主要操作和页面溢出；不运行手机、平板、深色或屏幕阅读器专项。
- [x] 保存 screenshots-v4、真实交互证据、当前源码摘要；更新 README/GALLERY/VALIDATION、OVERVIEW 及浏览器方案。未变化的 V3 结果仅明确引用，不冒充本版重测。

停止条件：本轮方案和原型可审阅、所触达交互验证完成。生产实现、完整业务 E2E、真实采集/模型调用/执行不在本轮。
