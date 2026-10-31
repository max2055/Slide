# MAX239 开发检查点（未完成验收）

任务分支保持 `agent/15coder1/max-239`，保留起点 `6122aefb955414f84b9265183a09e5943940ac02`。本记录不是新阶段验收申请，完整用户流程仍由15coder1负责。

## 当前源码

引入已接受生产者安全头 `88fc15e2bce814218ff2f1836a33d57ff236eef6` 的85个源码、测试和迁移文件；逐路径源blob见 `producer-source-map.json`。未引入原MAX238任务风险祖先，未切换或重写任务分支。没有引入其运行快照、截图、脚本证据或环境文件。公开契约从合并后的源码重新生成，保留MAX239已有触发器契约。

新增 `metrics/triggers/persistence.ts`、迁移138和对应测试；在现有 `MysqlBindingHost.stageApplication` 的同一连接内暂存规则快照，失败回滚配置、操作与审计。已有操作的精确重放不再次暂存。生产 `TemplateBindingService.trustedInputs` 用真实candidate/live context、固定模板版本、持久化规则目录，经已有resolver/compiler生成快照，再在同一连接做最终实时权限检查。无触发器的模板不依赖新增规则表；声明了触发器但没有暂存入口时默认拒绝。

快照显式保持 `applied:false`、`effective:false`，不伪造配置已应用。

## 唯一链路核对与尚需实现

- 模板配置生产者：`templates/binding-service.ts` → 现有host → `metric_policy_bindings`。新快照跟随同一事务，config_revision明确映射为target_revision；plan_identity仍为base候选产生的resolution identity。
- 正式样本生产者：`scheduler/store.ts:writeTemplateResults` 是定时及collect-now共用的唯一正式写入口，保留真实sample IDs、attempt IDs和source_checks。不能在测试中预种事件冒充它。
- 当前严格 `templates-v1` codec 把pending和previous effective分开；其 `applied_revision <= base_revision` 约束没有放宽。正常正式写入目前不把pending改成applied。完整链路仍需设计并实现明确、严格且可回归的成功应用转换，不能用fakeapplied绕过。该工作是本任务内部实现，不是外部阻塞。
- 现有评估/事件：`alert-engine.ts` 调用数据库、服务器、网络evaluator，既有 `alertDatabaseService.createAlert(data, connection)` 支持事务连接；`alert-event-service.ts` 和 `event-aggregator.ts` 使用现有alert_events/members/logs。后续必须在这里补事务episode接线，不能复制正式writer或问题中心。
- 现有通知：`NotificationDispatchScheduler` → `workflow_jobs` 的 `notification.deliver`，幂等键 `notification:<alertId>:<channelId>`；已有投递状态和回执。复用该账本，不新建平行通知账本，不启动生产worker。
- 尚未实现：规则编辑/发布API及Lit表单、正式样本adapter、数据库episode/事件/通知原子转换、事件详情快照与当前配置分离、确认只处理状态、时钟nodata接线。

## 本次验证

- API focused：12 files / 246 tests通过（触发器、host、strict codec、binding service、metrics契约）。包括新增暂存失败整事务回滚和精确重放只暂存一次。
- 相关API模块：9 files / 258 tests通过（template service/repository/catalog、preflight/resolver/guard/adapter、capability及请求fence）。
- 前端依赖回归：4 files / 108 tests通过（原生及旧配置、配置壳、数据库编辑）。
- API和frontend typecheck通过；contracts:check通过；frontend build+CSP通过（2个production scripts）。
- 未运行真实MySQL事务集成、真实跨进程重启、Lit→Fastify→独占MySQL→正式样本→事件页面闭环、三尺寸业务截图与基本焦点验收。这些仍是完整交付的必要工作，不能以本次单测替代。
- 三类实机及真实外部通知未完成；本次没有外部通知、运维动作、共享3306写、解绑、部署或模型调用。产品模型token为0，累计预算不清零。

## 资源与发布

没有启动服务/容器、没有创建schema；无新增后台工作或资源清理句柄。初始 `AGENTS.md` 用户修改保留且不提交。PR570启动时为draft，head6122aefb9、base797ab6b47（agent/15coder1/max-238-release）。本检查点未推送、未改变PR或其base；完整新增可达commit/tree/blob安全审计与独立复核尚未完成，不能以生产者旧CI代表新代码。未新增唤醒规则；单次已消费wakeup已disabled，现有持续终态订阅未改。
