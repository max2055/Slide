# MAX-73 validation — 2026-09-18

分支 `agent/15astra/max73-snmp`；基线 `eea42aaa6c97b0a208386d03e18a5fe3381a92a6`（main，已合并 MAX-68 PR #81 / MAX-70 PR #83）。原工作树及其中的 AGENTS.md 修改保持原样；实施在从该 main 创建的隔离 worktree 完成。提交与 PR 链接由本任务最终评论提供；本报告与 fixture 随同 PR 交付。

## 结果

| 验收 | 证据 |
| --- | --- |
| Counter64 无精度损失 | Buffer `0020000000000001` → `9007199254740993`；UDP Counter64 经真实 SnmpClient、Worker、MySQL 后保持同一十进制字符串；最大 uint64 和不安全 Number 回归 |
| HC 优先/32 fallback/wrap | HC 缺失可 fallback；HC malformed 不 fallback；32 位下降或容量×时间≥2^32 不产生速率；64 位超过容量上限也拒绝 |
| 重启/复用/消失/中断/缺口 | `collector.test.ts` 参数化回归 reboot/reuse/discontinuity/disappear/restart/gap/width；退休状态清理；无身份/中断/速度证据安全降级 |
| 方向/单位/分母 | 60 秒内 rx +7,500,000 By、tx +15,000,000 By → rx 1,000,000 bit/s、tx 2,000,000 bit/s；speed 1,000,000,000 bit/s 为各方向独立容量 |
| 质量/权限/unsupported/局部失败 | malformed 单字段不污染另一方向；ifX 权限失败保留健康状态；timeout/permission 后重发现；unsupported 不伪造零；取消后不继续发请求 |
| Canonical/Extension 同契约 | 既有 Canonical oper_up；标准 SNMP 与 Huawei CPU/memory Extension 经公共 normalize/derive/storage/query；目录摘要及 config/transform/package 版本可追溯；无新增私有 OID |
| 调度→存储→查询 | `snmp.mysql.test.ts`：真实 localhost UDP agent + SNMPv2c client + PolicyService + MetricScheduler + WorkerRuntime + MySQL 8.4 + SemanticQueryService；59,999ms 不采集，60,000ms 采集；worker 更换后继承公共 counter state；设备重启后速率空值 |
| 历史口径 | 原始 counter 仅支持 last，禁止缺少采集时容量/位宽边界的独立重算；历史带宽使用持久化 `*_bits_per_second`，公共查询返回单位、来源、质量与版本 |
| 兼容与安全 | 旧内置包不变；SNMP 不读写 SSH backup 状态；默认无 enterprise OID；不储存 community；新目录通过文档门禁 |

## 实际执行命令

从仓库根执行，依赖 `corepack pnpm install --frozen-lockfile` 成功，无 lockfile 变更。隔离容器 `max73-snmp-mysql` 使用 `mysql:8.4`，仅映射 `127.0.0.1:13373`；测试创建/删除独立数据库，未连接应用数据库。SNMP agent 绑定动态 localhost UDP 端口并在测试结束关闭。

```sh
corepack pnpm --filter slide-api exec vitest run src/metrics-v2/snmp/collector.test.ts
# 24/24 passed

METRICS_V2_TEST_MYSQL_PORT=13373 corepack pnpm --filter slide-api exec vitest run src/metrics-v2/snmp/snmp.mysql.test.ts
# 1/1 passed；其后在受影响测试及最终 gate 中验证最终代码

METRICS_V2_TEST_MYSQL_PORT=13373 corepack pnpm --filter slide-api exec vitest run src/metrics-v2 src/contracts/metrics-v2 src/network-devices --maxWorkers=4
# 396/396 passed，26 files

corepack pnpm --filter slide-api typecheck
corepack pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts
# typecheck passed；目录门禁 11/11 passed

corepack pnpm contracts:check
corepack pnpm qualification:matrix
corepack pnpm security:scan
# passed；37/37 findings mapped；secret scan passed

METRICS_V2_TEST_MYSQL_PORT=13373 corepack pnpm --filter slide-api exec vitest run --maxWorkers=4
# 最终完整后端：2,565 passed，55 条件 skipped；276 files passed，4 files skipped

git diff --check
# passed
```

fixture/schema 通过新包的 `PackageRegistry.install`、公共 observation validation 和上述测试实际加载验证；冻结 wire schema、既有 builtins 快照均未变化。本任务 SNMP/MySQL 验收无跳过。完整 gate 的 55 项为其他可选环境测试，未用来替代本任务必要验收；未宣称全仓库/所有环境均已验证。

## 排查与限制

- 初次 E2E 发布失败 `POLICY_SERIES_BUDGET`：每接口 15 项，原默认 100 rows 超过平台 100 series。新包默认改为 6 rows，扩大设备范围须显式提高两项预算；随后 E2E、受影响测试和完整 gate 通过。
- `NoAccess` 分类回归先复现 RED（误报 `SNMP_RESPONSE_INVALID`），最小修复后 SnmpClient 10/10 GREEN。历史 raw counter rate 绕过边界先 RED，限制定义聚合后 GREEN。其余新增功能测试在实现后补齐，未宣称全程 test-first 或测得覆盖率百分比。
- 实际覆盖为合成 fixture 和 SNMPv2c UDP 模拟器；SNMPv3 沿用现有客户端及回归测试，没有真实 v3 设备联调。无厂商实机、私有 MIB 验证、生产启用或跨消费方联调。
- 原始标准 error/discard Counter32 没有可证明的物理速率上限，因此速率为未知；原始计数仍保留。温度不兼容冻结单位契约，未映射为 Canonical 或错误单位。
- discovery 是资源级进程状态，进程重启/目标变化主动重建基线；标准 MIB 无法证明完全不可区分的物理替换。abort/fencing 不保证撤销已经在途的设备请求。
- GitHub CI 由推送触发，状态在 PR/最终评论单列；本地通过不代表 CI 已通过。不自动合并，不做生产发布。

回退：停用新包绑定/注册，保留已写观测；旧采集路径与 schema 不变。硬预算未设定；子代理 0、最大代理深度 0；raw input/cached input/output/费用遥测不可用，未填造实测值。
