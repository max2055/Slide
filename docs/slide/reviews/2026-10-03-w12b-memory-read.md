# MAX-121 / W12b：Memory 只读快照与容量基线

## 执行契约与基线

沿用主任务 v2 / W12b，范围为 Memory 文件读取、直接涉及的锁/原子文件 helper、来源校验和回归测试。验收为重复 list/export 不写盘、不改变内容/mtime、不建写锁，作用域与共享过滤不变，坏文件明确失败，多进程写入/删除及崩溃可恢复，完成 100/1,000/10,000 条记录的耗时/内存/写次数测量。

基线 `origin/main@aa270fb013ced5ad511482a7ffea3f22501dffea`；已核对前项 MAX-110 的 PR #113 为 MERGED，主任务记录验收 passed。实施分支 `codex/max-121-memory-read`，隔离 worktree，未带入运行目录的 AGENTS.md 或其他修改。

不修改文件格式、数据库 schema、实际 .env 或用户服务；不扩跨主机支持、分区/MySQL 迁移或向量存储。完成边界为真实本地证据和指向 main 的 PR，主任务负责核验八项 CI、审查和串行合并。硬预算未设定；实际 raw input/cached input/output/费用遥测不可用，不以工具输出字数或内部预算冒充实测。子代理 0、深度 0、代理并发峰值 1。

## 变化与兼容决定

- `StructuredMemoryStore.list/export` 读取独立 JSON 快照，不调用持久化 transaction。每次 `readFile` 打开一个 inode，现有临时文件 + rename 协议保证得到完整旧版或新版。没有跨调用缓存；返回值来自新解析对象，调用者修改不能改变持久化数据或下一次读取。
- 缺文件返回空快照，不创建目录/数据库；仅 ENOENT 允许该行为，JSON 错误、版本/顶层结构错误和其他文件读取错误不初始化空库。读写复用相同的顶层 schema 校验，未引入格式升级或放宽 schema。
- workspace 必须一致；个人记录仍要求 actor/session 同时一致；显式共享仍只限同 workspace 指定 actor。读与删除/共享撤销重叠时允许已经打开的旧授权快照；完成变更后开始的新读取可见新状态。这不是跨请求的串行化权限保证。
- 写操作保留原有单主机锁、原子替换、tombstone、job/budget 规则；竞争写入仍返回 `MEMORY_STORE_BUSY`，没有新增跨进程等待/重试协议。读不回收锁、不修改锁，因此活跃/外地主机锁不会阻塞纯读，但仍阻止写入。
- 直接涉及的权限问题：旧 helper 创建 0644 临时文件，rename 后再 chmod 为 0600。现在 structured store 传入 0600，在临时文件创建时就限制权限，避免发布窗口；其他 history helper 调用保留原有默认行为。
- 沿入口检查发现 pipeline reconcile 用 transaction 获取来源 ID，即使来源未变化也调用 invalidate 写盘。该直接阻塞“重复 list 不建锁”的验收，因此加入必要调用链修复：通过 scoped list 获取来源；invalidate 先用只读快照检查 records **和 jobs**，确有来源变化才进入原事务并重新检查。来源删除/修改仍持久化 uncertain/obsolete，不重置预算。默认关闭行为不变，API/export 格式不变，生成契约无需修改。

## RED → GREEN 证据

`f592d48`：新只读测试实际执行 10 项，5 失败/5 通过。失败分别证明重复读创建写锁/重写（20 次读出现 60 次 open）、缺库读创建目录、外地主机锁阻塞读、读等待同进程写事务、临时文件 rename 前权限为 0644。

`fd569d3`：同一命令 10/10 GREEN。

`1641e26`：pipeline 未变化来源回归实际执行，失败证明个人/共享 list 仍调用 transaction 4 次。

`aea7d5dfe857505562db1427046a62f62fd5e151`：最小必要来源校验修复及多进程/容量回归，两个文件 93/93 GREEN。

```bash
pnpm --filter @slide/agent-core exec vitest run src/memory-store-read.test.ts src/__tests__/memory-pipeline.test.ts
```

新增 store 测试共 18 项，包含真实 Node 子进程与 IPC 屏障：

- 子进程持写锁时主进程读取旧完整快照；竞争写拒绝且不遗留 reclaim guard；后续另一个进程成功更新，记录和累计预算全部保留。
- 子进程连续 30 次原子更新并实际 delete；list/export 竞态中每个响应内容代际一致，无外部 actor/workspace 数据；删除后新读没有被删记录，非所有者删除失败。
- 在真实 rename 前与 rename 后、目录同步前分别 SIGKILL：状态分别保持完整旧/新数据；下一 writer 回收死 PID 锁，预算及 tombstone 保留。仅测试进程崩溃，未冒称硬件断电耐久性认证。崩溃前遗留的随机 `.tmp` 不参与读/恢复；沿用现有行为，不实施历史临时文件清理。
- 未变化来源不写盘；当前 record 来源有效而历史 job 来源过期时，仍正确持久化 job obsolete。既有来源失效、tombstone 抗重放、未知 usage 预留、legacy 恢复与权限测试继续通过。

## 容量测量

环境：2026-10-03、macOS arm64、本机临时目录、Node v24.18.0、pnpm 11.19.0、Vitest 4.1.8，frozen lockfile 安装未修改锁文件。单次测量命令：

