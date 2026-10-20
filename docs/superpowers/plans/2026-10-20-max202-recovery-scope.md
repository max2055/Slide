# P09 集中恢复边界

沿 PR214@2145c10c，base af2637a0；保留 R1 与旧路由。目标为 B15 页面和受控真实服务验收，正式执行/验证公开契约及 server/worker 归 P11。不调用产品模型，不触及共享 3308 或旧卷。

直接依赖因果：
- `operations/ui-integration.ts`：分页计划发现、服务端可信草案、人工案例绑定；最小注册 composition/public-api 与生成契约。
- `actions/plan-service.ts`：在原事务中授权发现与创建来源，复用原 PlanSources/once/版本语义。
- `action-environment.ts`：可信草案必须从原受保护签名注册解析。增加只读 proposal 端口，不接执行器，不改变 validate。没有此端口只能手填 hash，违反来源要求，因此作为草案的必要直接依赖。
- `knowledge/service.ts`：人工绑定复用 existing investigation_case_dependencies，并在同一事务锁定目标调查/准确结果/实时 ACL、写 outbox 审计。参考仍与事实/执行授权隔离，无新迁移。
- 浏览器客户端知识 Watch：仓库有 KnowledgeWatchService 域端口，但搜索未发现正式 WS 服务或 DirectGateway 的 case watch 协议装配。不得把此缺口描述为已存在运输；客户端仅消费真实订阅事件，在受控服务验证，本次注册认证NDJSON只读流消费该域端口，覆盖实际撤权/撤回/过期；正式共享WS装配如需统一运输则由P11处理。

验收：领域 focused（撤权/版本/分页/来源拒绝）→前端模块与完整回归→真实浏览器与截图/自动 a11y→准确 head CI/Chief 审查。unknown 写仅只读核对，不重发。编码遥测不可用；产品模型调用 0，canonical 账本不重置。

- `contracts/public-api.test.ts`：新增公开路径使既有穷举路径快照变化，必须机械同步，不改变其他契约测试语义。
- 目标调查session→investigation串行锁直接保证人工引用20条上限；真实并发MySQL测试覆盖不同案例争抢第20位。
