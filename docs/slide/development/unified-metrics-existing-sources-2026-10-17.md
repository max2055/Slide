# MAX-189 现有配置迁移与真实 MySQL／VM 验收

2026-10-17，本记录接续历史验证文档，当前有效实现仍交付到原草稿 PR #202。后端真实流程已通过；真实 UI 发布闭环、Chief 独立兼容审查和最终集成 gate 尚未通过，不能称完整交付、已合并或已部署。

## 准确版本与环境

- 运行源码提交 `f0fa1e8d4e4e60eaa0f71b74301cdfb285c21718`，API 源码 tree `ff8f133f126ce9d57b6fc7f1e93e918c90d7072e`。业务修复 `e79e6f3c`，后续 `f0fa1e8d` 只修独立 float64 速率比较的一 ULP 断言；之后本轮仅文档修改。
- UI 只读复用 B 的实际组件：`a5e7d5e42dc21f78e1dc1284feeaf2fabba771cc`，其 frontend 工作区干净；没有将 B 文件混入 A 分支。
- 纳管对象：mysql3306／实例1，MySQL 9.6.0，localhost:3306；服务器3，192.168.49.130:22，麒麟 V11／aarch64。SSH 身份指纹 `SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA`。
- 按 Max 新授权从真实平台纳管配置读取并仅内存解密 SSH 信息；未使用旧失败凭据、未重置认证、未改变 Provider。真实平台仅只读，五条自定义定义和实例1模板绑定复制到本任务 MySQL 8.4 独立临时 schema。必要的历史可选列只在副本补齐。
- 远端仅执行既有有界只读 SQL／固定 SSH 采集命令。试采、发布、开关和恢复均针对临时平台副本；真实服务器原 `collection_enabled=0` 不变。两次最终流程均验证原配置 digest 前后相同。
- 产品 LLM 调用0，共享预算未清零；无子代理。编码代理 token／费用实际遥测不可用，不用内部计数代替。

## 已有用户 SQL 与模板

| 原定义 | 真实配置核查与迁移决定 |
|---|---|
| connections | `SELECT COUNT(*) as count FROM information_schema.PROCESSLIST`；精确 uint64 gauge，包含 Sleep，范围由账号权限决定；不等同 Threads_connected 或活动事务 |
| slow_queries | `SELECT VARIABLE_VALUE AS Value FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Slow_queries'`；保留原 gauge 对累计快照的语义；不伪称区间慢查询数／速率，不声称重置 epoch |
| disk_usage | 原固定分母／表达式无等价容量证据，保留 `CUSTOM_EXPRESSION_REVIEW_REQUIRED`，不恢复伪容量 |
| qps | 旧表达式无可信求值与 epoch 证据，保留 `CUSTOM_EXPRESSION_REVIEW_REQUIRED`，不导入旧 Number 差分 |
| replication_lag | 现有 SQL 仅 PG，不套用 MySQL；其他引擎没有本轮远端实测 |
| 实例1／模板1 | 完整保留原宏、metrics 和绑定副本；返回 `TEMPLATE_MACROS_REVIEW_REQUIRED`。逐规则审核后冻结定义、发布策略／覆盖；不运行 Phase130 已废弃模板执行器，不自动转换阈值 |

可信产物 `database/reviewed-sql-catalog.ts` 绑定 source digest：

- connections：`sha256:feefb786c78e59522b6802677904ec3e6ec43ad94ebcf1a3c86046703b21a46e`。
- slow_queries：`sha256:91d1d18151ded241a4aa25db3853319704141e3bd5edc638096bb9500412dac5`。

SQL、原生 unit／kind、间隔或表达式变化重新阻塞。两个单项包显式组成 `mysql-custom-existing-scalars@1.0.0`，digest `sha256:13b333303dd9b28dbd26714a82be959b2761f8e2831095da4c4ff0019287e709`；继承 `mysql-diagnostics@1.1.0` 的准确 base pin。单资源只有一个包绑定，两条 SQL 在同一授权 transport／runner／scheduler／publication 中共存，不相互替换，不增加第二周期或 HTTP 任意 SQL 入口。

本轮目录为25个包版本、125个定义；原22包版本内容保持，新增3包和2定义。`review` 字段明确实施者核查、仍需独立 PR 审查，不冒称 Chief 批准。迁移接口的 `reviewed` 只表示匹配可信产物，仍需显式试采、激活、CAS、来源验真和正式新样本。

## 真实环境暴露的两处后端修复

1. vfat／efivarfs 的 `df -Pi` 明确输出 inode 使用率 `-`，新旧解析均保留 null／unknown。原对照错误地将其认定数值失败，阻塞整资源正式发布。现在仅成功捕获且对应 mount 明确缺该统计时记录语义差异，不计为数值比较通过。捕获缺失、畸形输入和非空不一致仍失败。
2. `linux.block.io_time_ms_total` 是累计毫秒，查询层当前仅支持 count／By 的 counter rate。原 `view=all` 因 `COUNTER_RATE_UNIT` 整 API 503；现在该操作返回 `query_operation_unavailable`，保留原累计证据，其他指标正常200，不改单位或伪造速率。

