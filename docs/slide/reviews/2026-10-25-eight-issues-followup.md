# 八项反馈处置记录（代码修复 + 待决项）

日期：2026-10-25。依据：`2026-10-25-eight-issues-verification.md`。
分支：`codex/max-222-eight-issues`（基于 main `2ca3c47c5`）。

## 处置状态

| # | 问题 | 本次处置 | 提交 |
| --- | --- | --- | --- |
| 3 | Provider 更新 500，但数据库已改 | **已修**：初始化改为临时集合、成功后整体切换；坏 Provider 隔离（不影响其他客户端）；失败重载保留旧客户端；PUT 返回 `applied:false` + `reloadError`，不再用 500 掩盖已持久化 | `1c50eafb9` |
| 4 | 摘要不接受 JSON 代码围栏 | **已修**：`unfenceJson` / `parseSummaryJson` 统一用于 validateSummary、summaryRejection、acknowledgeSummary、执行器证据校验；最终分析也复用同一实现。仅接受裸 JSON 或单个完整围栏 | `5040e7f43` |
| 1 | attempt 不保存 evidenceCode | **已修**：契约新增可选 `evidence_code`，runner 在错误时持久化生产者原因码；历史记录兼容（可选字段） | `a1e9f5b16` |
| 2 | InnoDB 死锁指标导致每轮 partial | **已修**：MySQL status 读取中服务端未返回的声明变量落成 null 观测 + `capability: unknown`，不再产生 parse_error / partial | `a1e9f5b16` |
| 8 | 部署配置漂移 | **部分修复**：新增 `deploy/compose.investigation.example.yaml` 与文档，说明变量必须在 compose 中映射、空值被拒绝、示例值非最小证明、密钥不入库。Provider 仍按既有架构由数据库管理，需配套备份/脱敏清单流程 | `129fef207` |
| 5 | 默认调查配置跑不通 | **部分处理**：`CONTEXT_UNRECOVERABLE` 现在带投影值与可用预算（`x > y`），可直接判断是工具批次过大还是窗口过小。默认窗口/预算的目标值与上下文构成测量尚未完成，见下 | `2368ea3f6` |
| 6 | 遗留迁移未完成 | **已给出处置决定**（见下）；旧定义保持 blocked，新指标与告警阈值需按决定逐项上线 | 本次文档 |
| 7 | inode 9/11 | **已实现**：`df -i` 的 `-` 行标记 `inodeSupported:false`，观测质量记为 `unknown/not_applicable`，与 source_error 区分 | 本分支 |

## #5 待完成的工作（目标：默认配置能完成代表性调查）

已确认事实：
- `ops-context-regression` 明确记录：当前完整分析提示在 16k 被拒绝；六个可读观测在 32k 通过。
- 部署栈 65,536 窗口 + 8,192 输出仍在 16 条工具记录后 `CONTEXT_UNRECOVERABLE`；294,912 完成。
- 结论不能写成“所有调查都必须 294,912”，也不能只靠加大窗口。

建议的下一步（逐项验收）：
1. 在 32k / 65k / 128k 分别记录 system+policy、工具 schema、最近不可拆工具批次、历史摘要、最终结果的 token 占比（使用现有估算器，不调用模型）。
2. 按占比优先缩减工具 schema 与单次工具结果体积（分页/裁剪），再决定默认窗口。
3. 默认值需满足：窗口 ≤ Provider 声明能力、窗口 ≤ 累计预算、摘要输出 ≤ Provider 最大输出。
4. 用一次真实代表性调查验收；旧执行恢复继续使用持久化 allocation。

## #6 迁移逐项处置（已定，按此上线）

| 旧项 | 现状 | 处置决定 |
| --- | --- | --- |
| `qps`（`(Queries_current-Queries_previous)/elapsed`） | 底层计数已具备可信代次（`mysql.queries.total`） | **不再迁移旧表达式**。QPS 的唯一语义 = 派生指标 `mysql.queries.per_second`（带代次）；旧 `qps` 名称与阈值继续 blocked，新阈值按真实基线重定后走 preview/trial/activate |
| `disk_usage`（数据库分配估算/固定 10 GiB） | 把估算分配字节当百分比 | **拆成两个明确指标**：库大小 = `mysql.tables.estimated_allocated_bytes`（By，estimated）/ PG `postgresql.database.disk_bytes`；文件系统使用率 = `linux.filesystem.used_ratio`（server 维度，exact）。旧 80/90/95 只保留给文件系统使用率，不平移到库大小 |
| 告警宏 `qps 3000/8000/15000`、`disk 80/90/95` | 仍指向旧名与旧阈值 | 按上面两个新指标新建规则：QPS 阈值按真实基线重定；文件系统保留 80/90/95 但改为 `linux.filesystem.used_ratio`；库大小用绝对值阈值。旧规则先禁用再删除，保留审计 |

保持 `CUSTOM_EXPRESSION_REVIEW_REQUIRED` 是当前的正确状态；不能靠改状态码或直接更新库冒充完成。

## #7 inode 适用性（已实现）

`/sys/firmware/efi/efivars`（efivarfs）与 `/boot/efi`（vfat）的 `df -Pi` 返回 Inodes=0、IUse%=-，
观测保留 null 是正确的。实现：
- `parseDfInodes` 之外新增 `parseDfInodeGaps`，识别 `-` 行并标记 `inodeSupported:false`；
- 文件系统诊断采集器对这类行输出 `field_evidence.inode_usage = { quality: { status:'unknown', reason:'not_applicable' } }`；
- 质量原因枚举新增 `not_applicable`，与 `source_error` 区分；不填 0、不强求 11/11。
消费端可据此展示“9 项适用有数据、2 项不适用”。
