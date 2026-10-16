# 统一指标后端契约（MAX-189）

基于 2026-10-16 R2，API 根路径为 `/api/metrics`。前端归 MAX-190；后端不修改前端手写文件。原配置、策略、消费者接口的请求和响应保持结构，改为中性根路径。包的语义版本、digest、revision、raw lineage 不变。

## 单资源流程

- `GET /config/resources/:type/:id/recommendations`：`{resource, evaluated_at, packages}`；每项为 `{release, compatibility, recommended, checks, coverage, missing_core_metrics}`。compatibility 为 compatible / incompatible / unknown；未知能力不得伪称支持。只返回同资源类型包，按真实引擎、版本、协议检查。
- `GET /config/resources/:type/:id/status`：返回 `MetricConfigurationStatus`，结构见后端 `src/contracts/metrics/configuration-status.ts`，以下五层相互独立。
- `POST /config/resources/:type/:id/activate`：请求同 policy binding change（expected_revision、可选 package/group_id/overrides）；执行权限、预检、有界试采、CAS 发布，返回 `{published, resources, affected_resources, requests_per_hour_before, requests_per_hour_after, status}`。试采至少有一项 succeeded/partial 尝试且有真实 good 样本才可发布；部分能力未知不会伪称全覆盖，无有效样本不发布，409 不重试。正式来源验证由持久调度继续，状态接口观察；全局关闭保持明确阻塞。
- `GET /policy/groups?query=...`：返回 `{groups:[{id,revision,overrides,can_manage}]}`，只列当前身份可读取的组；无成员的组仅管理员可见，最多 100 项。

## 状态语义

`contract_version: '1.0.0'`、resource、evaluated_at、can_manage；五层为：

1. binding：state=bound/unbound，package（可空），published_revision/applied_revision（可空），application=pending/applied/failed/unbound。
2. effective_enabled：enabled、global_enabled、asset_enabled、policy_enabled，以及 source=global/asset/platform/package/group/resource/unbound。资产停用优先于策略；全局关闭不更改资产配置。
3. collection：state=disabled/pending/running/succeeded/failed/unknown；last_attempt_at、last_success_at（无真实证据则 null），in_flight。
4. formal_visibility：state=unbound/pending/validating/available/failed；source=none/semantic，last_observed_at，generation，freshness=fresh/stale/unknown；applied 不代表 available。
5. coverage：每项 metric（id+semantic_version）、state=covered/not_covered/unsupported/unknown/disabled、reason。核心列缺口属于单指标覆盖，不能推导资源未绑定。

`blockers` 为稳定代码数组：UNBOUND、GLOBAL_COLLECTION_DISABLED、ASSET_COLLECTION_DISABLED、POLICY_COLLECTION_DISABLED、APPLICATION_PENDING、APPLICATION_FAILED、PACKAGE_INCOMPATIBLE、CAPABILITY_UNKNOWN、COLLECTION_FAILED、SOURCE_VALIDATION_PENDING、SOURCE_VALIDATION_FAILED、AWAITING_SAMPLE、STALE_SAMPLE。失败或无权时返回 HTTP 错误，不能返回 unbound。

## 文件、持久化与兼容边界

`src/metrics-v2` → `src/metrics`；`src/contracts/metrics-v2` → `src/contracts/metrics`；`metric_v2_*` → `metric_*`。历史 SQL migration 不改 checksum；新增迁移检测新旧重名，原子 RENAME，不 drop/复制用户表，备份和回退另有操作证据。原 API 只允许有期限的路由转发，退出条件为 MAX-190 集成及调用方引用清零；不能继续第二采集器或读写实现。

原 monitor/server/network 周期入口停止独立调度，手动动作保留明确诊断语义。原指标和策略通过显式能力映射迁移；单位、维度、epoch 或口径无已证明等价项维持 unknown/待复核。已冻结的 mysql-basic@2.0.0 仍仅 uptime；MySQL9.6 的额外原生能力由新 mysql-diagnostics@1.0.0 包提供，不改旧包 digest，也不虚报容量分母。部分 collector 失败或 epoch 未知可以与其他正式 good 指标可见同时存在，五层状态分别报告，不用历史成功掩盖当前失败。

## 兼容配置迁移补充（Chief预审后）

status新增可选 `legacy_configuration`，每项含kind/source_id/source_digest/state/code/package/actions；资源管理者可读，普通只读用户不返回管理详情。未审核旧配置/宏返回 `LEGACY_CONFIGURATION_REVIEW_REQUIRED`，它表示迁移工作未完成，不会冒充正式来源/成功采样，也不启动历史执行器。

GET `/api/metrics/config/resources/:type/:id/migration` 需要实时资源管理权限，返回相同items，不返回SQL或凭据、不触发远端采集。reviewed仅表示不可变SQL条目已审核，code仍为 `CUSTOM_SQL_ACTIVATION_REQUIRED`；其后须使用现有trial/activate精确pin、CAS和来源门禁。未审核、不安全SQL、表达式和废弃模板宏分别使用专项兼容记录中的稳定码与操作步骤。公开schema及OpenAPI已同步，前端手写展示继续归MAX-190。
