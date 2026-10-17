# MAX-203 preparation-1 装配候选与受控运行提案

依据父 MAX-193 implementation-1.2 和 MAX-203 附件 p10-preparation-contract.md。
基准 main `1c3578f3d7ebace2953117be9dcffa0060a69497`；候选准确 head 以交付评论和证据清单为准。
这是待父非实现上下文独立审查的工程候选，不能合入或关闭 P10 整包。

## 已接入的运行路径

`server.ts` 在正式调查路由之后调用 `createOperationsComposition(...).register(fastify)`。
同一装配供专属 MySQL／真实监听 HTTP 测试使用，另有实际 `server.ts` 子进程验证；不是仅在测试里注册领域路由。
领域同步服务当前无需新增后台 tick：关系事实、案例来源、基线资格、关联投影均在读取／写入时实时复核。
准备阶段没有行动执行路由、执行工具或 action worker，不创建占位执行器，不消费 once，不启动新自动派发。

- P02：关系写入、修订、独立确认和图读取；复用 P06 `InvestigationRelationEvidence` 在同一事务核 investigation membership、完整 scope、证据生命周期／hash／版本／有效期；两端都必须被证据 scope 覆盖。未知证据命名空间不可确认，不按字符串引用推定事实。
- P03：候选、修订、提交、准确版本／hash 的独立真人审核发布、撤回、详情与授权后搜索。直接使用既有 `KnowledgeStore.source`，要求关闭的准确调查结果和同一 request/run 证据血缘。不同服务进程用既有持久 JWT 密钥经域分离 HMAC 派生同一 AES 游标密钥；JWT 密钥轮换会使旧游标失效。
- P04：基线只使用 `formalBaselineSource` 和正式 metrics consumer／store，不引入第二来源。无覆盖／缺历史时返回 unknown、null 数值、not_qualified；没有把合成窗口认作实际14/28天。
- P05：共享 P02 权威证据 resolver，使用已合入的 P05 原事务投影、权限过滤、计数、排序与分页；部署端已知签名注册表为空，不从文本发明签名。
- P06：注册计划 HTTP 契约及服务、正式调查／resultVersion／证据和版本引用校验。当前 main 缺 P07 的真实 `ActionEnvironment.validate(connection, content, now)`；默认明确报 `OPERATIONS_DEPENDENCY_UNAVAILABLE`，绝不使用 allow 验证器。计划功能配置应保持关闭。后续只接已审定来源，不 cherry-pick PR206。

## 迁移、安全与兼容

正式编号 `128_operations_foundation.sql`、`129_operations_permissions.sql` 由既有 `MigrationRunner`／checksum ledger／全局锁接入。
128 使用经审 P01 结构并补齐正式表／列注释；新域内部 FK 均 RESTRICT。外部调查、用户、资源、旧审批不加 CASCADE FK，源失效由 live ACL 与 tombstone 表达，避免旧域删除传播到行动历史。
129 只注册9个权限代码，不自动分配任何角色；部署授权由既有 RBAC 明确完成。持有 admin wildcard 的既有授权语义不由本候选重写。

HTTP 每次通过现有 JWT／实时主体服务，领域服务保留原 delegation ceiling 和完整 source scope。响应禁止缓存。
开关在使用点读取；preparation 无条件覆盖 dispatch=false，即使配置写 true 也不会注册执行器。
当前开关是进程内环境配置，不是跨进程控制面；外部变更须协调重启专属候选，不能把一个进程的 env 当成分布式停发保障。
公开请求 schemas／路径加入既有生成器；无 execute API。正式连接的 general_ci 与证据表 unicode_ci 混合时，JSON_TABLE 关联的证据 ID／hash 使用逐字节比较；实际 server 授权／撤权回归覆盖此差异。旧公开契约语义保持，最终执行／验证响应与客户端装配随 P07/P08/P09 后补。
未改旧 Operation、旧审批、Chat、SQL 路由或它们的所有者；完整 API gate 检查兼容行为。

## 本轮验证与边界

