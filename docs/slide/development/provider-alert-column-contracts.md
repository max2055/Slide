# Provider 显示名与告警列契约（#300 / MAX-487）

058 是已登记 checksum 的历史迁移，不修改其文件。158 前向恢复以下定义，保留注释、字符集、排序规则和默认值；密钥列的 TEXT 扩容保留。

| 列 | 当前契约 | 历史值处理 |
|---|---|---|
| `llm_providers.display_name` | utf8mb4 / utf8mb4_unicode_ci、VARCHAR(100)、NOT NULL、无默认值 | 不截断；表单、保存服务与备份解析均按 Unicode 字符计数，最多 100；允许空字符串，更新时省略表示保持原值 |
| `alert_rules.threshold_type` | 同上字符集与排序规则、ENUM('static','dynamic')、NOT NULL、默认 static | 158 将 null 恢复为 static；其他非法历史值阻止迁移，不擅自改成 static |
| `alert_rules.silence_minutes` | INT、NOT NULL、默认 5；CHECK 禁止负数 | 158 将 null 恢复为 5；负数阻止迁移；保存服务只接受 0–2147483647 的整数，0 表示不静默 |

告警创建时省略这两项沿用默认值，更新时省略保持原值；两种写入都拒绝显式 null、未知阈值类型、负数、字符串分钟及小数。HTTP 创建入口不提前吞掉非法值。数据库 NOT NULL、ENUM 和 CHECK 约束保护直接 SQL 写入；生产连接应保持严格 SQL 模式，避免 MySQL 自身对小数和字符串的隐式转换。

仅新增末尾迁移无法保护尚未运行 058 的旧库。迁移 runner 在执行 058 时只把显示名的 50 字宽度替换为 100，仍校验原始 SQL 的 checksum；其余 SQL 保持原样。158 同时修复已经执行旧 058 的部署。曾经被其他入口截断且已提交的数据无法从本次迁移恢复，需从既有备份核对。

部署前在维护窗口检查非法历史值：

```sql
SELECT id, threshold_type, silence_minutes FROM alert_rules
WHERE (threshold_type IS NOT NULL AND BINARY threshold_type NOT IN ('static','dynamic'))
   OR silence_minutes < 0;
```

存在非法值时先依据业务含义处理并留审计，再执行迁移。若已进入 failed ledger，遵循 [迁移外部修复确认](../operations/migration-repair.md)，禁止修改 058、checksum 或直接跳过 ledger；当前没有为 158 注册自动修复校验器，不自动重试失败 DDL。MySQL DDL 不是事务回滚方案，生产执行前仍需按既有流程备份并排除并发写入。

回归入口为 `tests/provider-alert-contract-migration.test.ts`、`src/llm-display-name.test.ts`、前端配置页测试和浏览器测试。真实 MySQL 验收使用显式注入的 `MAX487_TEST_MYSQL_URL`，固定为获授权的 3308 端口，运行 `pnpm --filter slide-api exec tsx tests/provider-alert-contract.mysql.ts`；创建随机独占库，覆盖空库、pre-058 升级、原 058 错误复现、已执行 058 的恢复、重复执行及真实登录/HTTP/数据库保存，结束关闭自身服务与连接、删除自身库。默认测试收集不读取私有凭据或共享数据库。
