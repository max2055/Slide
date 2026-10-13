# T04：有限真实 DeepSeek 验收

## 当前验收：v1.2.7 / deepseek-flash

2026-10-13，MAX-145，继续草稿 PR #154。**获准的真实 Provider 场景已通过；完整 T04 等待新 head CI、父独立差异审查及普通 merge/main 核验。** 生产执行源码不变；本轮只调整显式验收脚手架与本文。

Max 评论 `01a132d1-66f0-73e3-913e-2db25a2df408` 指定 `deepseek-flash`，父调度 v1.2.7 允许在新 Key/余额核验后解除原 HTTP402 停发。沿用授权 `01a13273-f6cf-759a-ad6d-24bc8ed7e794` 和原 journal 序号1，保留 HTTP402 checkpoint/stop 历史；未重试旧 unknown request、重置额度或修改旧收据。发送前发现共享配置输出上限已为4096，初次前置核验失败为零发送；脚手架现以配置值与2048取小值，仅影响测试实例。通过现有配置服务/解密函数在内存读取 Key，以 factory 和隔离 fault_diagnosis binding 选择模型；共享 Provider、场景、密钥无写入。

本轮实际新增 **4次 HTTP200**，累计 **5/6**、剩余 **1次**。序号2/3为正常工具链两轮，4为发送后取消，5为发送后 SIGKILL。发送边界 append/fsync journal，禁用 SDK 自动重试与重定向；第3/5次已保存阈值记录，成功后保存 `AUTHORIZED_SCENARIOS_COMPLETE` 停发检查点，不再消耗保留额度。完整 journal、检查点和脱敏响应/SQL快照随 Issue 交付。

| 真实场景 | 验收证据 |
| --- | --- |
| 正常工具/usage | 隔离 MySQL8.4.10＋正式 MigrationRunner＋JWT HTTP 路由（Fastify inject）→Workflow/JobRegistry→DirectAdapter→executor→AgentRunner/Runtime→现有 factory→实际 DeepSeek HTTPS。模型调用 `get_instance_summary` 一次，随后完成；canonical facts共2条，敏感字段已脱敏；原actor=101、持久用户turn保持，一个request一个allocation/Run。重执行没有新增模型/工具调用。 |
| 整次结算 | 两轮 usage合计 input=992、output=126、cached input=384（input子集）；allocation=settled/cost_status=known、chargedTokens=1118。配置费率估算1244微美元，不能代表供应商实收。 |
| 发送后取消 | 序号4成功HTTP响应后、进入durable receipt前，正式JWT cancel路由返回202；Run=cancelled，allocation=unknown，usage=null、保留32000tokens/1000000cost_micros。后续执行零发送。 |
| 退出与恢复 | 子进程序号5收到真实HTTP200后、写durable receipt前被SIGKILL；持久Job重新claim，fence由1到2，Run=partial/INVESTIGATION_PROVIDER_UNKNOWN、retryable=false；unknown非零占额保持，恢复及重复恢复均零发送。 |
| 累计与费用 | 本轮4条成功响应 input=1846、output=263、cached input=896，总吞吐2109 tokens；原HTTP402无usage。供应商实收费用及Agent自身token/费用遥测不可用。取消/退出响应的观测usage未冒充已持久结算usage。 |

**证据边界：** Provider和MySQL为真实；工具及目标资源明确为合成fixture，未验证真实目标设备。HTTP使用正式路由/JWT的inject链路；独立WS、浏览器关闭、真实进程退出多窗口及负例由相关回归/历史fixture gate覆盖，不宣称本次模型调用等于全产品设备端到端验收。六态Run、unknown不退款/不重放、live权限、receipt与fence保护均保留。

当前候选验证：4模块 **126 passed/0skip**（real-provider-budget、executor、execution-recovery.mysql、runtime-lifecycle）；开启 `T04_BROWSER_TEST=1`，真实MySQL正式迁移、JWT/WS/Chromium关闭、SIGKILL矩阵及取消/授权/receipt负例通过。API typecheck、contracts:check、security secret scan、focused oxlint、diff check通过。生产源码未变，复用父已核验18模块536/0skip和安全187历史证据；存在重叠，不相加计数。准确head/CI链接及源码hash在Issue交接附件，不引用旧head的CI作为当前证据。

新head须父独立审查，PR继续draft，未经普通merge/main与父核验不标完整T04 done、不释放完整后续依赖；V1总gate仍归T12。已有本次确切run `01a132d5-f0db-7f0e-8579-d01840fb1699` 的一次性终态交接规则 `01a132d6-6dd2-75de-9684-1cffabaa91da`；只恢复父调度，不重跑实现或请求。独立数据库/schema、子进程及验收服务在交付前清理。

## 历史记录：v1.2.6 / HTTP402（保留原证据）

以下为首次失败时的记录；其中blocked/模型/用量是当时状态，以本页当前验收和累计journal为准。


2026-10-13，MAX-145，父调度 v1.2.6，继续草稿 PR #154。

**完整 T04 仍 blocked：首个真实请求返回 HTTP 402，SDK 归类为余额不足。** 未重试、未切换模型、未修改共享 Provider/场景/凭据。正常工具链、usage 结算、真实发送后取消及 SIGKILL 恢复均未通过真实 Provider 验收；既有 fixture 证据不能替代这些项目。

## 授权与累计用量

Max 的授权评论 `01a13273-f6cf-759a-ad6d-24bc8ed7e794` 允许首批累计最多六次真实模型请求及按量费用，失败、工具后续轮次、重试均计入，跨 run/进程不重置。本次累计 **1/6**，剩余 **5**；真实响应未返回 token usage，供应商实收费用不可得。Agent 自身累计 token/费用遥测不可用，不用请求数或产品 ledger 代替。

