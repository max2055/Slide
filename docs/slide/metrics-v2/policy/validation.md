# MAX-69 验收记录

日期：2026-09-18。分支 `agent/15astra/max69-policy`；基线 main `6c2af2abe1509579eb438a8dcf21889dae758686`。前置 PR #79（MAX-65）与 #80（MAX-67）已通过 GitHub 状态/merge commit 核验并包含于基线。平台前置 PR 关联表为空，未把 issue done 状态作为代码依赖证据。

## 范围与结论

完成纯策略解析、单主组持久绑定、版本固定/回退覆盖保留、影响预览、资源鉴权、CAS 发布、原子审计、查询与应用状态内部集成端口。未改 Canonical/CoreProfile、包发行物或旧采集路径。无生产发布、无前端页面、无实际 worker 接入。

| 验收 | 证据 |
| --- | --- |
| 确定解析、推荐/组/资源优先、每项来源 | `src/metrics-v2/policy/resolver.test.ts` 继承矩阵及重复解析相等 |
| 三态、最小周期/超时/容量/依赖拒绝 | 同文件边界矩阵及 raw/derived 禁用验证 |
| 修改对象不改全局语义/其他资源 | 解析 registry 不变断言；API 资源隔离；真实 MySQL 独立资源 revision |
| 包升级/回退保留覆盖 | 解析与真实 MySQL 升降级、旧包能力失效 |
| 单主组、批量原子发布、预览影响 | API 与真实 MySQL 两成员验证；并发成员变化使旧预览失效 |
| 并发 revision 冲突 | 真实 MySQL 初次插入/后续更新各仅一个赢家，另一个 409 |
| 持久与审计事务 | 新 service 读取原 pin；注入 MySQL audit trigger 故障后配置/审计均回滚 |
| 资源范围权限与预览脱敏 | 三类资源 API 权限矩阵；组部分权限拒绝；密码/credential_ref/伪造能力字段拒绝且不回显 |
| Capability 依据/时间、权限不足、超时不删配置 | 解析测试；真实 MySQL timeout 保留证据和配置、过期查询 unknown |
| 来源映射及维度 | scalar MetricBinding 经冻结 validateBindings 校验；SNMP 返回发现模板，不伪造维度 |
| 发布/应用 revision 分离 | API pending/null；真实 MySQL applied→新发布 pending(旧 applied)→failed→applied，旧 revision 上报拒绝 |

以上源码路径相对 `apps/db-ops-api/`。合成输入与解析快照为本目录 `fixtures.json`，输入 schema 为 `schemas.json`，导出校验使用运行中的解析器。

## 命令与结果

均从仓库根目录运行。Node 24.18.0、pnpm 11.19.0。测试数据库为新建 `mysql:8.0` 容器，仅绑定 127.0.0.1 动态端口；测试创建进程专用数据库并在完成后删除。未读取应用 .env 或连接生产库。

```bash
pnpm install --frozen-lockfile
METRICS_V2_TEST_MYSQL_PORT=<隔离端口> pnpm --filter slide-api exec vitest run src/metrics-v2/policy
METRICS_V2_TEST_MYSQL_PORT=<隔离端口> pnpm --filter slide-api exec vitest run src/metrics-v2 src/contracts/metrics-v2 tests/phase-94-docs-structure.test.ts
METRICS_V2_TEST_MYSQL_PORT=<隔离端口> pnpm --filter slide-api test
pnpm --filter slide-api typecheck
pnpm exec oxlint apps/db-ops-api/src/metrics-v2/policy
pnpm --filter slide-api exec tsx src/metrics-v2/policy/export.ts --check
pnpm --filter slide-api exec tsx src/metrics-v2/packages/export.ts --check
pnpm contracts:check
pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts
git diff --check
```

- 本项定向：**42/42 通过**，包括 **9/9 真实 MySQL**；migration 全新链及再次执行跳过成功记录通过。
- 阶段受影响测试：**239/239 通过**；之后新增两项服务器/网络设备 API 权限测试通过，最终全量包含这两项。
- 最终后端：**270 文件通过、4 文件跳过；2503 测试通过、55 跳过**（13.30s）。本项 MySQL 测试与 MAX-65 MySQL 测试均真实执行，无必需验收跳过。
- typecheck、新模块 oxlint（0 warnings/0 errors）、schema/fixture 导出一致性、包快照、公开 API 契约检查通过。`server.ts` lint 10 条既有 warning、0 error；未修改无关代码消警。
- 文档目录门禁包含于阶段/全量测试；最终报告新增后单独重跑，结果见 PR 交付记录。
- 开发中发现的导出根路径错误已修复为 import.meta.url 相对仓库定位，最终导出与 --check 通过。

## 限制、CI 与回退

55 个跳过项是现有可选外部环境验证，不作为本项必需验收通过的证据；没有真实设备协议资格认证或 worker 调度验证。请求量是逻辑读取次数估算，不包含物理 SNMP PDU 分页/重试。配置操作用单数据库锁，适合低频管理面；大量组成员的性能优化不在本项。

本地测试通过不代表远端 CI 通过。PR 链接、交付 commit 与 CI 当时状态记录在 issue 最终评论；不自动合并。下游依赖只有 PR 合并至 main 后才满足。

回退：选择旧 pin 或审计快照，以当前 expected_revision 重新发布；保留用户覆盖，拒绝不兼容组合。应用代码回退不删除新增表、历史 migration 或 ledger，旧采集路径不变。真实 worker 应用与生产发布另行完成。

硬预算未设定；raw input/cached input/output/费用实际遥测不可用，未伪造统计；子代理 0、最大代理深度 0、活跃代理峰值 1。
