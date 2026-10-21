# MAX-222：r2 后续离线整改与忠实隔离预检

本阶段按 `chief_review_handoff` 的最新 offline-only 边界执行，原 PR #229、候选 a782870e、r1/r2 的真实 partial、历史成果和第1–4项既有验收证据保留。产品模型调用为0，没有创建调查、重放旧 Run、复用已结算预算或修改 Provider/正式绑定。本记录只交付离线整改，不能作为真实完整分析或指定资源全覆盖通过。

## 受保护第二批上下文

r2 调查 `84e693a1-d735-4c7a-b9d0-76ff6eea68b9` / Run `ec7b5f4d-682c-4f49-ab41-2276b6bb172c` 的脱敏 canonical 夹具来自任务附件 `01a15f68-359a-7c62-b14b-6d70a6439611`，通过认证 CLI 下载。`ops-second-batch-20261022.json` 保留两批11个工具结果、messageParts、reasoning/_extra、调用ID及原参数、冻结资源引用；query_metrics discover 的结果内容仍为90,383字节。它是提供给离线回归的保留事实，不是新造分析成果。

RED 在原候选复现受保护估算11,310 > 10,880，接收器未收到请求。根因包括七项 schema 重复附加共同的资源/窗口/缺失值规则，以及业务读取失败后仍重复携带 policy allow=true 的运行时审计信封。

修复：

- 共同规则移到调查 system prompt 一份；每项 schema 的关联资源枚举、必填参数、窗口/行数限制及执行时实时鉴权仍保留。模型提示仅序列化 type/id，资源角色不充当额外权限；共同 maxRows 是实际 Profile 执行上限，schema 仍可进一步收紧。持久 provenance 哈希改为实际组合提示的哈希。
- 仅在 Ops 的执行后临时模型视图去掉失败回执中 allow=true 的重复审计信封；完整业务错误、错误码、数据、后续动作和 policy denial 原样保留。ToolExecutor 失败对象、canonical/checkpoint/SQL 审计不改。
- 现有大结果引用继续携带 toolCallId、完整 canonical receipt SHA256、字节数以及 evidenceOmitted / requiresNarrowerRead；没有把遗漏观测解释为健康或根因。

GREEN：相同夹具、实际 OpenAIProvider 投影和七项 schema，受保护重建为 **10,126 / 10,880**；一份完整六字段协议摘要后的普通请求为 **10,796 / 10,880**。实际 ModelStep 经真实 SDK 序列化到本机 loopback 接收器：一条摘要协议请求、一条普通协议请求；四项保留调用逐一配对，旧调用引用、来源哈希和事实不变，重复投影幂等，20,000字节不可缩减输入仍在发送前拒绝。接收器返回协议夹具，不生成业务分析，也不产生产品 Provider 用量。

这些数字是保守字节估算和离线重建，**不是 Provider token 实测**。最终普通请求余量仅84，后续工具或更大摘要仍可能被最终 assertFits 拒绝；没有降低计数器、扩大16,000窗口、放宽4,096输出/1,024余量、丢弃断言或伪造成功。此次证明 r2 保留批次存在可准入路径，不保证未来真实模型输出或任意后续批次成功。

## 忠实隔离准备

原 r2 限制继续保留：当时漏复制告警历史、错误排除 DEFAULT_GENERATED 导致默认时间元数据重建，本阶段不回填或改写 r2。

新增可复用预检 `scripts/qualification/prepare-investigation-isolation.mjs` 及显式表策略和实际 Provider 工厂核验器。运行方式（使用已有授权环境文件，不在代码或日志保存凭据）：

```bash
pnpm --filter slide-api exec tsx ../../scripts/qualification/prepare-investigation-isolation.mjs \
  --source-env <authorized-env-file> \
  --out /Users/max/Coding/40-Slide/outputs/<new-task-specific-directory>
```

脚本只创建唯一的新 qualification 数据库，不启动 API、Worker、浏览器或模型；校验后销毁自己创建的副本。既有目标、输出目录、未知/遗漏/不可读表都会失败，不覆盖其他副本。每个表都有明确 copy/empty 决定；copy 表在一致性快照读取后参数化插入，避免 INSERT SELECT 的当前读与活跃采集竞态。只排除真正 VIRTUAL/STORED GENERATED 列，DEFAULT_GENERATED 和 ON UPDATE 时间列完整复制。空队列只读计数，不读取历史意图/凭据载荷。

