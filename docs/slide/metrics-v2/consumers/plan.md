# MAX-75 消费契约实施计划

> Execution: 在已授权范围内实施、验证和修复，不发布生产。

Goal：UI、Agent、告警与评分以同一窗口、定义和质量消费标准查询。
Architecture：沿用 MAX-68 SemanticQueryService，新增资源授权后的消费服务；产品 CoreProfile 独立于模板，Extension 仅来自当前绑定。保留属性边界及原始阈值单位。
Tech Stack：Fastify、TypeScript、Lit、MySQL、Vitest。

基线：main 9ec6eae；依赖 PR #81/#84/#85/#86 已合并。排除 MAX-74 配置界面、MAX-76、外部通知 exactly-once 和生产发布。硬预算未设定；实际 tokens/费用遥测不可用；子代理 0。停止条件：必要授权或契约缺失、不可恢复的环境阻塞；一般实现选择不新增批准。

1. `src/metrics-v2/consumers/service.ts`：授权在读取绑定、维度发现和数据之前；服务器固定定义/时间策略，客户端不能注入定义。Canonical 默认、绑定 Extension 显式选择、inventory 单独读取。窗口固定，返回定义、单位、质量、coverage、accuracy、freshness、sources、capability 和 attempt。未知指标明确拒绝。
2. `src/metrics-v2/consumers/routes.ts`、`server.ts`：注册实际查询/发现 API。用 Fastify inject 和确定性存储验证 API 与 Agent 结果一致；跨资源权限在读取前拒绝。
3. `src/tools/ops/query_metrics.ts`：默认标准查询，明确 Extension 发现和查询；旧 ID 经版本化映射，未知和不可比口径不伪造结果。
4. `src/metrics-v2/consumers/evaluation.ts`：告警阈值/持续/恢复/缺失独立于定义，质量不足不输出健康；评分同样只接受合格证据。旧引用迁移保留计数阈值和资源身份，输出迁移记录。
5. `frontend/src/app/ui/components/semantic-metrics.ts` 与资源列表/详情：固定 CoreProfile 核心列、Canonical 能力区、绑定 Extension 区；临时错误保留卡片并标记，权限失败不展示缓存；共享组件和 token。
6. `docs/slide/metrics-v2/consumers/`：确定性 fixture、迁移和回退说明、验证报告。定向 Vitest 覆盖 missing/stale/estimated/分母未知、模板切换、授权、来源与窗口一致性；阶段运行受影响测试；最终 typecheck、文档门禁、契约校验、构建。

备选：逐端改写会重复语义；直接重写旧 API 会破坏兼容。选择共享消费边界，兼容引用显式记录，不静默 fallback 到旧值。
