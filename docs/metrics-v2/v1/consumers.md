# 消费方与兼容边界 v1

所有路径为仓库相对路径。`inventory.json.references` 保留逐文件匹配行号及分类，作为下表的可复核补集。搜索包括固定旧字段、历史表、接口路径及服务方法；只排除测试和生成依赖，不以本表代替引用扫描。静态扫描不证明仓库外调用方不存在。

## 三条采集链与存储

|路径|读写形态|迁移边界|
|---|---|---|
|`apps/db-ops-api/src/metric-registry.ts`、`metric-database-service.ts`、`metric-template-service.ts`|定义以 target_type+id 识别；DB定义优先，预定义补缺；单位/aggregation/SQL/compute_expr/启停/interval|保留旧 target_type 身份；定义和观测类型分开。存储 SQL 覆盖不能自动得到 C 资格|
|`apps/db-ops-api/src/monitor-collector.ts`、`collector.ts`、`collection-scheduler.ts`、`collectors/registry.ts`|due metric → engine provider →固定列或 metrics_data JSON → metrics_history；失败隔离按实例/provider|保持 MAX-11/19 调度与部分成功；注册 db_types 不等于 provider 真支持。例如 dm 扩展有 provider 分支但不在 fallback registry|
|`apps/db-ops-api/src/database-service.ts`|GET实时查询是另一套按引擎执行的 SQL，非历史快照；字段比 registry 多|不能拿实时值替换同名历史值而忽略算法/首次baseline/过滤差异；Oracle 需保留超时/兼容|
|`apps/db-ops-api/src/metrics-database-service.ts`|latest历史行；固定列+JSON；按 registry aggregation 聚合历史|迁移旧列/JSON/空值/范围/排序/精度；旧 counter sum 只兼容读，不冒充正确 V2 rate|
|`apps/db-ops-api/src/server-collector.ts`、`server-metric-provider.ts`|SSH 按固定命令批次；filesystem+维度行 → server_metrics；另有进程证据|保留 mount/device/fs_type/interface/direction；旧 disk_usage_<mount> 不与新行双计|
|`apps/db-ops-api/src/network-devices/network-device-collector.ts`、`huawei-adapter.ts`、`huawei-mib-catalog.ts`|SNMP probe→状态；system GET/interface table→network_device_observations；接口 inventory|GET成本为1个逻辑批次（协议可能分包），table随接口数增长；64位counter精度/来源/方向/quality/reason必须保留；默认无厂商 OID|
|`apps/db-ops-api/src/collectors/custom-sql.provider.ts`|实际读取 singular `collection_sql`；registry 描述/存储是 plural `collection_sqls`，接口不一致|列为现状缺口，不宣称用户SQL通路已完整；后续包契约接入时处理，不在本项修复|

## 旧 API 覆盖清单

|接口|生产方|仓库内消费方|必须保持/迁移的合同|
|---|---|---|---|
|GET `/api/metrics/:instanceId`|server.ts → metricsDatabaseService.getRealtimeMetrics|通用旧入口；Agent 使用同服务而非HTTP|这是存储最新行，不是即时采集；recorded_at/固定列/metrics_data/null保留|
|GET `/api/database/instances/:id/metrics`|server.ts → databaseService.getRealtimeMetrics|`frontend/src/app/ui/views/instance-detail.ts` → instance-overview-tab / instance-metrics-tab|RT 引擎扩展字段、version、估算说明；不能按全局 registry 名字误认语义|
|GET `/api/database/instances/:id/metrics/history`|server.ts → getHistoricalMetricsWithRange|instance-detail.ts 趋势与概览；Agent 同服务|period/interval/metrics参数、time+metrics数组；按旧ID兼容，不能把新单位静默塞旧字段|
|GET `/api/servers/metrics/summary`|server.ts，server_metrics最新样本|`frontend/src/app/ui/views/servers-page.ts`|每个Server的metrics数组、时间、维度；disk聚合去重；不要用单个最新时间掩盖其他指标过期|
|GET `/api/servers/:id/metrics`|server.ts，server_metrics|server-detail.ts；生成的 server_tools.ts|metric_name/value/dimensions/recorded_at；维度完整|
|GET `/api/servers/:id/metrics/history`|server.ts，server_metrics|server-detail.ts → metric-chart|range、truncated、时间序列维度；UI当前用首序列时间轴，不能假设异步采样严格对齐|
|GET `/api/network-devices/:id/metrics`|network-device-routes.ts|network-device-detail.ts|metricId/value/quality/reason/source/dimensions/observedAt；接口流量与错误丢弃双向独立|
|GET `/api/network-devices/:id/interfaces`|network-device-routes.ts，network_device_interfaces|network-device-detail.ts|ifIndex/ifName/alias/speedBps；speed缺失不计算utilization|
|GET `/api/resources/:type/:id/observations`|resources/resource-routes.ts → observation-service.ts|统一资源/Agent诊断入口|instance仅固定白名单，server维度兼容读，network质量；不能声称已能查所有Extension|
|GET `/api/resources/metrics/summary`|resource-routes.ts → resource-diagnostic-service.ts|生成公共API契约/总量聚合消费者|分资源scope、resourceCount、observedAt、unknown/freshness过滤；同名不同引擎 qps 不能当统一吞吐|
|GET `/api/resources`、`/api/resources/overview`|resource-routes.ts / resource-diagnostic-service.ts|dashboard.ts、dashboard-model.ts；资源列表|旧核心指标与健康/支持度/可用性拆开；unsupported不能填0|
|GET `/api/metrics/registry`、`/:id`、`/db-types/:type` 与写接口|server.ts / metricDatabaseService|metric-registry.ts、instance-detail.ts、alerts.ts|旧ID/target_type/单位/阈值/采集开关保留；候选C不是现在已生效的定义|

