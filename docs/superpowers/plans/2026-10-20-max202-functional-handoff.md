# MAX-202 P09 功能交付与 P11 接续

当前规则：functional-delivery-1。准确输入 base 为 P08 PR213 `af2637a0084a9458bdc3c36acffdc1976877838d`；沿原 PR214、分支 `codex/max202-operations-ui`，base 分支 `codex/max201-verification`。此前 `2145c10c` 是部分候选，其 CI39437387824 的14项已全部成功；该历史 CI 不替代恢复提交的检查。本文件更新为恢复后的有效功能矩阵，旧结论保留在 Git 历史及原交付附件。

## 功能与证据矩阵

| 范围 | 本候选实现与受控实际服务验收 | 证据边界 |
|---|---|---|
| 导航 | 可信知识、行动中心、调查与三类资源详情最小挂载；保留旧路由与权限守卫 | 复用已批准 R1/现有产品外壳 |
| 可信知识 | 调查整理、独立审核、中文搜索、来源质量/观测/采集时间/分页窗口；从目标调查人工核对适用条件，准确版本/hash/结果绑定；SQL持久引用及outbox审计 | 明确 synthetic 来源与身份；referenceOnly，不提供事实或行动权限 |
| 实时失效 | 已打开案例通过认证 NDJSON 读流消费 KnowledgeWatchService；撤源ACL、撤回、过期无需按刷新即清正文；断流失效，不自动重连或重发动作 | 仓库原先只有Watch领域端口，没有正式案例WS装配；本次实现实际HTTP读流，不能称已有WS广播 |
| 计划发现与可信草案 | 按调查/状态/游标分页，仅返回完整源ACL可见计划及实际执行ID；按准确planId取得审批绑定，避免依赖审批feed第一页；草案工具/策略/verifier来自服务端受保护签名注册 | 浏览器环境使用显式synthetic注册，独立签名注册拒绝伪造测试；不发送SSH |
| 版本审批 | 提交当前版本、作者/提交者不能自批、第二身份准确版本/hash审批；编辑新版本使旧批准失效 | 沿用原域权限、once和审计，不创建另一套批准机制 |
| 执行与未知 | 显式确认一次、取消排队执行、发送后unknown核对原operation、无回执保持unknown；只读刷新不enqueue | 隔离真实执行/验证域HTTP与SQL；目标adapter是synthetic，无外部目标变更 |
| 不可变报告 | 分开执行/恢复结论、报告历史、逐窗采样/缺口/固定120/60/300/10；历史仅核对，当前passed报告绑定人工关闭；重开后旧确认失效 | 合成采样与虚拟等待，未缩短生产规则；exit0不等于resolved；正式worker装配归P11 |
| 关系与基线 | 数据库/服务器/网络设备真实Lit详情→关系服务/SQL；指标与趋势→真实BaselineStore/SQL；来源和未验证关系不冒充确认，资格/静态阈值/未知分开 | 资源读取与观测adapter提供明确synthetic最小DTO/历史窗口；不宣称真实业务基线资格 |
| 调查关联 | 实际JWT认证WS运输夹具→原调查stream.snapshot领域；真实AttentionStore快照/版本；人工拆分和合并保留原因/原事实 | 运输层为受控夹具，正式DirectAdapter/server-worker组合归P11；不称已完成生产WS装配 |
| 视觉与a11y | 三宽1600/1024/390、明暗、三密度长文；共享弹窗Esc及焦点恢复；Playwright计算可见控件可访问名称、非正tabindex；报告/结案/三类资源/失效截图 | 特殊loading/empty/503/403/tombstone/写unknown使用明确HTTP拦截补充；不声称完整WCAG合规，不恢复人工听读 |

## R1设计对照

沿用已批准的信息主列＋286px侧栏，960px以下单列；案例按适用→事实→处理→反例→原记录，计划风险邻近批准/执行。技术摘要、完整回执、逐窗采样和来源标识按需展开。复用app-card/dialog/badge/empty-state、共享按钮、主题与密度token。保留产品导航rail，390px为本次两页预留其占位。

原型中的宽泛执行分类不由未知数据拼装成假统计。本候选使用实际授权分页计划、调查/状态筛选、计划版本下的实际执行ID和报告；当前窗口统计标明page/partial，深链接不依赖统一审批feed的第一页。

## 最小领域增补与安全语义

`operations/ui-integration.ts`提供三个页面直接依赖端口：GET plans、POST drafts、POST knowledge/:id/bind；composition仅最小注册它们，public-api与生成契约同步。`ActionPlanService.readIn`复用原完整源权限；签名注册proposal只读，create再次复核实时来源/版本/效期。分页游标绑定筛选与身份权限上限，隐藏计划不贡献标识或数量。

人工案例绑定复用investigation_case_dependencies；同事务按session→investigation锁顺序串行化20条上限，并记录exact版本与outbox。无迁移，不改变模型参考隔离。KnowledgeWatch读流每秒仅刷新授权读取，首帧/每帧均经原领域实时授权，失效结束流、断开清timer/unwatch；前端对象/权限epoch拒绝迟到回填。

## P11 的正式集成边界

1. 执行HTTP注册器`registerActionExecutionRoutes`已经存在，含execute/read/cancel/reconcile；验证注册器`registerActionVerificationRoutes`已有POST/GET verification及历史GET。P09直接消费原DTO并在隔离服务注册验收，纠正旧交接“无执行HTTP”的过宽描述。
2. 正式执行/verification公开契约、`server.ts`、`workflows/register-workflow-handlers.ts`及独立action worker完整组合仍归P11。本次未修改它们、未把read-only调查dispatcher接上写动作。
3. P11从P09经Chief审查的准确head接续全批跨包回归；不得仅因UI完成就宣称生产执行链可用。正式案例可沿本次认证HTTP读流；若统一到WS，须保留撤权/撤回/过期/断连及无迟到回填语义。

## 复现与证据

前端：`pnpm --filter slide-frontend test`、`typecheck`、`build`；根`pnpm lint`、`pnpm contracts:check`；API按受影响operations/knowledge/plan/composition与契约focused，最终候选API/CI gate。浏览器：`MAX202_MYSQL_PORT=<本轮隔离MySQL实际端口> MAX202_OUTPUT_DIR=<outputs产物目录> pnpm --filter slide-frontend exec playwright test --config playwright.operations.config.ts`。未设置端口时专用suite明确skip，不能把skip当验收通过。

最终准确head、CI run/jobs、计数、截图清单与SHA256记录在同轮交付评论及附件证据；每次真实push复用MAX202自身checks条件接续。所有产物归`/Users/max/Coding/40-Slide/outputs`。不merge/deploy/done，in_review交Chief。

夹具使用独立schema和真实迁移/JWT/ACL/HTTP/MySQL；关闭Vite/Fastify/WS/连接池并drop本轮schema。仅取消本schema已知未发送的测试预算reservation；无Provider/产品模型/SSH/共享3308或旧卷操作。synthetic adapter发送计数与真实目标动作区分。编码token/费用遥测不可用，产品模型调用0，canonical账本及历史unknown不重置、不重放。
