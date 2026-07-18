---
phase: 132-security-boundaries
status: planned
priority: P0
depends_on: []
plans: 2
source: Phase 131 system-level audit
---

# Phase 132：安全边界与统一身份上下文

## 目标

建立 REST、JWT refresh、DirectAdapter WebSocket、Chat 数据和 Agent 工具共用的身份与策略边界，消除“路径不同、授权语义不同”的状态。所有敏感响应、浏览器渲染和出站网络请求采用默认拒绝原则。

## 覆盖发现

- CR-01：Agent 工具授权和审批策略丢失
- CR-02：Chat 会话跨用户 IDOR
- HI-03：REST、refresh、WS 撤销语义不一致
- HI-04：AI 分析存储型 XSS
- HI-11：通知配置泄密与 SSRF（投递 worker 闭环留到 Phase 137）
- HI-13：凭据响应、fallback secret 和固定初始化账户
- TG-02：缺少多主体对抗性授权测试

## 锁定决策

1. 定义唯一 `ActorContext`：`userId`、`username`、`roles`、`permissions`、`sessionVersion`、`instanceScopes`、`requestId`。REST、WS 和工具执行都必须显式携带，禁止从全局变量或默认用户推断。
2. 认证数据库不可用、用户不存在或状态非 active 时一律 fail-closed。refresh 与 WS 认证必须加载当前用户和 session version。
3. Chat 会话的 owner/share 关系是服务端事实；列表、历史、watch、PATCH、DELETE 和消息追加都通过同一个授权函数。
4. `AnyAgentTool` 的 `ownerOnly`、`group`、`requiresApproval`、`dangerLevel` 和 scope 不得在转为 agent-core `Tool` 时丢失。每次调用先产出 `PolicyDecision`，再执行 handler。
5. secret 字段只写不读；API 只返回 `hasCredential`、`credentialVersion` 等公开 DTO。缺少生产 secret 时启动失败。
6. 结构化 AI 数据使用 Lit 数据绑定；Markdown 使用允许列表 sanitizer。任何 LLM/工具结果都按不可信输入处理。
7. 通知目标采用逐跳重验的出站策略；DNS 失败、私网地址、重定向到未授权地址均拒绝。

## 非目标

- 不在本 Phase 实现通知 outbox worker，交由 Phase 137。
- 不实现 SQL 审批状态机，交由 Phase 133。
- 不重写 JWT、Fastify 或 Agent Core；只统一契约和边界。
- 不增加新的登录方式或多租户组织模型。

## 用户故事

1. 用户停用后，现有 REST token、refresh token 和 WS 会话均不能继续访问。
2. 普通用户不能列出、读取、修改、订阅或删除其他用户的 Chat 会话。
3. Agent 工具只能访问当前用户有权限的实例；危险工具需要相应角色和审批决策。
4. 实例、服务器和通知渠道 API 不返回密文、私钥、webhook secret 或可恢复凭据。
5. 恶意 AI 输出和恶意 webhook URL 不会在管理员浏览器或后端网络边界执行攻击。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 132-01 | 1 | ActorContext、统一 token 校验、Chat 所有权、Agent Tool Policy |
| 132-02 | 1 | secret 启动门禁、公开 DTO、XSS 防护、通知出站策略 |

## Phase 退出门禁

- 双用户 REST + WS + Chat 集成测试证明会话隔离。
- 停用用户不能 refresh，既有 WS 在重验后断开。
- 危险工具在 viewer/DBA/admin/无实例权限矩阵中得到确定结果。
- API/日志快照扫描不包含凭据材料。
- XSS payload 浏览器测试和 SSRF 重定向/DNS rebinding 测试通过。
- 132 范围测试、后端 typecheck 和前端安全相关测试为零失败。
