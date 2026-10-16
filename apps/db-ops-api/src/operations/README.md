# V23 内部契约与装配交接（P01）

本目录已有 `types.ts` / operation-service / recovery-policy，继续代表旧 Operation。
新增 contracts/authorization/feature-flags/schema 不替换旧模块，不注册生产路由或 worker。
验收依据：父任务 MAX-193 附件 implementation-1.2，SHA256
`459c81c1b67a3867db8ba181e91da6ebe075e8e676f5d77a3ff735ccae48e915`。

## 所有权与消费方式

- P02/P03/P04/P05 分别拥有关系、案例、基线、关联的服务及存储。P06/P07/P08 分别拥有计划、执行、验证。使用本域内部类型，不能把这些类型的存在当作对应业务能力已上线。
- P10 独占公开契约/生成类型、server、工具注册、正式迁移编号和 composition。`schema/operations-v1.sql` 仅供领域隔离测试，不能复制到生产启动路径冒充正式迁移。
- 基线只保存可重放的系列身份/算法/质量/窗口/引用。`series_identity.source` 由 P04 消费 MAX-189 审定的正式 metrics 查询结果。没有新增指标采集、metric source/binding 库或 metrics-v2 兼容路径；与旧 `metric_baselines` 不同义，不回填。外部表映射由 P10 在 MAX-189 合入后确定。
- 新建表均位于本域，现有用户、资源、事件、调查、approval/intent/outbox 继续作为真相源。外部资源删除保留受权限保护的引用/tombstone。跨域 FK 的删除策略由 P10 装配审查，不能把旧审批的 CASCADE 删除传播到行动历史。

## 契约边界

`schemaVersion=1`；可编辑对象使用 expectedVersion/CAS，内容版本只增不覆写。
计划先由服务端 strict schema 验证，再对完整内容做 canonical JSON SHA256，数组顺序保留。
计划作者/请求人、目标、原调查结果、参数、工具实现 hash、证据及有效期、关系/基线版本、前置、风险、策略、验证器和回退声明均属于批准绑定。
初始试点固定 `restart_demo_service` / `slide-action-demo.service`，无命令字段、URL 或任意服务名。默认有效期 15 分钟，上限 30 分钟。服务器 eligibility/host key/配置 hash/证据新鲜度仍由 P06/07 在审批和发送前核验。

execution 与 verification 分开：`outcome_unknown` 是业务事实，不是可重试 500；`succeeded` 不意味着问题 resolved。P08 必须核对 report→execution→planVersion→investigation/resultVersion 全链，源结果改变使旧报告失效。P07 在现有事务中锁计划/批准、一次消费、写 execution 和 intent/outbox，再按现有 lease/fence 发送。schema 唯一键不意味着数据库与远端的绝对 exactly-once。

## 实时权限

`OperationsAuthorization.authorize` 使用同一事务中的 ActorContextService 当前锁定读取，取当前权限与原始 caller ceiling 的交集，逐个检查完整资源集合的边界/存在性/数据库授权。操作权限见 `OPERATIONS_PERMISSIONS`；P10 显式注册、授权，不默认分配给已有角色。审核需要目标管理权限，服务身份不能审核，作者/请求人不可自批（管理员同样适用）。返回值仅含本次所需精确权限/资源，无 admin wildcard。

领域服务必须从持久对象加载完整 source scope，不能信任客户端给出的资源子集；仍需检查源调查成员身份、发布/过期状态、版本和 freshness。搜索/计数/分页/排序在 SQL 授权过滤之后发生；不得先全表加载再调用 authorize。每次详情、缓存、模型出站、WS 推送前重新 authorize，旧成功结果不能作为可重用授权。内容不可见统一 404，变更拒绝 403；基础设施错误继续抛出，不伪装为空列表。

## Flags 与保留式回退

所有入口默认关闭，仅接受字面 `true` / `false`。配置键为 `OPERATIONS_{CONTEXT,CASES,BASELINES,ATTENTION}_ENABLED`、`OPERATIONS_ACTION_PLANS_ENABLED`、`OPERATIONS_ACTION_DISPATCH_ENABLED`。dispatch 还要求 plans 开启，`OPERATIONS_STOP_NEW_DISPATCH=true` 优先停止新派发。P10 在使用点供应实时配置；环境快照本身不是分布式开关。

回退顺序：停止新派发 → 清点 queued/prechecking/dispatching/unknown、已消费批准及 lease/fence → 阻止新入口/worker → 保留所有版本、审计、intent、execution、receipt、verification → 由有权限人员继续必要只读核验。停用开关不删除或改写历史，不把发送后取消标为已撤销，不退款批准，不自动重放。恢复前核对 schema、原 operationId 和目标回执；不得 DROP 或逆向数据迁移。旧 Operation/Chat/SQL/审批路径保持不变；P10/P11 负责最终装配和恢复端到端验收。

## 唯一产品模型预算

唯一批次 `AI-Operations-V23`，既定 canonical 目录
`/Users/max/Coding/40-Slide/outputs/2026-10-16-v23/budget/`，journal 为 `product-llm.jsonl`，旁边 `.sha256` 是完整性指针，`.lock` 为跨进程独占锁。
所有工作树从 `operationsProductBudget()` 取得相同端口。只有 P01 显式初始化一次，已有文件不得重置；无工作树/环境路径覆盖。低层可配置路径的类仅供隔离测试/端口实现，业务不得实例化另一个余额。

复用现有 investigation `budgetUsage` 校验和 real-provider-budget 的独占锁、发前 fsync 日志机制；旧 T04/T09 的授权和批次额度硬绑定，不能直接沿用其余额，因此用本域 adapter 绑定新验收目标。该 qualification 账本不替代生产 Investigation runtime budget。
发送前 reserve 输入上界与输出上限；发送完成 settle 实测 usage。用 input+output 扣额，cachedInput 是 input 子集，不另加。未知 usage/未结算发送阻止后续调用；进程中断/残留锁/hash 不匹配人工核对，绝不自动删锁或重放发送。usage 越界保留实测并停发。累计 50%报告、80%收敛、100%停发并留持久检查点。预算限额 10,000,000，不按场景/进程/恢复清零；编码代理用量单列。

## 验证层级

`vitest run src/operations` 验证内部协议、权限和 flags；设置 `OPERATIONS_TEST_MYSQL_PORT` / 可选 `OPERATIONS_TEST_MYSQL_PASSWORD` 运行真实隔离 SQL（也继承现有 CI 的 `AGENT_RUN_TEST_MYSQL_*`）。测试自行创建、清理 UUID 数据库，不能指向生产。预算的合成 usage 只写临时测试目录，不计为真实产品 usage。P01 无 HTTP/视觉/远端执行出口，B01～B18 的业务、真实数据资格和最终回退门禁由对应后续包完成，不因本包内部测试通过而解锁。
