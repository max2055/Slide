# MAX237 最终集成门禁补修

本轮基点 `279dba6033c76139ac681bfbe256381797c361d9`，沿原 PR390 和任务分支追加提交。已接受的指标语义、原生模板应用及 MySQL/VM/受控 SNMP/PG 真实业务证据复用，覆盖表见 `joint-acceptance-20261101.md`。没有生产实现、模板 release、迁移或公开契约变更。

## 四处集成缺陷

1. `database-service.formal-metrics.test.ts` 按生产兼容入口校验完整四参数调用，明确传入内部消费服务。认证 HTTP 默认消费服务保持原样；不重连、失败传播断言保留。
2. `baseline-calculator.test.ts` 改为 mock 实际使用的 `internalMetricConsumerService`，保留精确样本、不可用及不回退断言。
3. `filesystem-ratio-alert-lifecycle.mysql.test.ts` 部分 mock 保留 runtime 原始导出，包含认证消费服务，仅覆盖内部 query 和 operationalSource。使用本轮自有 MySQL 8.4，五项生命周期测试覆盖持久化触发、保持/恢复、未知不恢复、规则隔离及旧阈值回放，未 skip。
4. 按 MAX239 已接受根规则收敛结果移除重复 `CLAUDE.md`。来源 `c8c70671d68c613108867fd357861abe3402d09e`，接受证据 MAX239 评论 `01a19502-8b75-7d60-b558-6a541e6714f9`；安全头 `a1f63ceae59a86689c786747a451c63f008abd31` 同样无此文件。当前受版本控制的 AGENTS.md 与该安全头 blob 均为 `da8bf7c8ee58b12370f69fb0b6a2ff3c74bc04f3`，第 8 节完整保留四项编码规则。结构测试未放宽。运行时附加的 AGENTS.md 本地变动未提交。

受控 SNMP 已满足父项成员最新验收决定，不列物理设备阻塞。Oracle19.3/达梦8.1真实目标仍局部暂停：owner Chief/Max 提供授权目标、凭据引用和只读窗口后恢复；未猜凭据或安装许可产品。

## 验证与分类

原三项本地失败在补修前复现，日志 `before.log`。四文件补修后 25 项通过，含五项真实隔离 MySQL 生命周期，日志 `affected.log`。

仓库其他必要检查：API/前端 typecheck、前端 build/CSP、公开契约、资格覆盖矩阵 37/37、恢复审计策略 46 项、生产源码秘密扫描通过；lint 0 errors / 353 warnings。前端 155 文件 1428 项、Agent Core 41 文件 774 项通过，Sandbox 6 文件 22 项通过/1 文件 4 项环境跳过。无前端或生产模块变更，已接受浏览器与业务证据继续复用。

完整 API 613 文件：504 通过、108 条件跳过、1 失败；6247 项中 4983 通过、1263 条件/环境跳过、1 失败，耗时 245.82 秒。结果在附件 `full-api.log` / `full-api.json`，逐项跳过清单 `environment-skips.json`；未提供的其他专用真实环境不计通过，不能以定向检查替代完整 gate。新发现未触及的 WebSocket 时序失败：`src/auth/security-boundaries.test.ts` 中 `websocket serializes slow revalidation and discards its result after close`，测试设 10ms 心跳，并发负载下日志记录 heartbeat timeout / terminate 后超时。该文件与基点 SHA256 均为 `2b8766192d9c30fac54d0c591d1d18f1714185479c822bb4a3cb5ccd184f688f`；单独诊断同文件 46/46 通过（`auth-diagnostic.log`），没有修改鉴权或放宽断言。分类为无关既有时序不稳定，保留合并门禁，不把定向通过冒充完整 API 成功。

## 隔离与交付

自有容器标签 `slide.task=max237-integration-20261101`，ID `906314e816cd1637c957caf28cb7bc91ae86ce1018ea517d25e33a51effd1abb`，只绑定本地端口 57752；T08/DB 连接均指向此隔离容器。fixture 创建唯一 schema 并负责删除。未写共享 3306；未执行部署、实际解绑、产品模型调用、外部通知或子代理。附件记录最终清理、新增对象 allowlist、准确提交和推送后唯一 CI 快照；沿用原唯一终态订阅。
