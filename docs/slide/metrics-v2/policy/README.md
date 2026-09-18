# 采集策略、发布配置与影响预览

MAX-69；入口 `apps/db-ops-api/src/metrics-v2/policy/`。基于已合并 MAX-64 契约、MAX-65 inventory、MAX-67 不可变包。配置面接入 `server.ts`，不启动采集，也不改变旧后台任务。

## 解析与来源

顺序：选定 ID/version/digest 的包推荐 → 一个显式主资源组 → 资源覆盖 → Capability 与平台限制。没有主组时直接继承包。不会根据标签猜测主组，不存在多组优先级。包内容/Canonical/CoreProfile 均不修改。

- 数值覆盖：`{"mode":"inherit"}` 或 `{"mode":"set","value":30000}`。缺省等同继承。
- 启停三态：`inherit` / `enable` / `disable`；用于整体 `enabled` 和 `metrics["metric.id@1.0.0"]`。不把数值 0 当禁用。
- `overrides` 提交时是完整替换；省略则保留原覆盖。只换 package pin 时，覆盖自动保留；不兼容的旧覆盖明确拒绝升级，不静默丢弃。不允许换成另一个包 ID。
- 资源覆盖可以重新启用被组关闭的采集；平台限制不可覆盖。禁用 raw 指标而继续启用其 derived 依赖会拒绝，调用方需同时关闭依赖输出。关闭整体不会删除指标、能力、历史或用户配置。
- 每个配置值有 `sources`，指标启停有 `metric_sources`；标明 package/group/resource/platform 身份和适用 revision。`collector_timeouts` 单独列出实际单读取超时和来源。`platform_limits` 明示硬约束。

周期 1s～24h，超时 250ms～30s 且不超过周期；stale 和 counter gap 不小于周期。max_rows ≤100，max_concurrency ≤16，资源系列预算 ≤10000；数值须为正整数。默认并发 1、资源系列预算 100 是平台默认，其他默认来自包。预测的已启用输出总系列数不得超预算；带维度输出按 max_rows 估算。collector 内置 timeout 上限还会收紧单读取超时并明示来源。

`plan` 使用冻结的 CollectionPlan / CollectionBinding / CollectionPolicy / MetricBinding 契约。`metric_templates` 提供所有指标的版本、collector/raw_field 或 derived 来源、能力和所需维度键。SQL/SSH 标量输出直接生成合法 MetricBinding；SNMP 尚未发现 if_index/interface_epoch 时只提供模板，不伪造空维度绑定。MAX-70 必须在发现真实维度后实例化并校验绑定与基数限制。

## 能力与生效状态

资源属性读取 MAX-65 inventory；不存在时返回 unknown，不能把缺少版本信息解释为 unsupported。包适用条件有确认不匹配时才是 unsupported。能力保留 basis、evaluated_at、valid_until；权限不足为 unknown + permission 依据，过期/未来证据不会作为当前 supported 使用。derived 决策传播输入能力。

`GET .../resources/:type/:id` 返回最近发布的不可变解析快照。`GET .../effective` 以当前时间/可信能力重新判断可用性，保留当前配置 revision；查询不发布新 revision。能力变化不会篡改用户配置。包版本变化清空旧包能力证据，要求重新探测。

发布成功返回 `application.status=pending`，初次 `applied_revision=null`。后续发布保留上一次真实 applied_revision，直到新配置被确认；failed 不提升应用 revision。`MysqlPolicyStore.reportApplied()` 和 `reportCapabilities()` 是无公共 HTTP 路由的内部 MAX-70 集成端口：检查配置 revision、身份、时间和合法状态，单次 timeout 使用原能力快照、不续期。实际 worker 身份认证、租约/fencing、上报调用以及发现维度实例化由 MAX-70 集成，本项不宣称已完成真实应用。

`reportCapabilities` 接受当前包的完整能力快照；调用方应提交包 runner 返回的稳定分类，不传远端异常原文。`reportApplied` 的 at 不得早于发布或上次报告，已 applied 不可退回 failed。它们只改变运行状态，不写配置审计，也不改变发布 revision。

## API

前缀 `/api/metrics-v2/policy`，沿用 JWT `verifyToken`。

