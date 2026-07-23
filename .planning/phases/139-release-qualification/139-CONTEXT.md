---
phase: 139-release-qualification
status: planned
priority: final-gate
depends_on:
  - 132-security-boundaries
  - 133-operation-sql-safety
  - 134-deterministic-schema-bootstrap
  - 135-agent-ws-contracts
  - 136-resource-observability-truth
  - 137-durable-incident-closure
  - 138-capability-config-contracts
plans: 3
source: Phase 131 verification
---

# Phase 139：生产发布资格验证

## 目标

不再增加业务功能，只通过可复现环境、自动化安全回归、完整用户路径、故障恢复和发布证据判断 Slide 是否具备生产使用条件。任何 Critical/High 阻断或必需 job 失败都维持 NO-GO。

## 覆盖发现

- TG-01：后端 typecheck、前后端测试、Agent Core 测试基线失败
- TG-02：缺少多用户、危险工具和并发审批测试
- TG-03：schema validator 范围不足
- TG-04：浏览器 E2E 静默跳过和弱断言
- TG-05：兼容性 UAT 未完成
- TG-06：源码正则/陈旧 mock 掩盖行为
- Phase 131 全部 Critical/High/Medium 修复的最终复验

## 锁定决策

1. Release gate 只接受当前 commit 在全新、隔离环境中生成的证据；历史 Phase 的 passed 标签不能替代。
2. 必需流水线为：lint、后端/前端/Agent typecheck、单元/集成测试、空库迁移、API smoke、Playwright 用户路径、安全回归、备份恢复。
3. 不允许必需测试 skip、console-only 断言或“页面加载即通过”。每个关键用户故事验证 UI、API、持久化、反馈、刷新和失败恢复。
4. 固定测试 fixture 包含 admin/DBA/viewer/disabled user、多实例、服务器、告警、RCA、审批、报表、通知和失败 provider。
5. 发布证据记录 commit、schema version、Node/pnpm/MySQL 版本、测试计数、环境和时间。
6. 生产结论只有 GO/NO-GO；风险接受必须有负责人、到期时间和不影响安全边界的理由。Critical/High 不可豁免。

## 非目标

- 不在验证 Phase 顺手修业务代码；发现问题时创建新 finding 并退回负责 Phase。
- 不用 mock-only 测试证明生产兼容性。
- 不以单个 `/api/health` 200 作为发布证据。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 139-01 | 1 | 工具链、测试基线、CI job、fixture 和覆盖追踪 |
| 139-02 | 2 | 空库/升级/重复启动/故障转移/备份恢复和负载稳定性 |
| 139-03 | 3 | 安全回归、浏览器闭环 UAT、文档一致性和 GO/NO-GO 证据包 |

## Phase 退出门禁

- Phase 131 的 3 Critical、13 High、7 Medium、1 Low 均有验证证据或明确非缺陷处置。
- 所有必需 CI job 零失败、零静默 skip。
- 空库安装、历史升级、备份恢复、重复启动和 worker 接管测试通过。
- 多主体授权、SQL 并发、XSS、SSRF、secret 脱敏、WS 撤销测试通过。
- 关键用户故事在浏览器中完成并验证持久化与恢复。
- `139-VERIFICATION.md` 明确给出 GO 或 NO-GO 及证据链接。
