# 数据库日志模型外发策略

对应 GitHub #323 / MAX-425。适用于 `DatabaseLogService.triggerLogAnalysis` 的自动触发与手动分析；不改变数据库中原始日志、分析摘要的本地保存策略，不改变 Provider 选择、场景路由或认证。

## 外发边界

构建模型消息时，`message`、`raw_content`、日志级别、来源以及检测模式名称与严重程度均经过 `projectDatabaseLogForModel`。检测模式说明正文不发送。LLMService、Provider SDK 仅接收到投影后的消息，不接收这些字段的原值。

投影采用有限诊断词表，未知内容默认遮蔽，而非维护凭据键名黑名单：

- 先移除单引号、双引号、反引号及 PostgreSQL dollar quote 包裹的内容（含未闭合内容）、注释和 URL；SQL 字符串、带引号标识符及连接串不原样发送。
- 所有赋值和头字段的值默认移除，包含未知键名、大小写及分隔符变体、带空格的值。为保守处理无引号凭据，移除至该行末尾；因此该行后续诊断信息也可能丢失。值恰为五位字母数字的 `SQLSTATE` 保留；行首 PostgreSQL 风格的 ERROR、WARNING、DETAIL、HINT、CONTEXT、NOTE、FATAL、PANIC 标题保留，标题后的文本仍执行赋值移除与词表投影。
- 剩余文本只保留代码中列明的诊断词、SQL 关键字、已知检测模式、有限标点、空白，以及 `MY-` 六位数字、`ORA-` 五位数字、`SQLSTATE` 五位字母数字错误码。未知标识符、普通数字、编码值及自由文本用 `[REDACTED]` 替换。
- 完成投影后才应用长度限制：message 为 2000 字符、raw_content 为 500 字符；继续沿用最多展示前 20 条错误日志的限制。
- 提示模型不得猜测被遮蔽内容，信息不足时说明限制。投影失败沿用分析失败处理，不回退发送原文。

## 适用限制

该策略有意牺牲自由文本诊断细节。中文自由文本、表名、列名、路径、统计数值及未列入词表的诊断词会被移除；SQL 只保留部分语法骨架，不能据此还原查询。错误码目前仅保留上述三种形式，普通数字形式的 errno 会被遮蔽。增加保留项必须同时审查外发数据范围并增加回归用例，不能将任意原文直接加入提示。

这不是按业务语义识别个人信息的分类器，也不承诺消除所有推断或隐蔽信道。无敏感上下文的值若恰好等于允许的诊断词或错误码，可能保留；空白、标点、条数和错误类别也保留。日志中的已知敏感上下文（引号、URL、赋值）即使包含允许词也会整体遮蔽。对连这些有限诊断信号都不能外发的环境，需通过现有 Provider 配置选择适合的数据边界；本修复不扩展外发授权。

本地原始日志、分析结果摘要的访问控制与保留周期仍沿用现有实现；不把本修复表述为本地日志脱敏或全平台日志脱敏。

## 可重复验证

从仓库根目录使用 package.json 声明的 pnpm 版本执行：

```bash
pnpm --filter slide-api exec vitest run src/database-log-analysis-egress.test.ts src/security/database-log-egress.test.ts src/database-log-egress.integration.test.ts
pnpm --filter slide-api typecheck
pnpm --filter slide-api test
pnpm ci:source-policy
```

单元测试覆盖密码、令牌、未知键、连接串、SQL 字符串/数值/编码字面量、错误码、诊断结构、自动/手动入口、原对象不变及失败路径。本机 HTTP 集成测试经过实际场景路由、LLMService、Provider 工厂与 SDK 序列化，分别检查 OpenAI、Anthropic、Ollama 请求，以及 HTTP 400 失败记录；独立的 canary 扫描不导入投影词表。

集成测试仅启动任务独占的随机 loopback 端口，存储为替身，不读取本机凭据、不连接共享数据库、不调用外部模型。它验证实际 HTTP 请求内容，不等于真实数据库采集、生产配置或远端模型兼容性验证。请求结束后关闭监听器。
