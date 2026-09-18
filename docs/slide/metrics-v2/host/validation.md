## MAX-72 验收报告

日期：2026-09-18。分支：`agent/13sol-high/max-72`；基线包含 MAX-68 `8098533` 与 MAX-70 `eea42aa`。最终 commit/PR 链接由任务交付评论提供。

### 验收对应

| 验收 | 实现/证据 |
| --- | --- |
| CPU/内存 gauge 与磁盘/网卡 counter 进入统一链路 | `builtins.ts` 的 `linux-host@1.0.0`、`adapters.ts`、`host.test.ts` |
| Canonical/Extension 同一 Normalized Observation | `runPackage/normalize` 输出及 schema/来源/版本断言；文件系统 ratio 走 `executeDerived` |
| 网卡累计字节显式 Counter，保留 interface/device | 定义为 cumulative uint64；fixture 使用 `9007199254740993` 验证无 float 精度损失 |
| 不盲目整机求和 | 所有网络/块设备定义 `space=['none']`；过滤分区/内存/loop 设备；bond/虚拟接口按独立序列保留 |
| 重启/设备重现基线 | boot + interface/device epoch 写入 CounterEvidence；公共查询对 reboot 与同名重现返回 unknown/null |
| 错误为缺失而非零 | diskstats 权限失败时 block observations 缺失/Capability unknown，其他 3 个 collector 成功 |
| Host 不归因单个 DB | resource_type 固定 `server`；CPU/memory 定义与文档明确 Host 实测，不映射 DB heuristic |
| 不新增任意 Shell | 严格包 schema 继续拒绝 selection command；适配器只按 implementation ID 调用固定 Provider 命令 |
| 设备增删/改名、部分输出与开销 | `fixtures.json` 三个快照；eth1/nvme 新增与删除、eth0 同名重现、非法 veth 行、4 invocation/7 fixed commands 断言 |

### 验证结果

从仓库根目录运行：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter slide-api exec vitest run src/metrics-v2/packages src/metrics-v2/processor.test.ts src/metrics-v2/query.test.ts src/metrics-v2/state.test.ts src/contracts/metrics-v2 src/server-metric-provider.test.ts src/server-collector-filesystem.test.ts tests/phase-94-docs-structure.test.ts` | 9 文件、232 项通过 |
| `pnpm --filter slide-api exec vitest run src/metrics-v2 src/contracts/metrics-v2 tests/phase-94-docs-structure.test.ts` | 10 文件通过、4 跳过；240 项通过、40 项隔离 MySQL 跳过 |
| `METRICS_V2_TEST_MYSQL_PORT=33306 pnpm --filter slide-api exec vitest run src/metrics-v2/storage.mysql.test.ts src/metrics-v2/query.mysql.test.ts src/metrics-v2/policy/store.mysql.test.ts src/metrics-v2/scheduler/scheduler.mysql.test.ts` | 一次性 MySQL 8.4.11：39/40 通过；MAX-69 migration rerun 在并行冷启动时超过默认 5s |
| `METRICS_V2_TEST_MYSQL_PORT=33306 pnpm --filter slide-api exec vitest run src/metrics-v2/policy/store.mysql.test.ts -t 'full migration succeeds and rerun preserves ledger and legacy data'` | 未放宽超时，1/1 通过（2.58s）；确认前项是并发冷启动时序，不是断言失败 |
| `pnpm --filter slide-api exec tsx src/metrics-v2/packages/export.ts --check` | 包 schema、发行物快照与 digest 一致 |
| `pnpm --filter slide-api typecheck` | 通过 |
| `pnpm --filter slide-api test` | 271 文件通过、9 跳过；2502 项通过、96 跳过 |
| `git diff --check` | 通过 |

环境与开销：宿主为 Darwin 27.0.0 arm64，不能作为 Linux 主机；隔离 MySQL 为 Docker MySQL 8.4.11。合成包测试观测到完整样本 4 个 collector invocation、7 条固定命令，CPU/内存/文件系统/网络/块设备统一输出。全量测试约 13.92s；这些数字不是远程 Linux 网络开销。

隔离 Linux SSH → V2 MySQL 存储 →语义查询仍未通过：已增加 opt-in `host.mysql.test.ts` 作为现场验证入口，但本轮环境没有可认证的 Linux SSH 目标；一次性 Oracle Linux 容器缺少 sshd/procps，仓库安装未完成。该测试保持 skip，fixture 与 Docker exec 均未冒充现场结果。因此本项必需现场验收未满足，Issue 应保持 blocked，而非 in_review。

### 回退

代码回退删除 `linux-host` release、对应固定 adapter 分支和多维度派生选择修正，并恢复包导出快照；无新数据库 migration。旧 `server_metrics` 与旧 API 未删除，可继续运行。