测试只建立本机专属 MySQL 容器和 UUID schema：完整API保留既有8.4验收，Operations另设9.6实例以验证已审正式来源；不把旧mysql-representative的8.4支持范围擅自扩大到9.6。两实例均保留performance_schema锁验收并限制缓存／内存。使用真实 MigrationRunner、JWT、监听 HTTP、实际 server 子进程。
server 子进程由测试预持有本 schema 的 `slide-singleton-workers` 租约，验证 API-only standby，禁止模型和目标 worker。
同一 JWT 授权前拒绝、显式授予后允许、撤权后拒绝；来源过期消除关系事实并追加失效版本；案例自审拒绝、不同合成测试主体审核、完整资源撤权后计数为0；停用保留历史；基线 unknown。
迁移演练先执行到127，写入旧 Operation outcome_unknown／Chat记录，再执行128/129及重入；回到旧迁移目录仍保留所有新表和旧记录。专属容器另用真实 mysqldump 导出到内存、恢复到全新 UUID schema，再核迁移 ledger／checksum、旧未知结果与 Chat记录一致；原 schema 不反向DDL、不删除历史。CI通过 OPERATIONS_TEST_MYSQL_CONTAINER 启用该恢复分支。

所有调查、证据、测试主体、审核和观测均为 synthetic。它们不计真实案例、不代表真人审核、不建立长期资格，也不是产品执行的双人批准。
真实目标操作、模型、视觉验收、1万调查／10万事件性能与最终整包gate不在本轮准备验收结论内；原 P07/P08 和最终 P09 前置保留。

## 待独立审查的受控候选运行提案（未执行）

1. **版本／隔离**：父审查准确 PR head、128/129校验和、权限与来源适配及完整必要CI。只从该 head 构建候选。继续保留 PR206/211 未合入状态，不移除 MAX203 关联规避平台完成行为。
2. **数据库与恢复点**：另建专属候选平台 schema，不能迁移现场 mysql-3306 业务库。由既有授权负责人确认备份来源、备份时间、SHA256与可恢复性；只导入已批准范围的配置和脱敏数据。首次迁移前保存完整 dump 与旧 ledger，恢复到新的专属 schema 验证；不能靠反向 DDL 或 DROP 新证据表回退。无已核验备份则只运行空隔离schema，不接现场来源。
3. **配置／端口**：候选 HTTP 仅本地独占端口（建议19103，启动前核占用）；DB_HOST/PORT/NAME明确指向候选，JWT／加密密钥经安全配置提供，不入报告。context/cases/baselines/attention 可按父审范围开启；plans=false、dispatch=false、STOP_NEW_DISPATCH=true；调查自动触发、cron、collector和通知默认不启。记录 PID→端口→cwd→命令→head→日志。
4. **租约**：现有 worker lease 名固定为 `slide-singleton-workers`，隔离依靠不同 schema，不能抢占共享DB租约。第一阶段由专属受监督 lease holder 在启动前持有并续约，实际 server 必须显示 API-only standby；检查所有 job/intent、action execution 行及网络出口保持0。D1 不自动晋升。不得凭开关关闭就启动会领取克隆历史队列的 worker。
5. **正式来源**：如下一阶段需要受控目标，由父明确重新分配192.168.49.130／mysql-3308写锁、限定资源ID和备份恢复点。mysql-3306只作既有凭据／配置来源。真实 metrics 按唯一已有 policy、publication、binding、capability、config revision/generation核验；文件系统必须按挂载点限定并已有阈值告警，不填根盘；3308只使用原owner批准的有界采集／受控案例。没有正式采集→告警→调查及准确 request/run/resultVersion/证据血缘则不注入。
6. **计划依赖**：由 P07 原owner在已审定候选上下文提供真实环境验证器及 allowlist／主机指纹／工具与配置 hash／策略和前置条件，保持准确计划与来源不变。P07未齐不让本候选自称正式执行装配完成。具体 execute 仍需两个不同真实主体对准确不可变版本作 once批准，本候选不代签。
7. **停发／回退**：先停止新派发；核 queued/prechecking/dispatching/outcome_unknown、批准消费、intent/outbox/lease/fence，未知不重放。撤新入口和 worker，优雅停止确属候选的PID，保留数据库、审计、所有版本和日志。启动旧API-only代码对保留数据库执行只读核验；恢复写入前再审 schema/operationId/目标回执。
8. **责任边界**：父非实现上下文审查后按既有授权协调下一阶段；无需额外要求Max逐包接受。P07/P12等新来源才接续，不重复盘点／恢复。P10整包未齐不merge/done；不把本提案当作已经部署。
