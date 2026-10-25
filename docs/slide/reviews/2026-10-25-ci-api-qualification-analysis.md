# API 验收 22 分钟分析（#234）

日期：2026-10-25。数据来源：run 40169059214（PR #231 头 `c527789`，14/14 全绿），
job `investigation-api-qualification`。原始报告：该 run 的 artifact `investigation-api-c527789...`
中的 `api.json`（vitest JSON reporter）与 `api.log`。

## 结论

- 该 job 实测 **1126 s（18.8 分钟）**，其中 vitest 占 **1027 s（17.1 分钟）**，
  其余 99 s 为 checkout/install、两个 MySQL 容器启动、artifact 上传。
- vitest 自身也**不是并行**的（`--maxWorkers=1`）：513 个测试文件串行执行，
  文件内测试合计 10.3 分钟，**文件间空隙（worker/环境切换）6.8 分钟，占 40%**。
- 最慢的单个文件 172.8 s（`execution-recovery.mysql.test.ts`，含真实 Chromium 用例），
  最慢的单个用例 54.1 s（trigger-concurrency 的 10,000 事件并发）。
- 真正重复的准备主要是**每个测试文件自建库 + 跑迁移**（72 个文件 `CREATE DATABASE`）
  以及**每个文件之间的 worker 重置**（512 次切换，合计 339.6 s）。
- 结论：单项都不大，唯一有量级的提速是把 513 个文件拆到多个 MySQL 实例上并行
  （3 片预计 ~7 分钟/job，省 ~12 分钟）。这是独立改动，需单独验证覆盖不变；
  当前 18.8 分钟仍在 40 分钟超时内，**本次只交付分析，不做分片**（见文末决定）。

## 总体数字

| 指标 | 数值 |
| --- | --- |
| job 总时长 | 1126 s（18.8 min） |
| vitest 执行窗口 | 1027 s（17.1 min） |
| job 其他开销 | 99 s（install 4 s、Chromium 25 s、容器启动/就绪、artifact 2 s 等） |
| 测试文件 | 513 |
| 用例 | 5293（通过 5192，跳过 101） |
| 单文件测试耗时合计 | 10.3 min |
| 文件间空隙合计 | 6.8 min（512 次切换） |
| 单文件最长 | 172.8 s |
| 单用例最长 | 54.1 s |

文件间空隙分布：

| 空隙 | 次数 | 合计 |
| --- | --- | --- |
| >5 s | 17 | 112.2 s |
| 2–5 s | 30 | 121.3 s |
| <2 s | 465 | 174.8 s |

其中紧跟在 MySQL/迁移类文件之后的 160 次切换合计 170.2 s（均值 1.06 s），
其余 352 次合计 238.2 s（均值 0.68 s）。

## 最慢 10 个测试文件

| # | 耗时 | 用例数 | 文件 |
| --- | --- | --- | --- |
| 1 | 172.8 s | 138 | `src/investigations/execution-recovery.mysql.test.ts` |
| 2 | 64.1 s | 26 | `src/investigations/trigger-concurrency.mysql.test.ts` |
| 3 | 50.4 s | 11 | `src/investigations/alert-bridge-pool.test.ts` |
| 4 | 22.8 s | 45 | `src/operations/actions/adapters/restart-demo-service.test.ts` |
| 5 | 22.7 s | 27 | `src/operations/attention/attention.mysql.test.ts` |
| 6 | 17.4 s | 45 | `src/operations/actions/execution.mysql.test.ts` |
| 7 | 15.4 s | 18 | `src/operations/actions/verification.mysql.test.ts` |
| 8 | 14.0 s | 35 | `src/operations/knowledge/knowledge.mysql.test.ts` |
| 9 | 13.3 s | 1 | `src/operations/action-readiness.mysql.test.ts` |
| 10 | 12.0 s | 49 | `src/investigations/observation.mysql.test.ts` |

前 10 个文件合计 404.9 s，占文件耗时总和的 65%；它们都是真实 MySQL/真实进程用例，
属于验收本体，不建议裁剪。

## 最慢 10 个用例

