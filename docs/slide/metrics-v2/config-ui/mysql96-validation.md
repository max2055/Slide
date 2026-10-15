# MAX-156：MySQL 9.6 采集绑定验证

## 交付范围

`mysql-basic@2.0.0` 是显式选择的独立不可变版本，仅适用于 MySQL 9.6，提供 `db.uptime_seconds`。既有 `mysql-basic@1.0.0`、`1.1.0` 及其他包保持原 digest 和行为，不自动升级现有绑定。

真实 MySQL 9.6.0 上执行固定只读语句：

```sql
SHOW GLOBAL STATUS WHERE Variable_name IN ('Queries', 'Uptime')
```

`Uptime` 为数据库启动后的秒数，以字符串返回；只接受 uint64 范围内的非负整数，转换为 float64 前再次限制到安全整数，避免精度损失。`Queries` 也以十进制字符串返回，但当前资产驱动不提供可信启动/重置代际证据。不能用当前时间减 Uptime 推算代际，因此新版本不发布 Queries、QPS 或容量指标。旧版带可信证据的计数器精度与派生速率路径仍有回归覆盖。

仅有 `USAGE` 权限的临时账户能完成固定状态查询；无需 PROCESS、业务表 SELECT 或管理权限。此结论只覆盖该 SQL 和本次实际 MySQL 9.6.0 环境。

## 界面和接口行为

- 只把 binding 的 `404 / POLICY_NOT_FOUND` 视为首次未绑定；资源不存在、其他 404 和权限错误保留错误状态。
- 预检 resolved 和试采结果新增 `applicability`：属性、当前值、支持范围、判定。预检和 runner 共用版本族判定，未知/未来元数据不会当作已验证。
- 版本不适用显示当前版本、支持范围及选择兼容包的建议；不允许把 unsupported 试采发布为成功。
- 目标权限不足、连接失败、超时、解析失败和无样本各有提示；试采访问阶段的已分类错误同样保留分类，不回传原始异常或凭据。
- 成功尝试但零样本不能开启发布。已验证的停用配置仍按原规则允许发布。
- 修复异步选项加载后下拉框与实际绑定版本不一致；加载移入 willUpdate，避免本组件 updated 内同步设置状态引发的 change-in-update 警告。Lit 开发模式提示仍属正常开发提示。

## 可重复的真实验证

在提供 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD` 的测试环境执行（服务端必须实际为 9.6）：

```bash
MYSQL96_TEST=true pnpm --filter slide-api exec vitest run src/metrics-v2/config/mysql96.mysql.test.ts
```

可设置 `MAX156_EVIDENCE_DIR` 输出脱敏 JSON 和 1440px/375px 截图。测试创建独立临时 schema 和随机密码的 USAGE 账户，并在 finally 清理；不会修改部署平台的绑定或开启自动采集。

验证链路为真实 MySQL SQL、真实 HTTP、真实 MySQL 策略存储和真实浏览器组件；HTTP 身份使用测试 actor，不替代部署 JWT/登录验收。资源版本来自真实 SELECT VERSION()，没有伪改版本。覆盖首次未绑定、旧版 unsupported、新版预检/试采/发布、revision 1→2、GET binding/effective、页面刷新及选中版本一致性、过期 revision 409 和只读 actor 403。正式 observations、attempts 和 schedule 均为零。

未启动采集器，应用状态如实为 `pending / applied_revision=null`，没有将其报告为已应用。部署实例 instance:1 的在线升级/发布尚未执行；MySQL Queries 生命周期能力及其他高级指标仍未开放。

## 本地验证

新增前后端回归先验证 RED，再验证 GREEN；浏览器追加断言实际复现并修复“绑定 2.0.0 却显示 1.0.0”。运行受影响模块及前后端全量测试、类型检查、前端构建/CSP、lint 和 contracts:check。最终运行数量和 Commit、PR、外部门禁状态由任务交付评论及 PR 记录，避免把尚未完成的门禁写成已通过。
