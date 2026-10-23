# 冻结任务执行分配（未激活候选）

现有 PR 候选基线为 `33b9eb081fac24de1eaf2ae2bb25d85916d63c5f`。本候选对应 MAX-222 最新交接 `NEXT-FROZEN-ALLOCATION.md`（附件 `01a168f3-d90e-77dd-ad81-4e6c58b82f56`），仅支持本地、零产品调用的隔离验证；不是已激活的产品配置或业务验收。

## 合同与信任边界

`execution-allocation.ts` 定义一个内部注入的、版本固定的 `MAX-222/offline-v1` 合同：36 工具、8 次共享 Provider 尝试、294912 上下文、1200000 累计 token、8192 普通输出、10240 摘要输出、120 秒。它只接受 `qualification.max222.*` 独占域及自动/总日额度均为 1200000 的策略。没有环境变量、HTTP 或 workflow payload 开关；原环境额度加载器与账本构造器的 1000000 上限保持。默认 profile、权限及工具 allowlist 不变。

HTTP bridge 接受新请求时冻结 request/investigation、profile hash、域、手动/自动通道、策略 hash 和配置，采用键序无关 SHA256。ledger 验证冻结身份与实际请求/域策略，只有该配置允许预留 1200000；receipt 保存同一分配 hash。executor 绑定 run ID，在 SDK 意图和工具执行前核对请求/receipt/run；Runtime 的工具、尝试、累计额度及上下文从冻结值读取。旧请求无此字段时沿用既有行为，恢复不会从当前配置抬高历史分配或清除 unknown。

同一个候选的直接修正：流快照排序只选择所需 run 状态、时间、resolution，避免将大型 runtime checkpoint JSON 带入 filesort。排序键、关联条件与实时授权不变。联合测试在默认 MySQL 配置下复现了原先的排序内存耗尽，修正后详情和 latestResult 可回读。

## 可复验方式

从根目录使用 `pnpm@11.19.0` 安装锁定依赖，然后运行：

```sh
pnpm --filter slide-api exec vitest run src/investigations/execution-allocation.test.ts
FROZEN_ALLOCATION_MYSQL=1 pnpm --filter slide-api exec vitest run src/investigations/execution-allocation.mysql.test.ts
```

联合测试自行启动并清理独占 MySQL 8.4 容器/schema、JWT API 和无凭据回环 HTTP SDK。可选 `FROZEN_ALLOCATION_EVIDENCE_DIR` 保存去除认证头的完整 SQL、wire、响应与审计。所有 Provider 响应、usage 和未来调用选择均为合成脚本；只有平台 HTTP/Worker/SQL/SDK 路径为实际执行。

原 B18 fixture 使用 gzip 保存，解压后 SHA256 必须为 `24bd8e27ee2931a7dc377f31c6879c98aab7eafdaaa2a59f15c0673094270a6a`、1247135 字节。合成新身份不回填旧 B18；36 次读取保留完整 174 桶、真零/null/质量/单位/来源与完整 FS 维度。测试逐项将 11 组 FS 的 used/size 六桶映射至实际 wire 和 SQL evidence；4 条脚本 claim 中也包含一组 FS 的双源引用，但不宣称完整自主数值诊断已通过。

两次恢复显式模拟 workflow 完成确认丢失：只在测试库将原 job 重新置为 retry，通过新 claim/lease/fence 进入终态恢复，API/Worker 在两个不同子进程中分别启动并关闭，断言结果和 run 不变、没有新增 SDK 或工具执行。这是两个新进程的终态恢复，不是活动摘要 checkpoint 的真实续跑验收。原完成 job 的旧 lease 重用会按设计拒绝。

## 停止条件与未完成项

交付一个本地候选及直接必要修正后停止；不 push、CI、合并、部署或激活配置。真实模型调查需另行满足当前能力、可靠计量、新鲜隔离副本准入及 Chief 独占的新 run/gate/预留。本轮不新增产品账本预留或写入。

正式采集覆盖/可信启动重置与接口生命周期 producer/迁移、完整真实分析、活动摘要真实续跑、真实 deadline 收尾，以及历史 partial/失败/unknown 均未因本候选消除。自然摘要是否触发以实际联合轨迹为准，不能将脚本 GREEN 代替业务验收。