| # | 耗时 | 文件 | 用例 |
| --- | --- | --- | --- |
| 1 | 54.1 s | trigger-concurrency.mysql | 10,000 个同指纹事件只产生一个 open incident（真实 MySQL 并发） |
| 2 | 34.5 s | execution-recovery.mysql | 有界队列 + 持久化采集的真实执行（含 SIGKILL/恢复链路） |
| 3 | 13.3 s | action-readiness.mysql | 实际 server（合成目标）只提交精确 source-bound 计划 |
| 4 | 10.2 s | restart-demo-service | `after_intent` 超时 fail closed（真实控制器） |
| 5 | 10.2 s | restart-demo-service | `before_receipt` 超时 fail closed |
| 6 | 7.9 s | operations-upgrade.mysql | 127 账本增量升级、重跑、保留旧行 |
| 7 | 7.3 s | server-composition.mysql | 真实 server 进程 + 租约竞争下提供 authenticated operations |
| 8 | 6.5 s | product-budget-lock | 活进程争用等待、陈旧锁 fail closed |
| 9 | 5.1 s | cron-run-upgrade.mysql | MySQL 8 升级后的 run 映射与业务证据保留 |
| 10 | 5.0 s | product-budget | 缺失/篡改历史、陈旧锁、unknown/超界的 durable budget fail closed |

均为有意的真实故障/并发/恢复验收，没有明显的“假慢”用例。

## 重复准备清单（按实际收益排序）

| 项 | 实测成本 | 可否去掉/合并 | 结论 |
| --- | --- | --- | --- |
| 每文件建库 + 迁移 | 72 个文件 `CREATE DATABASE`；MySQL 类文件后的切换均值 1.06 s，空隙合计 6.8 min | 不能简单去掉：隔离是这些用例的前提 | 保留；如并行化，每个分片仍需独立库 |
| 文件间 worker/环境重置 | 512 次切换，合计 6.8 min | 可减少：多 worker/多分片 | 唯一有量级的提速点 |
| 两个 MySQL 容器串行启动（8.4 + 9.6） | 1084 s 步骤中 vitest 窗口外约 57 s（含拉镜像、启动、就绪探测、vitest 启动） | 9.6 只有 operations 用例需要 | 可改成 services 并平行启动，收益数十秒，暂不做 |
| API job 的 Chromium 安装 | 25 s | `execution-recovery` 的 T04 用例需要真实 Chromium | 不能去掉；除非把该用例迁到已有 Chromium 的 browser-qualification |
| 每个 job 的 `pnpm install` | 4 s/job × 13 job（已有 pnpm store 缓存） | 已是最小 | 保留 |
| Playwright Chromium 安装（3 个 job） | 29 s + 25 s + 25 s | 见 #232 的缓存测量 | 最多每 job 省 25–29 s，远低于 2 分钟门槛 |

## 分片/并行估算

- 513 个文件、文件耗时合计 10.3 min，理论 3 片均衡约 5.7 min；
  叠加每片自己的容器/准备 ~1 min，约 **7 min/job**（现 18.8 min，省 ~12 min）。
- 约束：`operations` 用例需要 MySQL 9.6，其余 8.4；每个分片需要自己的实例；
  artifact 名为 `investigation-api-<sha>`，matrix 后需改唯一名并调整
  `release-artifact` 的 `needs` 与 `scripts/ci/plan.mjs` 的 `requiredJobs` 校验。
- 更轻的方案是 `--maxWorkers=2`（单个 8.4 实例、每文件独立库），预计 17.1→~9 min；
  但并发共享实例的属性未验证，需整轮全绿才能采纳。

## 决定（2026-10-25）

- **本次不分片、不改 workflow**：18.8 分钟在 40 分钟超时内，且与其余 job 并行，
  当前证据不支持为此增加 matrix/artifact/plan 的复杂度。
- 若后续 PR 反馈时延成为瓶颈，按上面估算单独开 issue 实施分片（3 片）或先试
  `--maxWorkers=2`，验收标准：整轮 14/14 全绿、覆盖清单不变、job ≤ 8 分钟。

## 更新（2026-10-25 下午，用户决定分片）

用户要求缩短 CI 时间，决定对 `investigation-api-qualification` 实施 3 分片：

- `run-investigation-rollout.sh --api` 支持 `T12_API_SHARD=<i>/<n>`，转成 vitest `--shard`；
  未设置时保持原来的单进程全量（本地/独立使用）。
- CI 该 job 改为 `matrix.shard: [1, 2, 3]`，每片各自启动独立的 MySQL 8.4 + 9.6，
  输出与 artifact 按 `api-shard-<n>` / `investigation-api-<sha>-shard-<n>` 区分。
- 预期每片 ≈（测试 10.3 min + 空隙 6.8 min）/ 3 ≈ 5.7 min，加准备约 6–7 min；
  整轮新瓶颈将变为 `browser-qualification`（近期实测 8.5–12 min）。
- 验收：三片全绿；三份 `api.json` 合计 513 个文件 / 5293 个用例（环境齐全时），
  与分片前一致；整轮时长以实测为准。