来源／消费者回归先复现后通过，完整保留 unknown、精确整数及不支持操作的含义。

## 最终后端证据

安全附件 `backend-real-flow.json`（原产物 real-flow-mysql-vm.json）记录上述完整源码 SHA；真实测试1文件1测试通过，80.23秒，exit0：

- MySQL 4、VM 8个不同正式 publication 周期，均超过3周期要求；经过真实试采、激活、来源门禁、唯一正式 API。
- 两条既有自定义 SQL 同时出值：连接数精确 uint64 `5`，慢查询累计快照精确 uint64 `0`。诊断快照、uptime 等也经正式 API 返回；不是合成 publication。
- VM 初始关闭时 attempts **0→0**；启用后有真实成功采集和正式新样本；再次暂停 **40→40**。
- 新 scheduler 实例恢复后 last_success 推进到 `2026-10-17T00:47:09.104Z`，正式观测推进到 `2026-10-17T00:47:09.733Z`，正式 API 返回恢复后的新样本，available／fresh。
- VM `collection.state=failed` 仍真实保留：末批网络计数器缺可信生命周期；其他 collector 有成功且 last_success 推进。不能宣称全部 collector 成功、所有 epoch／速率可用。
- 原平台配置摘要未变，`original_configuration_unchanged=true`。

冻结源码上的 A 受影响模块检查：48文件／455测试通过，7文件／11测试按专用环境条件跳过，66.62秒，exit0。命令：

```bash
METRICS_TEST_MYSQL_PORT=23389 pnpm --filter slide-api exec vitest run src/metrics --exclude '**/flow.mysql.test.ts' --maxWorkers=1 --reporter=dot
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm security:scan
```

类型、公开契约和 secret scan 均通过。明确排除的 flow 由 B 的 A/B 组合 gate 负责；这是 A 受影响模块回归，不能称完整集成 gate。此前一次模块回归454通过、1失败：独立 Number 除法与精确 rational 转换产生一 ULP 差异；改为 float64 精度断言后单文件3测试及上述完整模块回归通过，精确 BigInt 输入／差值、lineage和查询等值断言不变。

## 真实 UI 尚未通过

同一最终源码配合 B 上述准确提交执行真实组件流程：正常选组合包、间隔覆盖5秒、预检和试采，真实 HTTP200返回18样本、16 attempts（12 succeeded、3 failed、1 partial），两条自定义 SQL 均 succeeded；失败的数据库 counter 缺可信 epoch，不伪填成功。UI截图和 `ui-real-flow.json` 附件保留证据，原平台配置未变。

B 的 `frontend/src/components/metric-configuration.ts` 当前 `trialPassed` 要求 attempts 全部 succeeded；A 的激活路径允许有 good 样本且存在成功／partial 尝试。UI因此显示解析／生命周期信息，发布按钮禁用；“试采成功，可以发布”断言失败（10.53秒，exit1），没有绕过 UI 强制发布。需 B／Chief按能力覆盖与未知 epoch 的契约决定部分成功试采能否发布，并补 UI 行为及回归。A没有越界修改 B。

UI环境是生产 metric-configuration 组件的隔离 HTML 宿主、真实 HTTP／SQL／SSH、测试 admin 身份；不是完整产品认证导航，也不代表 R1 逐页验收通过。UI失败发生在正式周期前，因此其 JSON 没有 code_head，准确输入由本记录及附件 manifest 固定，不能冒称该UI失败文件完成后端流程。

## 接续与门禁

- 原 A `49155886` 的 API资格失败日志已核：等待 R1“检查并启用”按钮超时；browser旧导入及browser-qualification旧历史fixture也是A/B组合依赖，release／ci-gate连带拒绝。旧结果不能作本轮新 head 的 CI 结论。
- B 原组合 `60a04cab` 使用旧 A；其已有完整测试／Linux／打包证据仅覆盖当时源码。本轮 A 运行源码已变，需Chief／B用新 A SHA补受影响检查和最终必要集成 gate，A不重复B全套、不合并。
- 已有 SQL 包独立审查、部分成功试采契约、完整产品UI／R1、最终CI及集成SHA业务验收仍未完成。保留 blocked／draft，不启动 C/D，不恢复旧读源／双目录制造绿灯。
- 真实平台无需恢复（只读且摘要未变）；临时 schema 由 afterAll删除。测试容器及本任务 Fastify／Vite／Chromium在交付前核验清理，不停止主仓3000／5173或其他服务。每次push续设原任务／15astra／原线程的 checks／30m／超时wake，读取当前head快照，不等待外部CI。
