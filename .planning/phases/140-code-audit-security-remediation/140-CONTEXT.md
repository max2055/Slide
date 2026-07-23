---
phase: 140-code-audit-security-remediation
status: complete
priority: P0
depends_on: [139-release-qualification]
plans: 3
source: 2026-07-07 and 2026-07-17 external code audit reports, revalidated 2026-07-23
---

# Phase 140：代码审计安全整改

## 目标

以当前代码为事实源，关闭外部审计复核后仍存在的安全缺口，并建立后续依赖漏洞和安全边界不能静默回归的发布门禁。

## 锁定决策

1. 数据库运维平台必须能够连接授权的内网数据库。SSRF 防护采用显式 CIDR/端口策略、DNS 解析结果校验和连接目标固定，不一刀切禁止 RFC1918。
2. 新建/测试未登记目标需要管理权限；已登记实例的测试与重连必须复用实例权限和已保存目标，不能接受任意 host 覆盖。
3. 品牌配置写入只允许管理员，并记录结构化审计事件。
4. 依赖升级以当前生产调用路径和完整回归为准；High/Critical 漏洞不能仅以“当前未观察到利用”关闭。
5. 写 SQL 必须同时绑定审批记录、实例、规范化 SQL 哈希、审批状态和执行窗口。非空字符串不是审批凭证。
6. 客户端错误采用稳定 reason code；底层错误只进入脱敏日志。未捕获异常必须终止进程并由 supervisor 恢复。
7. 密钥迁移必须兼容现有密文，采用版本化 envelope 和读旧写新策略，禁止丢失已保存凭据。

## 非目标

- 不重写 Fastify、RBAC、Operation 或数据库 adapter。
- 不在证据文件中保存密码、token、API key、私钥或可恢复密文。
- 不把 MD5 SQL 指纹、通配符权限等低风险设计项混入 P0 阻断；它们在第三批作为门禁或治理项处理。

## 计划拆分

| Plan | Wave | 范围 |
|---|---:|---|
| 140-01 | 1 | 数据库出站边界、品牌越权、生产依赖 High 漏洞 |
| 140-02 | 2 | 审批凭证、错误泄露、HTTP 安全头/限流/CORS/body limit |
| 140-03 | 3 | 版本化密钥迁移、安全告警、CI 安全门禁与最终复验 |

## Phase 退出门禁

- SSRF 对环回、链路本地、元数据、保留地址、未授权 CIDR、DNS rebinding 和非法端口均 fail-closed；授权内网数据库仍可连接。
- 普通登录用户修改品牌配置返回 403，管理员修改成功且有审计记录。
- `pnpm audit --prod` 无未处置 High/Critical；任何例外必须有不可利用证据、owner 和到期日。
- 伪造/错配/过期审批凭证产生零数据库副作用。
- 客户端响应和日志扫描不含 secret、连接串或内部堆栈；HTTP 防护有行为测试。
- 旧密文可读、新密文使用认证加密、迁移可恢复；refresh replay 和安全边界拒绝产生告警。
- Phase 140 全部 targeted/full tests、typecheck、build、security gate 和运行时 UAT 通过，输出 `140-VERIFICATION.md`。
