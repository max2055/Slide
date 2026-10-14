# V1 灰度、恢复与操作手册

本手册对应 MAX-153/v1.2.31 的隔离验收。它不表示生产部署已经执行，也不授予生产变更权限。真实 Provider / System、三类资源证据及 T11 定性接受沿用已合并候选；数值 unscored、DB06/NW05 原失败、80%/90% 软目标未测及盲评 unavailable 保留。

## 准入和灰度

1. 核对候选 Commit、PR 当前 head CI、领域 Review 和版本化报告。迁移用正式 `MigrationRunner` 在隔离库执行两遍，并检查 `app_schema_migrations` 的 checksum；历史 snapshot 覆盖的 `baselined` 与新增调查 `completed` 分开记录。不要对新表执行 destructive down。
2. 在测试环境核对进程 PID→端口→cwd→命令→Commit→日志；不停止其他工作树。Profile、工具和实时主体/全部资源 scope 的交集是执行权限。模型只能读取列入 allowlist 且实际注册的工具。
3. 默认 `INVESTIGATION_MANUAL_ENABLED`、`INVESTIGATION_OPS_AUTO_ENABLED`、`INVESTIGATION_LEGACY_BRIDGE_ENABLED`、`INVESTIGATION_SYSTEM_EVENTS_ENABLED`、`INVESTIGATION_SYSTEM_AUTO_ENABLED` 都不自动开启。System 自动开关要求事件开关已开且服务身份有效；收集开、自动关仍能保留原事件。
4. Ops cohort 来自 `INVESTIGATION_OPS_SERVICE_USER_ID` 及 `INVESTIGATION_OPS_INSTANCE_IDS` / `INVESTIGATION_OPS_SERVER_IDS` / `INVESTIGATION_OPS_NETWORK_DEVICE_IDS`。只使用已有受限服务身份；三类名单合计最多 20 项，资源 ID 有效且每类不重复。未配置的自动来源应 suppressed，不转成另一条付费执行。灰度先一类一项，再按证据扩至三类，不用 event tags 扩权。
5. 将新接入事件与旧 Analysis owner 对齐；已提交、running 或 unknown 的历史执行保持原 owner。灰度容量有限，不能由模型或 payload 改策略。

## 指标和停止条件

从持久 `operational_events` 的 disposition/suppression_reason、`workflow_jobs` 的状态/租约、`investigation_requests`、`agent_runs`、`investigation_evidence`、`investigation_budget_ledger` 及管理 API 核对：accepted/suppressed/reuse、queue wait、terminal duration、unknown、取消 request/ack、证据 gaps、Provider attempts 和 usage。管理用量为配置管理 scope 下的全局聚合，不能向普通用户暴露资源/调查 ID 或未授权计数。

关联字段是 investigationId/requestId/runId/eventId/jobId/profileVersion/actor/scopeVersion；原日志和账本不写凭据、SQL literal 或完整敏感 prompt。模型 usage 缺失必须单列 unknown，不记零；rate estimate 不等于实付发票。

以下情况停止该来源自动 admission 并保留原事件：任何越权/凭据出站、同事件双 owner 或重复付费、无 durable result 的 completed、System 自举循环、来源 Commit 错配或证据过期。告警风暴保留自动限额及手动预留；不要删除 unknown 预留来腾额度。硬模型预算 50% 报告、80% 收敛、100% 停发并留检查点。

13.4 延迟值是提案。容量报告记录实际硬件、10000 调查/100000 事件、样本数和 P95；少量本机采样不证明生产 SLO。列表当前逐对象权限检查的成本必须按实测记录，性能目标未满足时不得写“已达标”。

## 回切和恢复

- **来源回切：** 把对应 automatic 开关关掉，按当前部署的既有重启流程加载配置。已持久 owner 继续沿原路径查询/完成；不要删 owner、重建 request 或把未知执行转给旧 Analysis。新来源走已有旧路由时只创建一次旧 admission。
- **UI 回切：** 先验证 `/chat` 和历史消息仍可用。当前仓库没有独立 Investigation UI feature flag；如需版本回滚，使用既有经过批准的前端 artifact 回滚机制。不要把不存在的 UI 开关写成已演练能力。
- **发送前故障：** 等租约失效后由现有 Worker/fence 恢复，核对同 request/job；只有可靠确认未发送才能重试。
- **发送后未知：** Run 保持 partial/outcome_unknown，账本保持 unknown。不重放模型；恢复持久 completion staging 可以修复消息和结果，不再次调用 Provider。
- **取消：** 先持久 cancel_requested_at，等工具收到 AbortSignal 和 ack。执行中的工具尚未退出时不能写成 cancelled。确认 request/ack 和最终 Run 状态后，才允许新 Run。
- **WS/刷新：** 登录鉴权、watch、快照及 cursor 回放；消息以原 ID 去重。游标越界/保留期丢失时重新快照，不重建 Session/Run。同 JWT 实时撤权后关闭观察并清除内容缓存。
- **保留期：** 当前 evidence raw 保留七天，到期读取返回 tombstone，raw 请求 410。后台每次 `purgeExpired` 最多 200；删除敏感 raw，保留 hash、metadata、引用及结果版本。快照 source tombstone 独立于 replay event 保留期，避免重新发布旧消息。

## 操作者培训验收

| 场景 | 操作 | 必须观察到的结果 |
|---|---|---|
| 普通 Chat 转调查 | 保留原 Session/消息 ID，活动 Run 时拒绝转换 | 历史不复制、一个 owner |
| 自动告警 | 三类资源各打开调查并追问，再返回资源 | 原资源/窗口、两 Run、两结果版本、来源链接不新调模型 |
| 断网和关闭浏览器 | 断开 WS 或关闭所有上下文，再打开 | 后台 durable terminal；原消息不丢不重 |
| Provider 故障 | 仅在隔离夹具注入 unavailable | 原异常可查、unknown/failed 如实显示、不循环触发 |
| 撤权 | 同 JWT 删除一个必需 scope | 搜索/详情/raw/WS 全部无泄露，缓存清空 |
| 证据到期 | 访问已过期 raw | 410，保留引用，不用过期证据确认根因 |
| 人工反馈 | 对固定 result version 提交验证记录 | 完成 Run 不自动 resolved；关闭必须真实依据或 not_applicable |

培训表是可重复的操作场景，自动浏览器证据只说明工程演练，不声称已组织真人培训。

## 重复验收

```bash
# 本脚本只创建/停止它自己命名的临时 MySQL，失败非零，原始报告保留。
bash scripts/qualification/run-investigation-rollout.sh --integration
# 完整本地 gate；release security 需要真实 Linux/rootless sandbox 环境。
bash scripts/qualification/run-investigation-rollout.sh --full
```

模型发送不是上述脚本的一部分。确需复验时先只读核对唯一 `T09-System-V1` pointer/hash、递归 journal/claim、stopped/no pending/reserved0；沿既有链初始化新 scene，先原子预留、后实测结算，不清除 stop/claim、不拆批或重放未知发送。缺必要环境只暂停依赖步骤，保留可复现命令与日志，不能 skip 成功。