| 方法与路径 | 行为 |
| --- | --- |
| GET `/resources/:type/:id` | 最近发布的绑定、配置/来源/依赖、发布时刻、应用状态 |
| GET `/resources/:type/:id/effective` | 当前能力下的解析结果；published_revision 与 application 分离 |
| GET `/resources/:type/:id/audit` | 最近 100 条发布审计，含 actor/request/revision/配置快照 |
| POST `/resources/:type/:id/preview` | 无写入试算，需目标资源管理权限 |
| POST `/resources/:type/:id/publish` | CAS 发布并原子保存审计 |
| GET `/groups/:id` | 组覆盖、影响集合 revision、policy_revision |
| POST `/groups/:id/preview` | 对全部成员试算影响，不写入 |
| POST `/groups/:id/publish` | 原子重算/发布全部成员，任意成员失败则全部回滚 |

初次资源发布：

```json
{
  "expected_revision": 0,
  "package": { "id": "mysql-basic", "version": "1.0.0", "digest": "使用内置包快照中的完整 sha256 摘要" },
  "group_id": null,
  "overrides": { "interval_ms": { "mode": "set", "value": 30000 }, "enabled": "inherit" }
}
```

真实可执行输入见 [fixtures.json](fixtures.json)，严格 schema 见 [schemas.json](schemas.json)。后续发布必须携带当前 `expected_revision`，未命中返回 409。组发布输入为 `expected_revision` + 完整 `overrides`，组 ID 是 URL 参数；初次 expected_revision=0。

资源发布保留一个 group_id；加入/离开组需管理被影响组的当前全部成员。空组创建/读取/修改以及首次加入需要全局管理员 `*`。对非空组读/写要求对全部成员有对应读/管理权限，不能借组预览泄漏不可访问资源。实例管理复用 `instance:manage` + read-write/admin scope（或现有不受限权限）；服务器/网络设备沿用现有 `servers:manage` / `network_devices:manage`。只读权限不能发布或预览变更。

组 `revision` 覆盖成员集合及成员覆盖变化，用于使旧影响预览失效；`policy_revision` 只在组策略发布时改变，用于标记解析来源。因此单资源覆盖发布不要求给其他成员发布新配置；组策略发布则为全部成员增加 config revision。

401 未登录，403 资源/组权限不足，404 资源/绑定/组不存在，409 revision 冲突，400 非法输入/时序/依赖/包 pin，503 存储不可用。错误不回显提交值、SQL 或远程错误。正文上限 64KiB，拒绝未知字段与客户端能力/资源身份覆盖。

配置 API 不接收/返回凭据或 credential_ref，也不解密现有资源凭据。持久绑定的资源身份是后续 worker 解析该资源凭据的权限边界；MAX-70 调用包 runner 时仍须使用其 `credential:<opaque-id>` 和资源专用授权 transport，不能把这里的管理权限当作跨资源凭据授权。

## 预览估算

返回受影响资源、每项来源、metric_templates、dependencies、disabled_metrics、unavailable_metrics、前后请求量与系列数估算。不连接目标设备、不解析凭据、不执行 probe。

`requests_per_hour_estimate` 的 `request_unit=logical_reads`：SQL 一次固定查询，SSH 两次固定读取，SNMP 一次 table walk；unknown 按可能尝试计入，unsupported/disabled 不计入。同批多个指标只计一次 collector。网络 PDU 分页、重试、实际延时与发现行数不在此静态估算内，不能把它当物理请求上限。系列数使用 max_rows 上界，是容量拒绝的保守估算。

## 持久化、并发与回退

增量 migration `099_metric_v2_policy.sql` 新增 groups、bindings、audit 和单行配置锁。发布和配置查询在短 MySQL 事务中串行化，避免组成员变更与批量发布交叉产生幻读；不持锁做远程操作，不影响旧观测写入。配置量较大时这会成为吞吐瓶颈，当前采用可证明原子性的低频配置面方案。组成员变更、配置、应用状态与能力均使用同一锁；审计失败回滚整个发布。缺少锁记录会拒绝操作。

包版本、资源覆盖、解析快照持久保存，服务重启可查询；组与资源审计包含恢复配置所需的非秘密快照。回退选择旧 pin 并保留覆盖，或以当前 expected_revision 提交审计中的配置快照；这是新发布，不倒退 revision。代码回退停用新路由并保留四张表；不删除历史 migration/ledger，不 drop 已有数据，不影响旧采集路径。没有生产部署。

## 验证

见 [validation.md](validation.md)、[plan.md](plan.md)。所有路径相对模块/import.meta.url，导出与检查不依赖当前开发机 cwd。
