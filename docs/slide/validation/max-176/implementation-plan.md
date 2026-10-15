# MAX-176 Agent 清单 R1.1 Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; track acceptance evidence. 本任务由主代理实施，不派生代理。

**Goal:** 按已批准 R1.1 将工具、会话、技能组织为可检索、稳定排序、分页的摘要清单与可追溯详情。

**Architecture:** 仅触达三个专属产品视图。先工具页接入真实服务并比对设计，再在第二处需求出现时于专属文件中复用局部清单样式和行为；不改全局 token、导航、共享组件或后端。消费现有完整清单 API；消息历史使用现有游标分页，原始字段完整保留。

**Tech Stack:** Lit 3.3、现有 app-card/app-dialog/app-data-table/app-empty-state/app-badge、pnpm 11.19.0、Vitest、Playwright、独立 Fastify/MySQL 测试环境。

## 1. 工具代表页

- 修改 `frontend/src/app/ui/views/agent-tools.ts`。工具与用途两层摘要、适用范围、读写/副作用与审批/授权必要信息常显；参数和完整原始事实进入原生焦点管理的 app-dialog。
- 名称/用途/资源/边界检索、执行边界筛选、名称稳定排序、每页 6/12/24 条；筛选重置页码，关闭详情保留检索/页码。
- 区分加载、失败、401/403、成功空态、筛选无结果。过期请求和失权后的旧数据不得回填。
- 独立服务读取实际注册工具；桌面/390/768、明暗截图与批准 tools 证据比对后，再做下两页。

## 2. 会话与技能

- 修改 `frontend/src/app/ui/views/agent-sessions.ts`：可读标题/状态/时间/消息数；无标题和 label=key 时用无 UUID 的回退名；完整 key/kind/资源原值详情可查。正确读取 timestamp 与结构化 content，历史游标分批加载至完整；关闭/切换会话后旧响应不得污染当前详情。保留已有删除能力、编码 URL。
- 修改 `frontend/src/app/ui/views/agent-skills.ts`：用途与真实启停状态摘要；路径、frontmatter、来源/digest/trusted 在详情。禁重复切换，POST 后重新读取并验证状态；失败/无权限/未知回执明确反馈，不把接口失败当成功。依权限显示操作。
- 在工具专属文件内提取局部清单模式供两页消费，避免引入无写锁的共享文件。

## 3. 验证与交付

- 新增本任务命名的 focused tests，验证全量检索/分页、完整详情、状态与竞态、长内容、消息分页、技能真实回执。
- 运行 `pnpm --filter slide-frontend typecheck`、focused Vitest/Playwright、前端全部单测、`pnpm --filter slide-frontend build`；无公开契约修改。
- 正常流必须走独立实际服务；特殊状态受控补充并标明来源。逐页记录 commit、视口、主题、真实/受控数据、设计适配与未完成项，保存 `docs/slide/validation/max-176/acceptance.md`；截图附件交付。
- 提交 `codex/max-176-agent-lists`，PR base=main、标题含 MAX-176，回读实际 PR 关联/head。最终一个结果评论后，将 30m PR checks wakeup 关联该线程并回读配置。满足任务自身验收后进入 in_review；缺必要验收时如实标注。

## 停止条件

三个页面功能、真实业务与视觉证据完整且本地 gate 通过，提交 PR 并交 Chief 审核；环境/权限实质阻塞时完成独立工作后报告最小阻塞，不伪造正常流或扩大写锁。模型调用为 0，不使用产品测试预算。
