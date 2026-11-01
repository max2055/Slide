# 按 revision 读取历史采样配置

MAX238 为 MAX240 提供已接线的只读端口：

```ts
// 已有生产实例位于 metrics/templates/routes.ts；下游通过依赖注入复用此方法。
readConfigurationAt(actor: ActorContext, ref: Ref, revision: number): Promise<ConfigurationAt>
```

HTTP：`GET /api/metrics/configuration-history/{type}/{id}/{revision}`。公开类型 `ConfigurationAt` 来自 `contracts/metrics/configuration-history.ts`，同时生成 OpenAPI 和前端类型。需要当前资源读取权限，响应 `private, no-store`。不查询模板当前版本、不调用远程目标、不调用模型，也不修改历史消费者。

返回语义：

- `unknown / snapshot_not_recorded`：该 revision 没有保全记录。包括升级前已被覆盖且无法证明的配置。不得回填当前值或默认 60s/180s。
- `published`：确有当次不可变完整 resolved 快照，可显示设置，但没有正式生效依据，不能用它宣称该段历史已经采样。
- `effective`：返回当时八项 settings、快照 digest、固定解析 identity（模板）及精确依据列表。`application_report` 是现有受信内部应用回报；`scheduler_activation` 是既有 fenced worker begin 事务完成的配置激活；`formal_observation_commit` 是模板唯一正式 writer 在样本同一事务保全的首批 sample IDs。激活不等于健康，样本提交不代表所有项成功或后续持续采样。

`evidence.at` 是该路径报告/执行使用的时间，非 MySQL commit 的物理时刻，也不是一个连续有效区间。模板依据不改变 accepted strict codec 的 pending/applied 字段，不伪称绑定 applied。下游必须按样本自身 `versions.config_revision` 逐段查询，并保留原始 observed_at/quality；不能把当前配置或另一 revision 的依据套入旧段。此次未实现 MAX240 消费者或其页面。

持久化复用 `metric_policy_audit`，没有平行配置表。模板发布在原 binding CAS/operation/audit 事务的现有审计行附带 `configuration_history`；legacy saveBinding 在原事务追加快照。正式模板 writer 在其原样本事务中追加首次执行证明，失败/撤权/租约拒绝使证据一并回滚；每 revision/basis 只保全首次证明；已有记录损坏或采样身份/设置不一致时拒绝写入。旧快照由应用路径只追加保全，不 UPDATE/DELETE。legacy 历史审计 API 只过滤新专用 `configuration.snapshot` 记录，保持原有模板拒绝语义。

读取对完整 payload 复用 strict persistence codec，并检查资源、revision、时间、binding、settings、identity 一致性和 canonical SHA256；冲突/损坏返回 409 `CONFIGURATION_HISTORY_INVALID`。缺失记录与数据库错误分开：503/500 不解释为 unknown。SHA256 用于发现不一致，并非对恶意 DBA 同时重写 payload 和 digest 的密码学签名。

读取事务在 READ COMMITTED 下先持 policy 共享锁，再通过生产 `revalidateActorOn(..., true)` 当前读并持有主体/授权行锁到 commit；资源存在性和历史内容在此后读取。等待中撤权先提交则拒绝；读取先取得授权锁时撤权等待至读取结束。历史内容不可变，但返回后权限可以变化，每次查询仍需重新授权。内部无受信锁定 authorizer 时失败关闭。

隔离 MySQL 命令（从 frontend 执行）：

```sh
MAX238_HISTORY_MYSQL_TEST=1 MAX238_API_PORT=51859 bash e2e/max238-unbind-preview.sh
```

此分支只复用既有 nonce/container ID/PID/cwd/预写 handle 的生命周期并运行历史配置集成测试，不启动浏览器或生产 worker。数据库由 owned-fixture 精确所有权句柄创建/删除，容器核 label+ID 后删除并核验消失；失败保留 handle，不清邻居。测试的权限变化为受控 SQL；未声称生产身份库自然故障。测试不重新采集已接受的证明包。

真实数据库测试还直接执行唯一 formal writer 的存储方法，使用受控 collector 输出验证 normalized 样本与完整配置证明同事务提交/回滚及 exact sample IDs。这不是公开模板受理或模板租约门禁的端到端证据；未重新调用真实目标采集。legacy 禁用计划通过真实队列租约 handler 激活且无远程 IO。模板 host 的新增发布快照由既有 host 事务测试覆盖；本轮未重复 probe/trial/apply 的真实目标正向包。