逐表核对 schema、列集合、行数以及包含所有字段/时间戳的无序多重集哈希；报告不写行内容、密文或真实凭据。只允许 cron.enabled=0、非本次 instance/server 的 status=inactive，以及明确列出的空表差异，其他元数据必须相等，停用时显式保留时间列。历史 workflow/outbox/请求/Run/模型与工具意图/动作/通知/报告执行等为空；自动调查及 legacy bridge 的禁用环境要求留在回执。该准备不授权未来发送，readyForModelSend 始终 false。

最终真实数据库预检：166张表完成分类与可读性检查，62张复制、104张按明确边界置空；65个 DEFAULT_GENERATED 列保留。源快照与副本均有103条 alerts、22,898条 alert_events、94,227条 alert_event_logs、76,197条 alert_event_members、37,552条 metric_observations；同批复制值逐字段一致，不能与早一快照的102条告警混用。告警和元数据在源库正常增长，不是此次写入。

通过生产 createConfiguredAgentProvider/fault_diagnosis 工厂在两侧仅构造 Provider，**不解密真实 Key、不发送模型请求**。两侧均为 Provider5 / deepseek-flash，routeVersion 均为 `686c2ca7ee4142d253d25ba2d35a557e41e846499be6e48c45a08f7f45e3fb22`，模型能力/有效参数相等；加密配置字段由完整行校验保证相等，真实凭据有效性未测试。该 routeVersion 属于本阶段源快照，不等于旧 r2 routeVersion。还用离线反例确认默认时间、行数、告警遗漏、不可读表、模型参数或 route 时间变化会被拒绝。

副本仅证明该 Ops-v1 范围在此次快照上的数据/配置一致性。104张空表不代表其他 Profile/历史调查功能等价；未来真实候选运行还要重新预检、落实隔离启动/空队列和独占预算。最终副本已删除，没有保留带凭据配置的副本或启动后台服务。

## 验证与交付边界

- 调查模块 focused 249项通过；当时环境条件跳过的81项路由/会话测试已在隔离 MySQL 上另验通过。最终受本阶段最后变更影响的11项回归通过；允许审计/拒绝语义另有3项投影测试通过。
- 隔离 MySQL：执行恢复108项、观测36项、路由/会话81项，共225项通过。execution-recovery 的1项条件浏览器测试未运行；不声称新的浏览器业务闭环。第一次142通过/2失败、第二次116通过/2失败都因本工作树测试 JWT 环境缺失，第二次误用了旧变量名；使用代码实际读取的 JWT_SECRET_KEY 后观测36项全绿，无产品代码为此放宽。
- 后端标准 typecheck、Agent Core typecheck、资格脚本专用 typecheck、contracts:check、security:scan 通过。资格脚本曾发现仓库根无 mysql2 类型依赖，改用结构化 query 接口后专用 typecheck 通过。新增测试曾缺 Tool 并发标志，修正测试夹具后标准 typecheck 通过，没有修改 tsconfig 门禁。
- Agent Core/前端源码未变，复用既有708项 Core、前端 typecheck/build/浏览器及第1–4项截图和五种导出/IPv6/IPv4有效证据；不重复全量 gate 或把旧 a782870e 的14/14 CI 记到新 head。新 head/CI 以本次交付评论和 GitHub 回执为准。
- 本阶段自建 MySQL 测试容器已按精确容器ID停止；源快照副本已清理。本机共享3000/28888仍PID71556、5173仍PID71545，cwd/命令/日志仍指向共享 main45fe437b，未停止或修改。

**剩余验收**：Chief 审阅本次离线候选后，必须另给新的、回读确认的独占预留，才能进行一次正常产品入口的精确候选 API＋Worker 真实复验。r1/r2 和已释放余量不授权发送；本阶段未写 MAX-208 唯一账本。模型实际分析、成果/状态/证据/用量一致性仍未完成；第6项可信 MySQL counter/interface 生命周期来源仍不可用，unknown/temporary_failure、容量partial、慢查询gauge非速率、qps/disk_usage/告警与宏迁移不变，不因三个正式桶或本次预检变为通过。没有新增 Provider 配置、虚构 epoch、重启218–221、合并或部署。

产品调用/输入/输出/缓存均0；编码实测 token/费用遥测不可用，子代理0。便携证据包提供本报告、RED/GREEN与集成JSON、最终隔离回执、r2夹具来源哈希、源码一致性、PR/CI快照、可恢复增量 Git bundle、manifest 和 SHA256；仅交付脱敏材料。
