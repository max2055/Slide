# MAX-70 验收记录

日期：2026-09-18。分支：`agent/15astra/max70-scheduler`；基线：`ee4485926083b6a525bfc7c440559c4f13132174`。最终代码 commit 与 PR 链接由本任务交付评论给出（本文件随同一 PR 提交）。

## 命令与实测结果

从仓库根目录运行：

```sh
pnpm --filter slide-api exec tsc --noEmit
METRICS_V2_TEST_MYSQL_PORT=33370 pnpm --filter slide-api exec vitest run src/metrics-v2 src/contracts/metrics-v2 src/workflows/worker-cancellation.test.ts src/workflows/worker-runtime.test.ts tests/collection-scheduler.test.ts tests/phase-94-docs-structure.test.ts --no-file-parallelism
pnpm --filter slide-api exec vitest run --maxWorkers=4
pnpm contracts:check
pnpm qualification:matrix
pnpm security:scan
```

- TypeScript：退出码 0。
- 受影响模块＋隔离实库＋Worker/目录 gate：16 文件、301 测试通过；19.44 秒。scheduler 为 6 项纯编译/包边界测试＋16 项隔离 MySQL/Worker 测试；fixture 由测试通过 `import.meta.url` 从仓库文档位置读取。
- 完整后端 gate：270 文件通过、8 文件跳过；2,498 测试通过、95 项跳过；15.45 秒。完整 gate 未设置实库环境变量，条件型实库测试在上一条独立命令中启用，不把 skip 当 pass。
- API 合约、资格矩阵、源码秘密扫描：全部退出码 0；资格矩阵 37/37，秘密扫描通过。

测试容器为本次新建的 `mysql:8.4`，仅映射 localhost:33370；测试数据库 `max70_<pid>`（以及各上游测试自己的隔离库）由测试创建和删除，不加载应用 .env。验证结束停止并删除本次容器。生产实例和既有数据库未改。

## 验收映射

| 项目 | 自动证据 |
| --- | --- |
| 一次共享查询多输出、不同周期互不提频 | compiler 共享实现测试；MySQL 一次逻辑读取产生 3 个标准观测；10s/120s 两资源后续请求分别为 2/1 次 |
| 依赖展开与唯一来源 | compiler 禁用依赖/错配 source 拒绝；发现维度经公共 validateBindings，两个接口具有不同 binding 身份 |
| 发布与应用 revision 不一致 | 实际 Worker 执行前为 null；v2 发布后 published=2/applied=1；新执行后 applied=2 |
| 模板/来源切换、迟到隔离 | v1 在途时发布 collector ID 变更的 v1.1.0；旧结果 0 写入，新结果保留模板/转换/配置版本 |
| 超时未收敛不重叠 | 在途 Promise 屏障；截止时间取消后第二 Worker 取回 lease 仍不能发起第二次请求，迟到输出丢弃、uncertain=1 |
| lease 与 fencing | 显式 SQL 使本测试记录过期；新 owner 领取；旧 owner 0 正式写入；释放隔离后新 owner 成功 |
| 写入截止时间 | 在存储写入屏障处触发 timeout，事务回滚，0 正式观测；已收敛请求的取消记录 uncertain=0 |
| 取消与关闭清理 | SSH 第一条读取期间取消，第二条不调用；Worker.shutdown 有界 false，收敛后 true，锁可重新获取 |
| 无效配置/权限边界 | 不合法配置 0 入队；伪造 queue job 无 schedule 所有权时 0 凭据解析；资源库存身份错配 0 请求 |
| 转换部分失败 | partial attempt 保留健康 uptime，缺失 Counter 不补零；不重试健康批次 |
| 退避/重试/重启 | 3 次失败 attempt 持久化后 dead_letter；注入时钟验证下一正常周期；重建实例保留 Counter 基线，60s 增量120输出速率2 |
| 并发/开销 | 四个 Collector 同时在途，第五个被预算槽拒绝；峰值4；每个批次逻辑读取1；注入时钟 duration=15ms（功能断言，不是性能基准） |
| 禁用 | 应用 disabled revision 不解析凭据、0 采集请求 |

## 失败分类与修复

开发阶段修复本次引入的 nullable SQL 参数、新增 migration 注释及 SSH 调用形态兼容问题。测试连接池补齐生产已有的 UTC 编码设置。

扩大测试时并行实库文件争用全局 migration named lock，MAX-69 原有单项 5s 超时；改为 `--no-file-parallelism` 后上述 301 项全部通过，未放宽门禁或修改既有测试超时。多 Worker 同时 claim 可遇公共队列已有死锁返回；并发预算测试显式按屏障领取，仍维持四请求同时在途；未修改公共 claim 行为，限制见 README。

## CI、限制和回退

本地通过不代表 CI 通过；PR 创建后记录其 head 与当时 CI 状态，不等待外部 CI 后台完成，不自动合并。后续任务须等本 PR 合并 main 才满足前置条件。

无真实目标设备或生产负载压测；使用真实隔离 MySQL 存储、真实 Worker 与测试 Collector。不宣称 SQL/SSH/SNMP 请求已被 abort 撤销，也不宣称外部 exactly-once。未接入生产循环，回退只需停止未来的 scheduler.tick/注册，保留状态和历史，详见 README。

资源：硬预算未设定；子代理0、最大深度0、代理并发峰值1。raw input、cached input、output、实际费用遥测不可用，不使用内部估计冒充实测。上述 duration 均为测试工具墙钟或明确标注的注入时钟值。
