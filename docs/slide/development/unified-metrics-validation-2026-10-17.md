# MAX-189 后端候选与验收检查点

记录日期：2026-10-17（Asia/Shanghai）。这是候选实现的验证记录，不代表已合并、已部署或完成整体验收。

## 代码与环境

- 交付分支：`agent/15astra/max-189-delivery`，从 `main/acd0e1b0` 建立；实现提交 `94a0a4de`，契约提交 `b6892635`。后续仅本记录更新时，源码证据保持适用。
- 原工作区的 `712c7f8a` 是既存本地快照，含审计文档、技能调整和旧发布包；未纳入交付分支，也未删除原工作区或用户修改。原契约 `baef0f44`、实现 `48a8af39` 与上述交付提交的对应源码一致。
- Node 24.18.0、仓库声明的 pnpm 11.19.0、Vitest 4.1.8。
- 平台迁移和持久化测试仅写本任务独立 MySQL 8.4.10 测试 schema；真实纳管对象是本机 MySQL 9.6.0（localhost:3306），只执行固定只读查询。没有迁移真实平台业务库。
- 产品 LLM 调用为 0；没有派生子代理。编码代理 token/费用实际遥测不可用，不以内部计数代替。

## 按验收对应证据

| 验收项 | 实现与证据 | 结论/限制 |
|---|---|---|
| 能力、名称、写者、读者和依赖盘点 | `unified-metrics-capabilities.md/.json`；18个包版本、原64注册项及Provider额外入口去重106引用 | 已列出映射及差异；原自定义查询、非周期旧诊断DTO、不可达窗口行为的兼容决定仍需Chief审查，不能称所有旧字段等价支持 |
| 中性名称、兼容转发和数据迁移 | `src/metrics`、`src/contracts/metrics`；121—125；`unified-metrics-migration.md` | 历史SQL001—120不变；旧API复用同handler/auth，Sunset 2026-11-15；不双写/不删除原历史数据 |
| 备份、冲突、修复、重复、并发、恢复 | `src/migrations/unified-metrics.mysql.test.ts`，1文件2测试通过；安全附件 `migration-gates.json`、`rollback-restore.json` | MySQL8.4独立schema实测；预迁移dump 309608字节，独立恢复验证lineage及账本；不是生产回退 |
| 发布到正式值完整编排 | activate/试采/CAS、唯一scheduler、同实际响应来源对照、formalization与publication fence | 新资源初始化与历史来源迁移区分；缺snapshot/错revision/错sample不能继续正式发布；同响应解析对照不称独立双源周期 |
| 有效开关、在途复核、重启恢复 | 入队、每次请求前及提交前复核；资产暂停优先；scheduler持久状态与worker重试 | 自动化故障注入通过；真实MySQL暂停/重启恢复通过；VM实测未完成 |
| 推荐/版本/权限与未知能力 | configuration registry、权限过滤策略组、MySQL9.6版本匹配与实际SQL | PG/Oracle/DM固定响应测试不是远端实测；容量或epoch无可信来源时保留unknown/unsupported |
| 五层契约 | `unified-metrics-backend-contract.md`、configuration-status类型、公开契约生成文件 | binding / effective enabled / execution / formal visibility / coverage分开；手写前端归MAX-190 |
| 本机三周期与正式API | `src/metrics/config/unified.real.test.ts`，真实流程1测试通过（44.02s）；附件 `real-flow-mysql.json` | 正常activate与历史源验真，4个不同正式publication时间；唯一API非空；暂停attempt 50→50；恢复后正式观测16:30:00.477Z→16:30:07.477Z，last_success同步推进且API返回新时间样本（均UTC） |
| VM停用/启用与真实成功 | 授权主任务凭据及Keychain检查，`vm-auth-check.json` | SSH22可达但authentication_failed；不能用fixture代替。需主任务恢复可用的既有VM认证，再运行同一真实流程（包含VM） |

恢复后本次MySQL `collection.state=succeeded`、`formal_visibility=available/fresh`；部分counter/rate仍因epoch未知而unknown。之前一次实测曾为collection failed但仍有可用正式gauge，保留为历史，不能据本次结果泛称所有collector/指标均成功。

## 检查结果与版本边界

- 最新指标模块回归：`METRICS_TEST_MYSQL_PORT=23389 pnpm --filter slide-api exec vitest run src/metrics --maxWorkers=1 --reporter=dot`，47文件/447测试通过，7文件/11测试因未配置PG、SSH等专用环境跳过（80.58s）。包含最后来源snapshot加严与故障注入。
- 最新后端typecheck、`pnpm contracts:check`、CI选择器9测试通过；干净交付分支已再次执行这些检查。
- 原工作区补充回归（排除investigations和`*.mysql.test.ts`）：340文件/3201测试通过；1项失败来自快照内已有`docs/reviews`与目录断言冲突。这是有排除项的补充验证，不是完整gate；该快照目录未进入交付分支。
- 原工作区完整gate曾出现两项本次测试接线失败，已修复并通过相关检查；另有既存文档断言失败及T09独立Docker启动超时。后续运行遇本任务测试容器OOM，被停止；这些失败/中止没有计作通过。
- 本任务容器已配置较小buffer pool并关闭其performance_schema；最新真实MySQL与指标回归成功。未停止或修改其他任务的容器/服务。
- 干净交付分支完整后端Vitest gate（无exclude）：`METRICS_TEST_MYSQL_PORT=23389 pnpm --filter slide-api exec vitest run --maxWorkers=1 --reporter=dot`，379文件/3560测试通过，33文件/563测试按各自专用环境条件跳过，耗时401.25s。命令exit 0；跳过项不能称真实业务验收通过。T08/T09自建容器场景在本次完整运行中通过，旧文档目录断言也通过。VM、Chief独立审查与合并集成不由本地测试代替。

## 安全证据与接续

安全JSON与独立测试备份保存在统一outputs目录，通过本任务最终评论附件交付；不提交密码、密钥、原始运行日志或本地`.env`。JSON中包含代码/包身份、指标值、观测时间、attempt计数及迁移断言，不含认证材料。备份只含隔离合成数据。

后续顺序：收齐本PR当前head CI → 分类处理失败 → 主任务恢复VM认证后补真实停用/启用/恢复 → Chief审查能力差异和当前head → 合并及集成SHA业务验收。未完成前保持draft，不将本检查点标为完整交付。
