# Audit Remediation Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules. Track dependencies and acceptance evidence; delegate only bounded independent work.

**Goal:** 核实并完善 2026-09-10 审计的 12 项建议，保留到 1d011e3 的新行为，以同类根因回归验证改进。

**Architecture:** 保留 Fastify/Lit/DirectAdapter。统一 Provider 配置和任务终态；从现有独立 registerRoutes 模式提取触达接口；共享弹窗修复后迁移 alerts。禁止全仓重写和按静态候选批量删除。

**Tech Stack:** TypeScript, Fastify, Lit, Vitest, Playwright, pnpm.

## 执行契约 v1

- 基线：main@1d011e3；原有未提交技能、AGENTS、评估和临时文件保持原样。
- 范围：R01–R12 当前仍成立的具体缺陷；同根因调用链；保留历史迁移兼容及近期 unknown/采集质量/总览行为。
- 排除：部署、外部同步、真实业务数据变更、无关优化；宽泛架构建议以触达域渐进实现，不全仓重构。
- 验收：各项有已修复/新版本已替代/有证据保留记录；故障/取消/竞争/焦点回归通过；四模块类型与测试、前端构建、契约/安全静态检查、相关浏览器行为和脚本检查。
- 硬预算：未设定；raw/cached/output/费用遥测不可用。子代理 3，最大深度 1，并发峰值最多 4；禁止继续派生。
- 停止条件：实现和必要验证闭环，记录环境阻塞与剩余持续治理边界，不把计划或进度当作新增批准。

## 1. Provider 配置（R01，R02 的 LLM 读取）

文件：apps/db-ops-api/src/adapter/get-agent-engine.ts、adapter/llm-provider.ts、llm-service.ts、llm-database-service.ts、llm/ 下配置 helper 及定向测试。

1. 对照当前配置测试无密钥本地模型、Anthropic 代理、禁用及读取失败。
2. 显式传递配置；禁止写 process.env 和自动复活禁用配置；保持未配置时平台可启动且调用报明确错误。
3. 同步配置测试与生产客户端语义。执行对应 Vitest 与 API typecheck。

## 2. 分析终态与 timer（R03、R05、R10）

文件：apps/db-ops-api/src/ai-agent-bridge.ts、ai-analysis-database-service.ts、adapter/direct-adapter.ts、adapter/types.ts；packages/agent-core/src/runner.ts 及关联测试。

1. 测试完成/超时交错、失败后晚到完成、重复终态、Promise 断链、timer 清理和取消传递。
2. 执行层拥有 deadline/cancellation，轮询只观察，数据库写入限制合法前态。
3. 删除与 schema invariant 冲突的缺列重试，保留在用 completeAnalysis API。
4. focused tests 通过后报告与近期 resource diagnosis 的兼容性。

## 3. 共享弹窗和 alerts（R06、R07）

文件：frontend/src/app/ui/components/app-dialog.ts、views/alerts.ts、对应组件/页面测试及 frontend/e2e/audit-dialog.spec.ts。

1. 复现 Shadow DOM 聚焦错误；覆盖 slot、Tab 环绕、Escape、关闭恢复和嵌套弹窗。
2. 修好共享弹窗后迁移 alerts 三个手写弹窗和对应表单布局，保留保存业务语义。
3. 运行组件/alerts 定向测试；浏览器验证深浅主题和窄屏键盘行为。

## 4. 错误语义与可测试路由（R02、R08、R09）

文件：apps/db-ops-api/src/instance-database-service.ts、server.ts、新 instance-list-routes.ts 与测试。

1. 成功空数据和读取错误分别测试；只收紧相关读取方法并核对调用者。
2. 提取实例列表路由依赖注入；保持响应 schema、权限过滤和新状态字段；inject 验证 401/403/200/5xx。
3. 不把根 tsconfig 的 strict 强制应用全仓，也不改变其它接口成功 envelope。

## 5. 确认死代码（R04）

文件：apps/db-ops-api/src/alert-rca-service.ts；frontend/src/app/ui/app-polling.ts、app-render-usage-tab.ts、styles.css、styles/dreams.css；frontend/package.json、pnpm-lock.yaml。

1. 再次确认生产/测试/动态引用；移除旧 RCA 私有执行链及独占 helper/import。
2. 删除确认无入口占位与 dreams 样式；候选依赖必须验证 pnpm why 与导入关系。
3. 保留被新代码或外部入口使用的候选；记录未删除原因，验证前端 build。

## 6. 工程门禁（R09、R11、R12）

文件：.github/workflows/ci.yml、scripts/release/build-artifact.sh、scripts/qualification/ 下 smoke wrapper、package.json、apps/db-ops-api/package.json、锁文件、.gitignore。

1. 添加 sandbox 类型/测试、相关浏览器门禁，确保 release depends on 验证作业；已有 API 全量测试不重复运行安全子集。
2. 构建前核验相关工作区源码/配置与 HEAD 一致，不清理用户工作区；测试 dirty 拒绝且 clean 可继续。
3. smoke 保留主进程非零退出码；formatter 显式依赖；确认 pnpm 部署入口后清理重复 npm 锁和跟踪的运行结果。

## 7. 集成验收

1. 合并各模块结果并核对所有权和同类问题；运行全模块测试/typecheck 一次，以及契约、lint、前端 build、定向浏览器测试。
2. 对失败分类，本次/相关问题修复并重跑受影响检查；环境或无关问题记录证据。
3. 更新本文件及 remediation 结果表，明确实际运行结果与未执行项。不自动提交或发布。

## 执行记录（2026-09-13）

- 3 个委派均因 429 失败且未产生修改，改由主线程完成，不继续重试委派。
- v1 的具体修复已实施；R07/R08 的全仓治理维持渐进范围，不扩大为全面重写。
- 范围 v2：新增登录资格门禁确认启动偏好同步覆盖用户新输入，直接阻塞验收；修复晚返回旧快照，仅在未发生设置修改时应用，并加入延迟响应测试。
- 最终结果及完整限制记录在 docs/slide/reviews/2026-09-13-audit-remediation.md。保留完整 API gate 的既有文档目录失败，不以选择性测试冒充全量通过。
- 硬预算及遥测口径不变；未提交、未部署、未改动业务数据库。隔离测试使用单独 MySQL 容器，发生过 OOM/启动超时，按真实结果记录。

- 最终真实 qualification 4/4 通过；启动期限调为 180 秒以容纳完整 migrations。合并同资源 viewer 测试的重复身份准备，保持生产限流不变。测试容器及卷已清理。
