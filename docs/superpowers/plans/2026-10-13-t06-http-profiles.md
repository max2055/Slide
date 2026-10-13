# T06 HTTP 撤权与 Profiles 设置增量

> **Execution:** 在既有授权及仓库规则内执行；不派生代理。

**Goal:** HTTP-only 撤权关闭创建/转换表单并擦除草稿，设置消费已合并的 Profile 只读事实。

**Architecture:** 复用表单控制器的 forbidden 边界，保留 operationForbidden 与未知接受重试。Profiles 使用生成契约、authFetch、共享卡片/空状态与既有 settings-shell；事实来自 GET /api/investigation-profiles，拒绝、权限事件、销毁均清除事实并使迟到响应失效。

**Tech Stack:** Lit、TypeScript、Vitest、Playwright、隔离 MySQL8.4、正式 JWT/HTTP/WS。

1. 保留托管起始 784e6ebc 与既有产品历史，正常合入 main 的 PR161。私有 .multica/用户规则/历史产物不进入 PR。
2. 修改 investigation-create.test.ts 与 e2e/investigation-workspace.spec.ts：列表无 watch 创建、Chat 转换在 SQL 撤权后收到真实404；关闭表单，草稿全清空，数据库无新调查、Session 消息不复制。运行 RED 并提交检查点。
3. 修改 investigation-create.ts：独立 controller 回调处理 forbidden，清除字段/请求并关闭；避免 dispose 回调递归，保持403操作拒绝可读与503同body/key。运行同一反例 GREEN 和相关单测。
4. 添加 investigation-profiles.ts 设置视图，修改 settings-navigation.ts/settings-shell.ts；使用 ai:view、只读版本/hash/责任/边界/model scene/prompt/skills/tools/预算上限，明确未评估工具与有效预算。无 API 编辑、模型请求或 future 页面。
5. 测试夹具注册已合并正式 Profile 路由；测试真实授权读取、同JWT SQL撤权403擦除、迟到响应、空/503/401状态、三尺寸及旧设置深链。新增spec在既有 investigation qualification 的 CI 路径执行。
6. 运行完整原18项加增量浏览器，前端单测/既有浏览器/typecheck/build、安全/contracts/matrix/scan/lint/diff。记录零skip与observationErrors；回收本次服务/schema/container。
7. 复用 PR159 正常更新当前head，核验CI实际qualification日志，停in_review交父；不自行merge。T07-C策略/用量端点未合并时明确部分交付，完整T06/P1/V1及后续stage不放行。