路由完整实现见 `apps/db-ops-api/server.ts`、`src/resources/resource-routes.ts`、`src/network-devices/network-device-routes.ts`。生成合同在 `apps/db-ops-api/src/contracts/generate-public-api.ts`、`frontend/src/api/generated/public-api.ts`，客户端在 `frontend/src/api/index.ts`。外部/动态 URL 消费方需要后续兼容期访问日志核对，本项没有访问生产日志。

## 图表、告警、评分与 Agent

|领域|文件（API src 或 frontend src 下）|消费及迁移要求|
|---|---|---|
|DB详情/图表|`frontend/src/app/ui/views/instance-detail.ts`，`components/instance-overview-tab.ts`、`instance-metrics-tab.ts`、`metric-chart.ts`|registry驱动label/unit；直接字段或metrics_data；实时滚动小图与历史大图来源不同。新旧标签、单位、缺口与估算标记必须一致|
|Server图表|`frontend/src/app/ui/views/server-detail.ts`、`servers-page.ts`、`server-metric-utils.ts`|挂载点容量加权/legacy去重；网络counter不能画成bit/s；按维度单序列|
|网络详情|`frontend/src/app/ui/views/network-device-detail.ts`|设备标量及if_index/interface/direction匹配；quality与null显示；不合并错误/丢弃方向|
|DB告警|`apps/db-ops-api/src/alert-evaluator.ts`、`alert-engine.ts`、`alerts/compiled-rule.ts`、`alert-rule-template-service.ts`|metric_name固定列+JSON，阈值宏、持续/恢复窗口；health_score读实例状态；V2单位变化必须迁移规则阈值，旧counter阈值不能直接套rate|
|Server告警|`apps/db-ops-api/src/server-alert-evaluator.ts`|最新dimensional样本、registry metadata和模板；保存维度聚合规则，不盲目平均FS百分比|
|网络告警|`apps/db-ops-api/src/network-devices/network-device-alert-evaluator.ts`|observations+quality、接口状态/流量；维度身份与方向、stale/unknown不当恢复|
|评分|`apps/db-ops-api/src/database-service.ts`、`scoring-service.ts`、`scoring-config-service.ts`、`health-truth.ts`、`health-routes.ts`；`frontend/src/app/ui/views/health-score-tab.ts`|健康检查独立SQL，availability/performance/capacity/security权重；无可用性证据不能健康。score不是metrics_history普通采样，必须保存算法/权重revision|
|Agent直接指标工具|`apps/db-ops-api/src/tools/ops/query_metrics.ts`|默认8项旧ID；regex只允许下划线，点分V2 ID需后续契约适配；realtime为存储latest，history附registry定义+摘要并抽样最多200点；不能把counter avg解释为新增事件|
|Agent资源诊断|`apps/db-ops-api/src/resources/resource-diagnostic-service.ts`、`tools/resource-tools.ts`、`instance-diagnostic-context-service.ts`、`server-diagnostic-service.ts`|固定core快照/存储直查与诊断上下文；需可发现Extension并携带单位、版本、来源/质量，不仅凭文字工具描述|
|Agent生成工具/提示|`apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts`、`tools/security-catalog.ts`、`skills/generated/check_health/tools.ts`、`prompts/versions/alert-rca-v1.md`、`alert-rca-service.ts`|工具目录/生成契约/提示可能含旧ID；重生成应来自源，不手改生成产物；描述中的“活跃连接/CPU”不能覆盖真实口径|
|Agent摘要与桥接|`apps/db-ops-api/src/tools/ops/get_instance_summary.ts`、`ai-agent-bridge.ts`|实例摘要包含health_score，桥接向Agent提供状态；同样需要区分不可用、零和估算|
|实例列表/主机证据|`frontend/src/app/ui/views/instances-db.ts`、`components/instance-host-summary.ts`；`apps/db-ops-api/src/linux-host-evidence-service.ts`|列表读持久化健康/容量，主机证据有独立df/SSH采样；保留逻辑数据库空间与物理文件/文件系统占用区别|
|报告与基线|`apps/db-ops-api/src/report-service.ts`、`server-report-service.ts`、`baseline-calculator.ts`、`capacity-predictor.ts`、`consistency-checker.ts`|历史聚合、容量预测、基线与一致性检查；数据大小换单位后阈值/模型要带版本，不把不同scope历史拼接|

## 后续实施的阻断项，不属于本项代码修复

- MAX-64 冻结 type/unit/scope/version/quality，以及旧ID兼容策略；未识别的自定义指标保留E，不猜。
- MAX-65/68 保护旧 API 和历史查询：仅证据充足时映射，禁止把旧占位/回退/精度损失标成精确good。
- MAX-66/67 公共counter与包必须区分raw累计量/已经derived的rate；保留重启/缺口/计数器源切换原因。
- MAX-71/72/73 只接代表集；MAX-75 统一UI、告警、评分与Agent解读。这里记录的旧问题不作为 MAX-63 等待下游的理由。