仅读取本地现有启用的 DeepSeek 配置：`https://api.deepseek.com/v1`、`deepseek-v4-flash`、OpenAI completions、工具支持、2048 输出上限。通过既有数据库服务读取配置、既有解密函数在内存读取凭据，既有 Provider factory 和 scene selector 使用测试进程内的 fault_diagnosis binding；共享场景表保持为空。避免调用可能迁移旧密文的 getProviderApiKey 写路径。

`execution-real-provider.ts` 是显式 CLI 验收程序，不接生产启动、不加入默认测试、不新增公共 API。它在真实 SDK 的 fetch 边界校验端点、模型、输出上限、关闭重试和重定向；全局 fetch 替换无法可靠拦截 SDK 的 Node fetch shim，因此直接拦截 factory 返回的测试实例 transport。只发送合成目标101、Profile提示和最小上下文。

发送 journal 必须预先存在；进程以独占文件锁读取完整累计序号，发送前 append＋fsync。上限六次，正常链路最多三次，取消和退出各最多一次；恢复路径禁止任何 dispatch。竞争、缺失/损坏 journal、遗留锁、stop 标记均 fail closed；不会自动解锁或重建额度。每次记录已用/剩余，第三/第五次保存阈值检查点。HTTP错误或发送后失败保存 durable stop 标记，后续运行不能因剩余额度继续盲试。

本次 journal 序号1（2026-10-12 23:43:41 UTC），normal场景。此前两次脚手架前置失败均零发送：诊断发现 DirectAdapter 要求 toolsForActor，修正装配后才进入网络边界。HTTP402后停止全部依赖模型步骤；没有消耗诊断重试。

## 实际证据与未完成项

| 项目 | 当前结果 |
| --- | --- |
| 隔离 MySQL | 独立 MySQL8.4.10容器、随机 schema、正式 MigrationRunner；测试身份和目标均合成；最终删除schema并停止任务容器 |
| 真实调用路径 | 正式 JWT HTTP create/admit → Workflow claim/JobRegistry/handler → DirectAdapter → InvestigationExecutor → AgentRunner/Runtime → 配置 factory → 实际 DeepSeek HTTPS |
| Provider 响应 | HTTP402，`code=invalid_request_error`、`type=unknown_error`；SDK中文归类“当前大模型服务余额不足”；不保存凭据、请求头或原始错误体 |
| 失败保护 | 唯一request/Run/allocation；原 actor_id=101及持久 message_id不变；durable provider intent保留，Run=partial、reason=INVESTIGATION_PROVIDER_UNKNOWN，retryable=false；allocation=unknown、charged_tokens=32000、charged_cost_micros=1000000、usage_snapshot=null |
| 正常只读工具/事实/usage | 未通过；真实模型未返回成功结果，tool调用0；脚手架中的get_instance_summary为明确合成fixture，真实目标设备未验收 |
| 真实发送后取消、退出/恢复 | 未执行；遇余额错误按授权方案立即停止，不能用既有fixture窗口冒充 |
| 当前本地相关gate | 4模块126 passed、0skip：executor、execution-recovery.mysql（99项，含真实JWT/WS/浏览器及SIGKILL，Provider/tool为fixture）、runtime-lifecycle、新增发送预算保护3项 |
| 其他检查 | API typecheck、contracts:check、security secret scan、三份新增TS的oxlint、diff检查通过；生产源码不变，原18模块536/0skip及安全187等证据复用，不相加计数 |

预算保护测试包括多进程竞争、退出后不恢复额度、第七次拒绝、HTTP故障stop阻断、损坏/缺失历史和遗留锁拒绝。它们不发送真实请求。真实验收使用的初版脚手架随后补充了跨运行stop阻断，并修正测试价格单位转换为“每百万token微美元”（配置USD/1k乘10^9，缺缓存价按完整input价估算）；这些增量没有再次调用Provider。HTTP402实录不是最终脚手架正向成功证据。

## 重现与后续入口

执行前读取本Issue最新comment及发送journal/stop附件，核对累计值；保留同一journal，不能通过删文件、换schema、换run或进程恢复重置。只在账户余额/额度问题已处理并诊断清楚后，审计解除stop；继续受累计六次上限限制，不重新索取已给予的费用许可。

```bash
T04_REAL_AUTHORIZATION=01a13273-f6cf-759a-ad6d-24bc8ed7e794 \
T04_PROVIDER_ENV=<existing-backend-env-path> \
T04_REAL_SEND_JOURNAL=<existing-cumulative-journal> \
T04_REAL_EVIDENCE=<append-only-sanitized-evidence> \
AGENT_RUN_TEST_MYSQL_PORT=<isolated-test-port> \
pnpm --filter slide-api exec tsx src/investigations/execution-real-provider.ts

AGENT_RUN_TEST_MYSQL_PORT=<isolated-test-port> T04_BROWSER_TEST=1 \
pnpm --filter slide-api exec vitest run \
  src/investigations/real-provider-budget.test.ts \
  src/investigations/executor.test.ts \
  src/investigations/execution-recovery.mysql.test.ts \
  src/adapter/__tests__/runtime-lifecycle.test.ts --hookTimeout=120000 --maxWorkers=2
```

阻塞输入是既有授权账户的可用余额/额度，凭据继续仅由环境提供，勿贴Issue。不以调用次数授权等同账户可用性。PR保持draft；当前head CI、父对新脚手架独立审查、全部真实出口、普通merge/main核验仍为完整T04门禁，不释放T05/T06/System/feedback或生产自动触发。当前准确head和CI结果在最终Issue交接；已有本次确切run的一次性终态规则，只恢复父调度，不重复实现或请求。
