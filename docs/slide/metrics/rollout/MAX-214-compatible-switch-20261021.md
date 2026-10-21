# MAX-214 兼容模板切换与遗留迁移审查

日期：2026-10-21。基线：main `63b0ef661bf107d2fedcbfedf5347b39e9a04a9f`。本记录不修改 MAX-188/MAX-193 的历史交付范围。原始 JSON、API 与页面截图作为 MAX-214 评论附件交付。

## 实现与安全语义

`PolicyService.changeBinding` 不再要求新旧 package ID 相同。目标仍必须是 registry 中的精确不可变 pin，资源类型必须一致；变更包的已知版本不兼容在 preview/publish 返回 `422 PACKAGE_INCOMPATIBLE`。未知 inventory/能力不伪报兼容，activate 继续要求真实成功样本。

未提供的 `group_id` 和 `overrides` 保留原值；显式提供的 overrides 延续既有完整替换语义。策略组与资源覆盖仍按原优先级应用；目标包缺少任一覆盖指标时返回 `POLICY_UNKNOWN_METRIC`，不会自动过滤或删除覆盖。用户需明确调整资源覆盖，或经策略组权限/CAS 另行审查组规则。预览继续返回原有读取成本前后估算与完整候选覆盖，候选覆盖不表示正式数据已可用。

变更包会重置 capability；旧 applied revision 与新 published revision 分开保留。试采不写正式观测，activate 再次试采，并复核 candidate fingerprint、CAS、inventory 与权限。单资源 production 服务在试采前、远程请求边界与发布前使用现有 `revalidateActor` 重读当前授权、会话版本和服务器持有的资源边界；bulk 原 guard 继续生效。撤权、会话撤销、CAS 或试采失败均不发布替换配置。

切换保留同一资源、binding 和历史记录。正式查询按当前 binding revision 与 rollout generation 过滤；旧在途不能提交。新版本仍须真实 raw lineage、attempt 和 source snapshot 门禁才能产生正式值。回退通过正常 activate 发布旧包的新 revision，不删除绑定/rollout，不复活旧 ticket 或旧观测。

## 当前遗留定义逐项核实

通过受控只读连接读取当前 instance1 的原定义、模板与绑定，未打印或导出凭据。四项 MySQL SQL 经现有 `classifySql` 均判定为 read；SQL 只读不等于语义已审查。摘要绑定 SQL、单位、kind、间隔及表达式，原记录不更改。

| 原定义 | 当前语义与核查 | 迁移决定 |
| --- | --- | --- |
| `connections` | `COUNT(*) FROM information_schema.PROCESSLIST`；`count`、gauge、资源级、300s；包含 sleeping，会话可见性取决于账号，不能等同 active transactions 或 `Threads_connected` | 摘要 `feefb786c78e59522b6802677904ec3e6ec43ad94ebcf1a3c86046703b21a46e` 与现有审查包匹配。使用 `mysql-custom-existing-scalars@1.0.0` 中 `custom.mysql.processlist_connections@1.0.0` 可保留原定义与阈值口径；先正常 preview/trial/activate，确认正式值和账号可见范围，再单独审查告警规则。 |
| `slow_queries` | 读取 `performance_schema.global_status.Slow_queries`；`count`、gauge、60s；现有配置表示累计数快照，没有差分或重置 epoch 声明 | 摘要 `91d1d18151ded241a4aa25db3853319704141e3bd5edc638096bb9500412dac5` 匹配上述同一个审查包，输出 `custom.mysql.slow_queries_snapshot@1.0.0`。原累计快照阈值不能复制给 diagnostic counter 的每秒速率。 |
| `qps` | MySQL SQL 返回 `Queries` 与 `Uptime`，`ops/s`、gauge、30s，表达式 `(Queries_current - Queries_previous) / elapsed_seconds`。缺少可信重置/lifecycle epoch；SQL 是两行状态而非已审查的单 scalar | 摘要 `e95c21a48b8440dd7be5685fcc1b0cecf6275951d76d38b74debedbce916d158`。保持 `CUSTOM_EXPRESSION_REVIEW_REQUIRED`。现有 `mysql.queries.per_second` 为 `count/s`，只有可信 counter epoch 与有效前后样本才能等价；不能仅将 `ops/s` 改名后迁移告警或造出 0。需审查计数口径、重置与观测窗口，再形成不可变实现/版本。 |
| `disk_usage` | MySQL SQL 合计非系统 schema 的 `data_length + index_length`，实际是估算分配字节；旧定义标 `%`。表达式 `(db_size / 1073741824 / 10) * 100` 引用未返回字段，且固定 10 GiB 分母无资源容量证据 | 摘要 `f648db1e350294bad7d62c6c6c583aed5d9d94bc145f1f8b5bdc96006c707233`。保持 `CUSTOM_EXPRESSION_REVIEW_REQUIRED`，无法证明百分比等价。诊断包 `mysql.tables.estimated_allocated_bytes` 为资源级 `By` gauge，且 SQL/表范围需另核对；它不是主机磁盘使用率，也不是旧百分比规则的替代。 |

