# MAX-189 后端候选与验收检查点

记录日期：2026-10-17（Asia/Shanghai）。这是候选实现的验证记录，不代表已合并、已部署或完成整体验收。

当前有效的本轮源码、真实MySQL/VM和已有SQL迁移验收见 `unified-metrics-existing-sources-2026-10-17.md`。下文为各历史head的检查点；其中VM认证失败、catalog为空等结论不覆盖后续变化，不把历史结果当作最新集成候选的gate。

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

## Chief 预审后兼容整改（2026-10-17）

以下记录接续上面的历史检查点，不将旧head的测试或CI结果写为新head已通过。实现源码提交 `6924ee5555686c3e0aa1136206c00dc0fa0c7129`；`c1c4eed3` 仅同步新增接口的固定路由测试清单，之后文档提交不改变运行源码。PR仍为 #202，分支仍为 `agent/15astra/max-189-delivery`。

- `unified-metrics-compatibility-review-2026-10-17.md` 对27项非周期诊断字段逐项给出原生来源、有效能力、错误或不兼容语义及替代定义。新增四引擎 diagnostics@1.1.0；四个1.0.0包digest逐一核对未变。能力目录现为22个包版本、123个定义，原106项引用及旧包定义保留。
- 合法审核CustomSQL通过可信部署catalog编译为不可变扩展包，复用同一授权transport、scheduler、runner、source gate和正式发布。默认catalog为空，未代替用户批准已有配置；真实测试采用隔离审核fixture。自定义模板在基线Phase130已无执行器，保留数据和实例宏，迁移接口列出逐规则审核操作；不恢复第二套周期或任意JS求值。
- GET `/api/metrics/config/resources/:type/:id/migration` 及status的可选 `legacy_configuration` 提供资源管理权限过滤、source digest、稳定阻塞码和操作步骤；不返回SQL或凭据。`reviewed`仅表示审核完成，仍需显式trial/activate、CAS和真实来源验收，不能当正式可见。公开契约和前端生成类型已同步；手写UI仍归MAX-190。
- 修复Compose及生产示例遗漏的 `METRICS_COLLECTION_*` / `METRICS_RETENTION_*` 中性变量注入；没有旧变量fallback。

### 本轮验证

- focused database/config/consumers：17文件、132测试通过；8文件、16测试按专用环境条件跳过（8.13s）。后端与前端typecheck、`pnpm contracts:check`、secret scan及deployment security检查通过。
- 本轮开发阶段完整后端曾通过381文件/3567测试；准确 `6924ee55` 完整gate随后发现1项新增migration路径未进入契约测试的固定路由清单，3566通过、1失败、563跳过（385.73s）。已在 `c1c4eed3` 同步清单，契约测试10项通过。失败保留为真实历史，不将其计作完整gate通过。
- 最终完整后端gate在准确 `c1c4eed3f074410eb0da87214d3eb9864230c309` 重跑：`METRICS_TEST_MYSQL_PORT=23389 pnpm --filter slide-api exec vitest run --maxWorkers=1 --reporter=dot`，**381文件、3567测试通过**，33文件、563测试按专用环境条件跳过，耗时386.50s，exit 0；无exclude。之后仅文档修改，运行源码与真实MySQL报告对应的 `6924ee55` 一致。
- `startup-readiness.test.ts` 完整qualification通过：实际双API与唯一engine、SIGTERM、租约过期/慢依赖、数据库失联failclosed、实际Compose变量注入。记录head为 `3dfef2d6` 加当时未提交源码；Compose源码自 `ac335063` 后未变，复用结果仅覆盖该恢复/部署范围。
- 准确 `6924ee55` 的真实MySQL9.6流程：1测试通过（45.26s），4个不同正式周期，新增诊断及审核SQL `custom.visible_schema_count` 经唯一正式API出值（精确uint64值9）。暂停attempt **75→75**；恢复后collection=succeeded、formal=available/fresh，新观测时间 **2026-10-16T18:03:10.755Z**，last_success=18:03:10.932Z，API返回新样本。目标仅只读查询；平台使用隔离schema并清理。安全JSON `real-flow-mysql.json` 明确记录完整code_head；不含凭据字段。

### 已完成旧head CI分类与剩余边界

`6161fd26` 的14项全部完成：9成功、5失败。完整分类见兼容整改记录；[原运行](https://github.com/max2055/Slide/actions/runs/38933666635)。browser为B的fixture仍导入metrics-v2；browser-qualification为fixture只写旧metrics_history却断言92.4；recovery-qualification为本PRCompose变量改名遗漏（已修且本地完整qualification通过）；release-artifact及ci-gate由前置browser失败连带拒绝，不能跳过门禁。新head的CI必须另读，不能沿用旧head的9项成功。

B/PR200 `a0dae5f8` 仅是组合候选，未审定合入；其手写前端/验收fixture由B及Chief在组合候选中验证。本PR没有恢复metrics-v2目录或旧历史读源来制造绿灯。VM认证未更新，本轮没有重复认证；真实VM停用/启用/恢复仍未验收。PG/Oracle/DM仅解析/协议fixture证据，不冒称远端实测；MySQL复制多通道也是fixture而非真实复制集验收。Chief能力兼容独立review、完整CI、合并及集成SHA业务验收均不能互相替代，保持draft/blocked。

本轮产品LLM调用0，共享预算账本未清零；无子代理。测试日志仅保留本地，不上传潜在环境敏感原始日志。
