# MAX-67 验收报告

日期：2026-09-18。任务分支：`agent/15astra/max67-packages`；基线 `bf64502`。前置 PR #76（MAX-64，merge `980d236`）、#78（MAX-66，merge `352411c`）均已合并且是该基线祖先；由 GitHub PR 状态及 `git merge-base --is-ancestor` 核实。最终提交/PR 链接由任务交付评论提供。

## 交付与验收对应

| 验收 | 实现/证据 |
| --- | --- |
| 同一不可变 CollectorPackage 承载模板 | `apps/db-ops-api/src/metrics-v2/packages/model.ts`；完整发行物摘要、同版本重写拒绝、精确 pin、缺失实现/Transform/派生依赖拒绝 |
| 升级、固定、回退且不覆盖用户配置 | `switchVersion/select`；保留 enabled/周期/max_rows/credential_ref；无自动 latest；冲突覆盖拒绝而非丢弃；包升级及回退均触发公共计数基线隔离 |
| 固定 SQL/SSH/SNMP 批量实现 | `adapters.ts`；与 MySQLProvider 共用固定查询常量，复用 ServerMetricProvider 命令/解析、SnmpClient 与标准 MIB catalog |
| 适用引擎/版本、权限、发现及推荐参数 | `builtins.ts`/`builtins.json`/`README.md`；MySQL 5.7/8.0/8.4；Linux procfs；SNMP v2/v3 标准 IF-MIB；版本/厂商 fixture |
| 公共处理器真实包级接入 | `runner.ts` 调用 normalize/executeDerived；fixture 的 9007199254740993 → 9007199254741003 经两秒窗口得到精确 rate=5，首样本无 rate，重启/升级/回退重置；不 mock 公共算术 |
| Canonical 与 Extension 同一校验 | 固定字段语义签名校验、Extension namespace/type/unit/dimensions/quality/schema 负例；Canonical 与 MAX-64 fixture 一致；不接受模板中的 Canonical/CoreProfile |
| 权限、不支持、临时超时分离 | 版本不适用不发请求；权限不足 error=permission_denied + Capability unknown/permission 依据；timeout 保留有效旧 Capability，过期/缺失保持 unknown，不写 unsupported |
| 未知厂商不访问私有 OID | Huawei/Cisco/unknown-vendor 三种 fixture 均只读标准 ifTable；非法状态/缺少代际/重复/超限整批拒绝 |
| 凭据引用与 SSH 可选指纹 | Selection 严格只接受 opaque credential_ref；命令、明文凭据字段和任意参数拒绝；读取失败不回传秘密；复用现有可选指纹函数，无全局强制策略变更 |

测试：`apps/db-ops-api/src/metrics-v2/packages/packages.test.ts`；合成 fixture：`docs/slide/metrics-v2/packages/fixtures.json`。JSON Schema 与发行物由 `export.ts` 按模块相对 URL 生成/校验。

## 实测命令与结果

从仓库根目录运行：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 成功，无 lockfile 修改 |
| `pnpm --filter slide-api exec vitest run src/metrics-v2/packages` | 66/66 通过 |
| `pnpm --filter slide-api exec vitest run src/contracts/metrics-v2 src/metrics-v2 src/collectors/__tests__/providers.test.ts src/collectors/__tests__/task2.test.ts tests/phase-94-docs-structure.test.ts` | 201 通过、12 跳过；含目录门禁 |
| `pnpm --filter slide-api test` | 266 文件通过、5 跳过；2449 测试通过、67 跳过；约 9.31s |
| `pnpm --filter slide-api typecheck` | 通过 |
| `pnpm exec oxlint apps/db-ops-api/src/metrics-v2/packages apps/db-ops-api/src/collectors/mysql-status-query.ts apps/db-ops-api/src/collectors/mysql.provider.ts` | 0 warnings / 0 errors |
| `pnpm contracts:check` | 通过，旧 API 未漂移 |
| `pnpm --filter slide-api exec tsx src/metrics-v2/packages/export.ts --check` | 通过，schema/包快照与摘要一致 |
| `git diff --cached --check` | 通过 |

首轮 56/57：类型负例实际先触发更早的语义冲突保护，修正测试期待；测试 mock 的数组返回类型补充为二元 tuple。后续新增错误分类、版本回退与拒绝路径用例后 66/66。没有掩盖生产失败或放宽目录门禁。

CI 由 PR 触发，交付时单独提供即时状态，以上本地结果不代表 CI 已通过。后续只在相关代码/配置/环境变化时重跑受影响检查。

## 边界、剩余风险与回退

- 本项是包级闭环，必需验收均有通过证据；合成 fixture 不代表真实物理设备/主机/数据库认证。全量跳过项包含需要隔离数据库的存储集成测试，本项不声明其通过。
- 未改现有调度器或持久绑定；credential_ref 的资源授权、计数器启动/重置证据和接口代际由驱动/调用方提供，读完成后的 CAS/租约/事务提交归 MAX-69/70。
- 未部署生产，未导入任意 Shell，未承诺 Zabbix 格式兼容；推荐告警/扩展图表未纳入首批范围。
- 版本回退选择旧完整 pin，保留覆盖并让公共处理器重新建立基线；代码回退撤回本项提交，无数据库迁移。PR 合并前不能视为下游 main 依赖已经满足。
- 硬预算未设定。实际 raw input、cached input、output、token 总吞吐与费用遥测不可用；未提供虚构实测或估算。子代理 0，最大代理深度 0，并发峰值 1。
