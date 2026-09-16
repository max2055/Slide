# 场景模型分配实施计划

> **Execution:** 在 MAX-42 已授权范围内实施并验证，由主线程完成。

**Goal:** 模型配置中管理聊天、SQL 分析、故障诊断、健康检查的提供商和模型绑定。

**Architecture:** MySQL 独立场景表保存 provider_id + model，不复制凭证，不级联删除失效绑定。统一解析器读取场景绑定，未绑定使用全局默认；明确绑定失效或能力不足报配置错误。普通和流式 LLM、Agent 每次运行使用相同规则，运行中的实例不受其他场景请求影响。

**Tech Stack:** Fastify、TypeScript、MySQL、Lit、Vitest。

范围排除：新增提供商协议、真实付费模型调用、改写健康检查的规则引擎。预算未设定；实际 token/费用遥测不可用；不派生代理。

1. `sql/migrations/091_llm_scene_bindings.sql` 与 `src/llm-database-service.ts`：新增绑定表与查询/单场景原子保存/清除方法。删除提供商不删除引用。
2. `src/llm/scene-routing.ts`：共享解析、场景别名映射、启用/模型/工具/视觉/上下文校验。测试未绑定回退、同提供商多模型、失效引用、能力不足、未知场景与数据库错误。
3. `src/llm/scene-routes.ts` 与 `server.ts`：带现有认证和 llm:manage 权限的 GET/PUT，返回无敏感字段的生效配置和逐场景错误；校验无效输入。
4. `llm-service.ts`、`adapter/llm-provider-factory.ts`、`direct-adapter.ts`、`get-agent-engine.ts`、`ai-agent-bridge.ts`：按请求解析配置，Agent 使用独立 runner，业务显式传递用途；移除旧会话模型覆盖统一配置的路径。
5. `frontend/src/app/ui/views/llm-config.ts`：增加场景分配入口，复用 app-card/app-form-field；选择提供商和模型、清除绑定、生效配置、加载/保存错误显示。
6. 定向 Vitest 验证普通/流式/Agent/路由/UI，之后统一运行项目测试、类型检查与前端构建；无关既有失败记录而不扩大范围。审阅 diff、提交分支并创建 PR，回写 Issue 交付证据。

停止条件：验收完成并提交 PR；或必须依赖用户权限/外部环境的阻塞已给出可复查证据。