```bash
pnpm --filter @slide/agent-core exec vitest run src/memory-store-read.test.ts -t 'capacity baseline' --disableConsoleIntercept
```

每档用真实 transaction 写入模拟合法记录，半数为调用者、半数属于另一 actor。每档连续 20 次 list；每次读取整份 JSON，返回一半记录。计时包含 readFile/parse/filter，不包含 expect；中位数取排序第 11 项，p95 取第 19 项。内存列为单次调用前后观测的最大正增量（非分配总量/真实峰值），GC 和文件缓存会影响结果，没有冷缓存或固定性能 SLA。

| 记录总数 | 文件字节 | 中位 ms | p95 ms | 最大 ms | 最大 heap 增量 B | 最大 RSS 增量 B | 写入/写锁 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 61,950 | 0.167 | 0.187 | 0.210 | 220,504 | 229,376 | 0 / 0 |
| 1,000 | 620,850 | 1.156 | 1.736 | 1.838 | 2,189,104 | 2,621,440 | 0 / 0 |
| 10,000 | 6,227,850 | 10.022 | 14.272 | 16.252 | 21,515,512 | 21,217,280 | 0 / 0 |

实测断言每档内容 hash、mtime 不变，writeFile/open/rename 均未调用；基本测试还验证 inode/0600 不变及目录无锁文件。该表为 store list 基线，不包含 canonical source 查询、完整 pipeline reconcile、LLM 或业务服务耗时。单 host、此模拟规模未提供迁移到分区/MySQL 的必要性证据，故不另立迁移或引入新存储。读取仍为整库 O(n)，大内容/大量 job/budget 或高并发的内存和延迟需单独测量，不能外推为生产容量上限。

## 最终本地集成门禁

生产代码对应 `aea7d5d`；后续仅增加本验收文档。完整 gate 统一运行一次：

| 命令 | 结果 |
| --- | --- |
| `pnpm -r typecheck` | 4 包通过 |
| `pnpm -r test` | agent-core 654 通过；API 2,914 通过/136 跳过；frontend 554 通过；sandbox-controller 22 通过/4 跳过 |
| `pnpm lint` | 0 错误，262 既有警告 |
| `pnpm build` | 成功，production CSP 通过，有既有大 chunk 提示 |
| `pnpm contracts:check` | 通过，无生成差异 |
| `pnpm qualification:matrix` | 37/37 映射通过 |
| `pnpm security:scan` | 通过 |
| `bash scripts/qualification/run-agent-runtime.sh --mode deterministic` | 通过，假 provider，无付费模型调用 |
| `git diff --check` | 通过 |

跳过的环境门控测试不算通过；未测代码覆盖率百分比（没有为本任务新增 coverage 依赖）。未运行生产状态卷或跨主机/网络文件系统测试。本地 gate 不代替 PR 八项 CI 与主任务审查，CI 状态在交付评论单独记录。

## 回滚

无迁移、无新格式。可关闭 Memory 功能并保留原状态卷，再撤回此包代码，旧 transaction 读取仍可读同一个 memory-v1.json，不丢 record/job/budget/tombstone。恢复旧代码会重新引入读取写盘和原权限窗口；不清空状态、不删除 tombstone、不回退其他任务提交。


## PR #114 CI 修复：RED 证据（续跑）

本轮仅处理父任务记录的 backend gate 失败，沿用原分支和 PR。最新 main 仍为 `aa270fb013ced5ad511482a7ffea3f22501dffea`，目标 head `244e6ab99e4463aed7de831ac9c0432383b9c949`。GitHub run `37105730313` / job `111153741938`：API 2,913 通过、136 跳过、1 失败；失败为 `discards provisional output before delivering WS terminal completed`，`complete` 期望 1 次、实际 0 次（原文件行 843）。该测试耗时 288 ms。

分类为无关既有测试时序缺陷，但直接阻塞本 PR CI，按父任务授权作最小必要修复。该测试与最新 main SHA-256 均为 `48aa86b83db1df6bc65b33325b211a2046713f0e2ec8c9880110113b44219e8b`，DirectAdapter 生产代码也没有本 PR 差异。原测试给三个预期终态都设置 100 ms 的运行期限；外层 WS timer 从 session/claim/history 准备前启动，成功场景可能被准备耗时转成 timeout。

原 focused 三场景在本机 3/3 通过，不能将一次通过当作无缺陷。可逆复现：仅在该表驱动测试的 completed 场景，将已有 `canonicalStore.getPage` mock 改为等待 `setTimeout(resolve, 150)` 后返回 `{ messages: [], nextBefore: null }`。执行以下命令，稳定产生同一断言失败，测试耗时 292 ms、1 失败；已撤回探针，未改生产超时：

```bash
pnpm --filter slide-api exec vitest run src/adapter/__tests__/direct-adapter.test.ts -t 'discards provisional output before delivering WS terminal completed'
```

环境沿用上述 macOS arm64 / Node v24.18.0 / pnpm 11.19.0 / Vitest 4.1.8。下一步在同一分支最小修正测试时序，保留所有终态、持久化和输出断言；不改 API/状态/格式/迁移，不扩大运行期限或跳过门禁。硬预算未设定，实际 token/费用遥测不可用，子代理 0。
