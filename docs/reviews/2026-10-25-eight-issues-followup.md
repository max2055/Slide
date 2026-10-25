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
| 6 | 遗留迁移未完成 | **未改代码**；逐项处置清单见下，需产品确认后执行 | — |
| 7 | inode 9/11 | **未改代码**；建议按“9/9 适用项有数据、2 项不适用”表达，见下 | — |

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

## #6 迁移逐项处置（待产品确认）

| 旧项 | 现状 | 建议处置 |
| --- | --- | --- |
| `qps`（`(Queries_current-Queries_previous)/elapsed`） | 底层计数已具备可信代次（`mysql.queries.total`），但旧表达式、单位、范围与告警阈值未审查 | 需重新定义：改由派生指标 + 代次计算；审查后走 preview/trial/activate |
| `disk_usage`（数据库分配估算/固定 10 GiB） | 把估算分配字节当百分比，语义与主机文件系统不同 | 需重新定义：先确认产品要“库大小 / 配额占用 / 所在文件系统占用”中的哪一个 |
| 告警宏 `qps 3000/8000/15000`、`disk 80/90/95` | 仍指向旧名与旧阈值 | 另行迁移：新指标 + 操作符/持续时间/恢复条件逐项审查，至少三个正式周期验证 |

保持 `CUSTOM_EXPRESSION_REVIEW_REQUIRED` 是当前的正确状态；不能靠改状态码或直接更新库冒充完成。

## #7 inode 适用性（建议）

`/sys/firmware/efi/efivars`（efivarfs）与 `/boot/efi`（vfat）的 `df -Pi` 返回 Inodes=0、IUse%=-，
观测保留 null 是正确的。建议在契约层区分“不适用”与“读取失败”：
- 对已确认不支持 inode 的文件系统输出 `not_applicable`（或在展示层标注“2 项不适用”），
- 不要把 null 一律显示为 unknown/source_error，也不要为凑 11/11 填 0。