现有两项审查 manifest 位于 `apps/db-ops-api/src/metrics/database/reviewed-sql-catalog.ts`，本次未新增未审 SQL。一个资源只有一个包绑定；如需保留 connections 与 slow_queries 两项自定义快照，使用已存在的组合包，不能先后绑定两个单项包导致覆盖丢失。诊断模板切换本身不会自动激活旧 SQL 或迁移旧规则。

## 模板 1 与宏阈值

当前 `MySQL-生产模板`（id=1，enabled=1）绑定 instance1；`macro_overrides=null`、`disabled_metrics=null`，因此下面均为模板默认值。保留模板、实例绑定及原宏，不因切换诊断模板自动执行已弃用的模板引擎。

| 宏组 | warning / error / critical | 审查决定 |
| --- | --- | --- |
| connections | 150 / 250 / 400 | 仅在 `custom.mysql.processlist_connections`、`count`、相同账号可见范围下可逐项迁移数值。操作符、持续时间、恢复时间、缺失语义和 quality/coverage 要从实际告警规则单独核对，宏数字本身不证明规则等价。 |
| slow_queries | 20 / 100 / 200 | 仅适用于原累计数快照 gauge；对应 `custom.mysql.slow_queries_snapshot`、`count`。不改成区间慢查询数或 rate，不自动重置告警。 |
| qps | 3000 / 8000 / 15000 | 被上述表达式与 lifecycle 证据阻塞，不迁移为可执行规则。 |
| disk | 80 / 90 / 95 | 百分比分母及字段不成立，不能移到 `By` 指标，也不能套用 server3 文件系统百分比。 |
| cpu | 85 / 92 / 97 | 数据库模板没有可信 Host CPU/数据库进程 CPU 等价来源；server3 的 top user+system 百分比是另一资源和统计口径，不迁移。 |
| memory | 85 / 92 / 97 | MySQL buffer-pool 页占用比例、主机内存比例与数据库内存比例不等价，不迁移。 |
| tps | 5000 / 10000 / 20000 | 提交/回滚命令次数不能自动等同已提交事务数；缺少可信 epoch 与原规则语义，不迁移。 |

迁移审批输入应包含旧定义摘要、原宏/覆盖导出、目标精确 metric semantic_version/unit/resource/dimensions，以及实际告警操作符、持续/恢复时间、缺失与质量规则。正常配置 CAS 发布并验证至少三个真实正式周期后，告警迁移仍需单独审查和明确启用；此记录不授权告警/通知外发。

## 已确认的 unknown 边界

MySQL 当前 production `trialDatabaseTransport` 使用 `bindDatabaseDriver`；只有 PostgreSQL 有已接入的 `counterQuery`。MySQL access 的 evidence 不包含可信 `counter.start_at/discontinuity`。诊断 SQL 返回整数仍无法满足 `validation.ts` 的 `COUNTER_EVIDENCE`，runner 隔离该 mapping 并记录 `parse_error`/unknown，派生 QPS 随之 unknown。服务器启动时间或 `NOW()-Uptime` 不能证明 `FLUSH STATUS` 等重置，因此本次未伪造 epoch，也未以延长间隔解决。

Linux block counter 已由 production host block discovery 提供实际生命周期证据；本轮真实块读写速率可出数。网络 counter 的现有 host/interface epoch 尚未接入该 access 路径，接口字节与 events 仍 unknown；这是证据缺口，不是网络不可达。`linux.block.io_time_ms_total` 是 ms counter，当前 consumer 不支持其 rate 单位，保持 `query_operation_unavailable`，不改标为字节速率。未扩展其他数据库版本/不可达网络适配。

## 验证与边界

- RED：新增跨 ID 回归原先被 `POLICY_PACKAGE_SWITCH_ID` 拒绝；新增撤权回归原先仍能发布。两个 RED 和对应 GREEN 均保留独立提交。
- policy/config/scheduler：覆盖资源/组覆盖、未知指标冲突、类型/版本拒绝、精确 pin、CAS、实时授权、试采失败、能力重置及审计原子回滚。
- 独立 MySQL formalization：真实 SQL 验证旧正式值在变更后立即不可读，新包需新来源门禁，至少三个后续正式周期；回退为新 revision/generation，旧历史保留。
- 实际资源：从当前 instance1/mysql-basic@2.0.0 revision1 与 server3/linux-basic@1.0.0 revision2 读取配置和受控凭据到独立平台 schema，使用真实 localhost:3306 MySQL 9.6 与 192.168.49.130 SSH；经既有页面 preview/trial/activate 切换到 mysql-diagnostics@1.1.0 revision2、linux-host@1.1.0 revision3。仅在隔离副本将采集周期设为 5s，未修改共享平台绑定、资产或原 SQL/模板/宏。
- 正式 API 和配置页有 actual semantic/fresh 证据；数值页面使用既有 semantic-metrics 组件、正式 `/api/metrics/query` 与明确的真实观测时间窗，空时间桶不冒充最新值。fixture 身份为测试管理员，不能替代完整 JWT 导航验收。
- 最终共享服务集成与持续可用性仍依赖 MAX-209 稳定候选及父 MAX-208 复验；PR、CI、合并、运行服务和 Max 最终验收分别报告。本次不重启共享 3000/5173，不合并或部署。
- 产品 LLM 新增调用为 0；未使用或重置父账本额度。编码代理 token/费用实际遥测不可用。
